/**
 * MIDI 文件解析器 (Standard MIDI File format 0/1)
 * 用于将外部 .mid 文件解析转换为单旋律简谱 Score
 */
import type { Notation, Score } from "./model.ts";
import { createBar, createNote, createScore, EXTEND } from "./model.ts";
import { toneToMidiBase } from "./player.ts";

export interface ParsedMidiNote {
  midi: number;
  startTick: number;
  durationTick: number;
}

export interface ParsedMidi {
  tempoBpm: number;
  division: number; // ticks per beat
  timeSignature: [number, number];
  notes: ParsedMidiNote[];
}

/** 解析 Standard MIDI 文件数据流 */
export function parseMidiBytes(bytes: Uint8Array): ParsedMidi {
  let offset = 0;
  const readUint32 = () => {
    const v = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    return v;
  };
  const readUint16 = () => {
    const v = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    return v;
  };
  const readVarint = () => {
    let v = 0;
    while (offset < bytes.length) {
      const b = bytes[offset++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  };

  // Header chunk: "MThd" (4 bytes)
  const magic = String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (magic !== "MThd") throw new Error("无效的 MIDI 文件：缺少 MThd 头标记");
  offset += 4;
  const headerLen = readUint32();
  readUint16(); // format 0/1/2
  const numTracks = readUint16();
  const division = readUint16();
  offset += headerLen - 6; // 跳过头块剩余（通常正好 6 字节）

  let tempoBpm = 120;
  let timeSignature: [number, number] = [4, 4];
  const allNotes: ParsedMidiNote[] = [];

  // 逐轨解析
  for (let trk = 0; trk < numTracks; trk++) {
    if (offset >= bytes.length) break;
    const trkMagic = String.fromCharCode(...bytes.slice(offset, offset + 4));
    offset += 4;
    const trkLen = readUint32();
    const trkEnd = offset + trkLen;
    if (trkMagic !== "MTrk") {
      offset = trkEnd;
      continue;
    }

    let curTick = 0;
    let runningStatus = 0;
    const activeNoteOns = new Map<number, number>(); // midi -> startTick

    while (offset < trkEnd && offset < bytes.length) {
      const delta = readVarint();
      curTick += delta;
      let status = bytes[offset];
      if (status >= 0x80) {
        runningStatus = status;
        offset += 1;
      } else {
        status = runningStatus;
      }

      if (status === 0xff) {
        // Meta event
        const metaType = bytes[offset++];
        const metaLen = readVarint();
        if (metaType === 0x51 && metaLen === 3) {
          // Set tempo: us per beat
          const us = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
          if (us > 0) tempoBpm = Math.round(60_000_000 / us);
        } else if (metaType === 0x58 && metaLen >= 2) {
          // Time signature: num, denExp
          const num = bytes[offset];
          const den = 2 ** bytes[offset + 1];
          timeSignature = [num, den];
        }
        offset += metaLen;
      } else if (status === 0xf0 || status === 0xf7) {
        // SysEx
        const sysLen = readVarint();
        offset += sysLen;
      } else {
        const msgType = status & 0xf0;
        if (msgType === 0x90) {
          const note = bytes[offset++];
          const vel = bytes[offset++];
          if (vel > 0) {
            activeNoteOns.set(note, curTick);
          } else {
            // Velocity 0 == Note Off
            const start = activeNoteOns.get(note);
            if (start !== undefined) {
              allNotes.push({ midi: note, startTick: start, durationTick: Math.max(1, curTick - start) });
              activeNoteOns.delete(note);
            }
          }
        } else if (msgType === 0x80) {
          const note = bytes[offset++];
          offset++; // skip velocity
          const start = activeNoteOns.get(note);
          if (start !== undefined) {
            allNotes.push({ midi: note, startTick: start, durationTick: Math.max(1, curTick - start) });
            activeNoteOns.delete(note);
          }
        } else if (msgType === 0xc0 || msgType === 0xd0) {
          offset += 1;
        } else {
          offset += 2;
        }
      }
    }
    offset = trkEnd;
  }

  // 排序
  allNotes.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi);
  return { tempoBpm, division, timeSignature, notes: allNotes };
}

/** 对应 C 调首调音级：半音偏移 -> [唱名数字, 是否升号] */
const SEMITONE_TO_JIANPU: Record<number, [string, boolean]> = {
  0: ["1", false],
  1: ["1", true],
  2: ["2", false],
  3: ["2", true],
  4: ["3", false],
  5: ["4", false],
  6: ["4", true],
  7: ["5", false],
  8: ["5", true],
  9: ["6", false],
  10: ["6", true],
  11: ["7", false],
};

/** 把解析后的 MIDI 音符流自动量化转换为简谱 Score */
export function midiToScore(parsed: ParsedMidi, options: { title?: string; tone?: string } = {}): Score {
  const tone = options.tone || "C";
  const midiBase = toneToMidiBase(tone); // do 对应的绝对 midi
  const tpq = parsed.division || 480;
  const speed = Math.max(20, Math.min(240, parsed.tempoBpm || 75));
  const [num, den] = parsed.timeSignature || [4, 4];

  // 量化为拍数：将 tick 换算为以 1/4 拍为基准的倍数 (最小支持十六分音符 0.25 拍)
  const quantizeBeats = (ticks: number) => {
    const rawBeats = ticks / tpq;
    // 四舍五入到最近的 0.25 (十六分音符) 或 1/3 (三连音)
    const q16 = Math.round(rawBeats * 4) / 4;
    return q16 <= 0 ? 0.25 : q16;
  };

  const notations: Notation[] = [];
  let curTick = 0;

  for (const n of parsed.notes) {
    // 检查是否有前置休止时值
    if (n.startTick > curTick + tpq * 0.125) {
      const restBeats = quantizeBeats(n.startTick - curTick);
      // 休止符
      let remaining = restBeats;
      while (remaining >= 1) {
        notations.push(createNote({ note: "0", underline: 0, beatFrac: 1 }));
        remaining -= 1;
      }
      if (remaining >= 0.5) {
        notations.push(createNote({ note: "0", underline: 1, beatFrac: 0.5 }));
        remaining -= 0.5;
      }
      if (remaining >= 0.25) {
        notations.push(createNote({ note: "0", underline: 2, beatFrac: 0.25 }));
      }
    }

    // 音高换算为简谱数字与八度
    const semitonesFromBase = n.midi - midiBase;
    const octave = Math.floor(semitonesFromBase / 12);
    const mod = ((semitonesFromBase % 12) + 12) % 12;
    const [digit, isSharp] = SEMITONE_TO_JIANPU[mod] || ["1", false];

    const durBeats = quantizeBeats(n.durationTick);

    // 时值转为音符 + 减时线 或 延音线
    if (durBeats <= 0.25) {
      notations.push(createNote({
        note: digit as any,
        octave,
        underline: 2,
        beatFrac: 0.25,
        prefixAccidentals: isSharp ? ["♯"] : [],
      }));
    } else if (durBeats <= 0.5) {
      notations.push(createNote({
        note: digit as any,
        octave,
        underline: 1,
        beatFrac: 0.5,
        prefixAccidentals: isSharp ? ["♯"] : [],
      }));
    } else if (durBeats <= 0.75) {
      // 附点八分
      notations.push(createNote({
        note: digit as any,
        octave,
        underline: 1,
        dotted: true,
        beatFrac: 0.75,
        prefixAccidentals: isSharp ? ["♯"] : [],
      }));
    } else if (durBeats <= 1.25) {
      // 一拍
      notations.push(createNote({
        note: digit as any,
        octave,
        underline: 0,
        beatFrac: 1,
        prefixAccidentals: isSharp ? ["♯"] : [],
      }));
    } else {
      // 多拍：单音符 + 延音线 ─
      notations.push(createNote({
        note: digit as any,
        octave,
        underline: 0,
        beatFrac: 1,
        prefixAccidentals: isSharp ? ["♯"] : [],
      }));
      const extraBeats = Math.round(durBeats - 1);
      for (let e = 0; e < extraBeats; e++) {
        notations.push(createNote({ note: EXTEND, underline: 0, beatFrac: 1 }));
      }
    }

    curTick = n.startTick + n.durationTick;
  }

  // 按拍号组织小节线
  const beatsPerBar = num;
  const partitionedNotations: Notation[] = [];
  let barBeats = 0;

  for (const n of notations) {
    const b = n.note === EXTEND ? 1 : (n.beatFrac || 1);
    partitionedNotations.push(n);
    barBeats += b;
    if (barBeats >= beatsPerBar - 1e-4) {
      partitionedNotations.push(createBar());
      barBeats = 0;
    }
  }
  // 尾部加终止双线
  if (partitionedNotations.length && partitionedNotations[partitionedNotations.length - 1].note !== "‖") {
    partitionedNotations.push(createBar("‖"));
  }

  return createScore({
    title: options.title || "导入的 MIDI 乐谱",
    tone,
    beat: [num, den],
    speed,
    authors: ["MIDI 自动逆向转谱", "简谱编辑器"],
    paragraphs: [{
      key: `p_${Math.random().toString(36).slice(2, 9)}`,
      notations: partitionedNotations,
      alignJustify: true,
      lyrics: [],
    }],
  });
}
