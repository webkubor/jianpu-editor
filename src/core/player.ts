/**
 * Web Audio 回放引擎：把 Notation[] 合成唱名音高
 * 原理：简谱首调 → 固定音高需要调号中心频率；唱名音级 + 12*八度 → 半音偏移，
 * 频率 = 440 * 2^((midi-69)/12)。每个 sounding 符号按基准时值（speed bpm）发声。
 */

import { EXTEND, isPitchable } from "./model.ts";
import type { Notation, Score } from "./model.ts";

/** 唱名 → 半音级（同 transpose 表，独立声明避免循环依赖） */
const DIGIT_TO_LEVEL: Record<string, number> = { "1": 0, "2": 2, "3": 4, "4": 5, "5": 7, "6": 9, "7": 11 };

/** 调号 → 该调 do 的 MIDI 号（以 C4=60 为基准域，随调号平移） */
export function toneToMidiBase(tone: string): number {
  const m = tone.match(/^([#♯b♭]?)([A-G])$/);
  const letter = m ? m[2] : "C";
  const adj = m && (m[1] === "#" || m[1] === "♯") ? 1 : m && (m[1] === "b" || m[1] === "♭") ? -1 : 0;
  const base: Record<string, number> = { C: 60, D: 62, E: 64, F: 65, G: 67, A: 69, B: 71 };
  return base[letter] + adj;
}

/** 演奏事件：何时响、响多久、什么频率 */
export interface PlayEvent {
  /** 起始时间（秒，相对回放起点） */
  start: number;
  /** 时长（秒） */
  duration: number;
  /** MIDI 音高；休止符为 null */
  midi: number | null;
  /** 对应符号在段落扁平序列中的下标（用于回放高亮） */
  index: number;
  /** 所属段落号（跨段高亮定位） */
  paragraph: number;
}

/** 把演奏事件序列转为单轨 MIDI（format 0）。速度取自乐谱，音色用大钢琴（program 0）。 */
export function toMidi(events: PlayEvent[], speed: number): Uint8Array {
  const TPQ = 480; // 每四分音符 tick 数
  const usPerBeat = Math.round(60_000_000 / Math.max(1, speed));
  const toTick = (sec: number) => Math.round((sec / 60) * speed * TPQ);

  // MIDI 数据流：varint 长度前缀 + 消息
  const bytes: number[] = [];
  const pushVarint = (v: number) => {
    const seq = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      seq.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    bytes.push(...seq);
  };
  const pushMessage = (deltaTick: number, ...data: number[]) => {
    pushVarint(Math.max(0, deltaTick));
    bytes.push(...data);
  };

  // 音符开/关合并排序，保证 delta 单调
  type Note = { onTick: number; offTick: number; midi: number };
  const notes: Note[] = [];
  for (const ev of events) {
    if (ev.midi === null || ev.duration <= 0) continue;
    const onTick = toTick(ev.start);
    const offTick = Math.max(onTick + 1, toTick(ev.start + ev.duration));
    notes.push({ onTick, offTick, midi: ev.midi });
  }
  notes.sort((a, b) => a.onTick - b.onTick || a.offTick - b.offTick);

  // 事件流：注意同 tick 上先 off 再 on（避免同音截断）
  type Msg = { tick: number; order: number; data: number[] };
  const msgs: Msg[] = [];
  msgs.push({ tick: 0, order: 0, data: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff] }); // set tempo
  for (const n of notes) {
    msgs.push({ tick: n.offTick, order: 1, data: [0x80, n.midi, 0x40] });
    msgs.push({ tick: n.onTick, order: 0, data: [0x90, n.midi, 0x64] });
  }
  const endTick = notes.reduce((m, n) => Math.max(m, n.offTick), 0);
  msgs.push({ tick: endTick, order: 2, data: [0xff, 0x2f, 0x00] }); // end of track
  msgs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  let last = 0;
  for (const m of msgs) {
    pushMessage(m.tick - last, ...m.data);
    last = m.tick;
  }

  // 头块 format 0 / 单轨 / TPQ
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff];
  const trackLen = bytes.length;
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff];
  return new Uint8Array([...header, ...trackHeader, ...bytes]);
}

/** 时值计算：一拍的秒数 */
export function beatSeconds(speed: number): number {
  return 60 / Math.max(1, speed);
}

/**
 * 一个符号的时值（以拍为单位）：
 * 优先 beatFrac（组内 n 音平分一拍的真实时值，三连音 1/3）；缺省回退 1/2^underline 折算；附点 ×1.5。
 */
export function noteBeats(n: { underline: number; dotted: boolean; beatFrac?: number }): number {
  let beats = n.beatFrac ?? 1 / 2 ** Math.max(0, Math.min(3, n.underline));
  if (n.dotted) beats *= 1.5;
  return beats;
}

/** 把整份乐谱编译成播放事件流；休止符保留时长与光标位置，midi 为 null。同音高连音线合并为一个持续音。 */
export function compileEvents(score: Score): PlayEvent[] {
  const events: PlayEvent[] = [];
  const secPerBeat = beatSeconds(score.speed);
  const midiBase = toneToMidiBase(score.tone);
  let t = 0;
  score.paragraphs.forEach((para, paraIdx) => {
    // 已被前面连音合并的符号不再发声（光标事件已在合并时补发）
    const merged = new Set<Notation>();
    para.notations.forEach((n, idx) => {
      if (merged.has(n)) return;
      if (n.note === "0") {
        // 静音事件保留尾部休止时长，并让播放光标经过休止符。
        const duration = noteBeats(n) * secPerBeat;
        events.push({ start: t, duration, midi: null, index: idx, paragraph: paraIdx });
        t += duration;
      } else if (isPitchable(n)) {
        const acc = (n.prefixAccidentals || []).reduce((a, x) => a + (x === "♯" ? 1 : -1), 0);
        const midi = midiBase + DIGIT_TO_LEVEL[n.note] + acc + 12 * n.octave;
        // 连音线合并：沿 tieTo 追踪同音高后继（音符或延音线），时长累加到本音，后继只推进时间
        let beats = noteBeats(n);
        let cursor: Notation | undefined = n;
        const consumed: Notation[] = [];
        while (cursor?.tieTo) {
          const nextIdx = para.notations.findIndex(o => o.key === cursor!.tieTo);
          const next = nextIdx > idx ? para.notations[nextIdx] : undefined;
          if (!next) break;
          if (isPitchable(next)) {
            if (midiOf(score.tone, next) !== midi) break;
          } else if (next.note !== EXTEND) break;
          consumed.push(next);
          merged.add(next);
          beats += noteBeats(next);
          cursor = next;
        }
        // 演奏法修饰时值系数：顿音/跳音(▾)短促发声(约40%)；保持音(⌒)饱满发声(约98%)；延长音(𝄐)自然延续
        let durFactor = 0.92;
        if (n.topDecorators && n.topDecorators.length > 0) {
          if (n.topDecorators.includes("▾")) durFactor = 0.45;
          else if (n.topDecorators.includes("⌒")) durFactor = 0.98;
        }
        events.push({ start: t, duration: beats * secPerBeat * durFactor, midi, index: idx, paragraph: paraIdx });
        t += beats * secPerBeat;
        // 被合并的连音后继不发新音，但保留光标经过的位置
        for (const used of consumed) {
          const usedIdx = para.notations.indexOf(used);
          events.push({ start: t, duration: 0, midi: null, index: usedIdx, paragraph: paraIdx });
        }
      } else if (n.note === EXTEND) {
        // 延音线无声，只推进时间（自成一拍，或继承前一音 beatFrac 语义——延音线 beatFrac 恒 1）
        t += noteBeats(n) * secPerBeat;
      }
      // 小节线不占时值
    });
  });
  return events;
}

/** 单符号音高换算（对外导出，供即时试听与连音线同音高判定用） */
export function midiOf(tone: string, n: Notation): number {
  const acc = (n.prefixAccidentals || []).reduce((a, x) => a + (x === "♯" ? 1 : -1), 0);
  return toneToMidiBase(tone) + DIGIT_TO_LEVEL[n.note] + acc + 12 * n.octave;
}

/** 光标处播放：返回某段某符号下标之前的总时值（秒），作为播放起点 offset。 */
export function timeBefore(score: Score, paragraph: number, itemIndex: number): number {
  const secPerBeat = beatSeconds(score.speed);
  let t = 0;
  for (let p = 0; p < paragraph && p < score.paragraphs.length; p += 1) {
    for (const n of score.paragraphs[p].notations) t += noteBeats(n) * secPerBeat;
  }
  const para = score.paragraphs[paragraph];
  if (!para) return t;
  for (let i = 0; i < itemIndex && i < para.notations.length; i += 1) {
    t += noteBeats(para.notations[i]) * secPerBeat;
  }
  return t;
}

/** 播放器状态回调 */
export interface PlayerCallbacks {
  /** 每个音符发声时回调（符号下标、段落号） */
  onNote?: (index: number, paragraph: number) => void;
  /** 回放结束 */
  onEnd?: () => void;
  /** 节拍器滴答回调（当前是小节内第几拍：0 为首拍强拍） */
  onBeat?: (beatInBar: number) => void;
}

export interface PlayOptions {
  /** 是否开启节拍器伴奏音（强拍高音，弱拍短木鱼音） */
  metronome?: boolean;
  /** 节拍参数：[每小节拍数, 拍基数] 如 [4, 4] 或 [3, 4] */
  beat?: [number, number];
  /** 乐谱速度 BPM */
  speed?: number;
}

/** 简单正弦+泛音合成器（零依赖，音色柔和接近人声哼唱） */
export class Player {
  private ctx: AudioContext | null = null;
  private stopFlag = false;
  /** play() 调用到结束之间的窗口（playing 的真值来源，与按钮 toggle 态一致） */
  private active = false;
  private timers: number[] = [];

  /** 播放事件流，支持可选伴奏节拍器 */
  play(events: PlayEvent[], cb: PlayerCallbacks = {}, options: PlayOptions = {}): void {
    this.stop();
    this.stopFlag = false;
    this.active = true;
    try {
      if (!this.ctx && typeof AudioContext !== "undefined") this.ctx = new AudioContext();
    } catch {
      // 纯测试/无音频硬件环境安全降级
    }
    const ctx = this.ctx;
    if (!ctx) return;
    void ctx.resume();
    const t0 = ctx.currentTime + 0.05;
    for (const ev of events) {
      const at = t0 + ev.start;
      // 高亮定时
      const delayMs = Math.max(0, (at - ctx.currentTime) * 1000);
      this.timers.push(
        window.setTimeout(() => {
          if (!this.stopFlag) cb.onNote?.(ev.index, ev.paragraph);
        }, delayMs)
      );
      if (ev.midi === null) continue;
      // 音色：基频 + 2次泛音（音量 0.12/0.04）+ 短Attack/Release
      const freq = 440 * 2 ** ((ev.midi - 69) / 12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.14, at + 0.02);
      gain.gain.setValueAtTime(0.14, at + ev.duration * 0.7);
      gain.gain.linearRampToValueAtTime(0.0001, at + ev.duration);
      gain.connect(ctx.destination);
      for (const [mult, vol] of [[1, 1], [2, 0.3], [3, 0.12]] as const) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq * mult;
        const og = ctx.createGain();
        og.gain.value = vol;
        osc.connect(og).connect(gain);
        osc.start(at);
        osc.stop(at + ev.duration + 0.02);
      }
    }

    // 节拍器伴奏：按 speed 与 beat[0] 节拍循环打点（强拍 1000Hz 清脆滴声，次拍 700Hz 弱嗒声）
    if (options.metronome && events.length > 0) {
      const beatsPerBar = options.beat ? options.beat[0] : 4;
      const speed = options.speed || 75;
      const secPerBeat = beatSeconds(speed);
      const totalDur = events[events.length - 1].start + events[events.length - 1].duration;
      let beatCount = 0;
      for (let bt = 0; bt <= totalDur + 1e-4; bt += secPerBeat) {
        const at = t0 + bt;
        const beatInBar = beatCount % beatsPerBar;
        const isDownbeat = beatInBar === 0;
        const delayMs = Math.max(0, (at - ctx.currentTime) * 1000);
        this.timers.push(
          window.setTimeout(() => {
            if (!this.stopFlag) cb.onBeat?.(beatInBar);
          }, delayMs)
        );

        // 真实节拍发声
        const freq = isDownbeat ? 1040 : 780;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(isDownbeat ? 0.08 : 0.045, at + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
        gain.connect(ctx.destination);

        const osc = ctx.createOscillator();
        osc.type = isDownbeat ? "triangle" : "sine";
        osc.frequency.setValueAtTime(freq, at);
        osc.connect(gain);
        osc.start(at);
        osc.stop(at + 0.07);

        beatCount += 1;
      }
    }

    const totalMs = (events.length ? events[events.length - 1].start + events[events.length - 1].duration : 0) * 1000 + 300;
    this.timers.push(
      window.setTimeout(() => {
        this.active = false;
        if (!this.stopFlag) cb.onEnd?.();
      }, totalMs)
    );
  }

  /** 立即停止 */
  stop(): void {
    this.stopFlag = true;
    this.active = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close();
    }
  }

  get playing(): boolean {
    return this.active;
  }

  /** 单音即时试听（输入/改八度/改升降号时触发轻量反馈，不影响全谱播放状态） */
  playTone(midi: number, durationSec = 0.22): void {
    if (this.active) return; // 正在全谱回放时不冲突抢占
    try {
      if (!this.ctx || this.ctx.state === "closed") {
        this.ctx = new AudioContext();
      }
      const ctx = this.ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const at = ctx.currentTime + 0.01;
      const freq = 440 * 2 ** ((midi - 69) / 12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.015);
      gain.gain.setValueAtTime(0.12, at + durationSec * 0.7);
      gain.gain.linearRampToValueAtTime(0.0001, at + durationSec);
      gain.connect(ctx.destination);
      for (const [mult, vol] of [[1, 1], [2, 0.28], [3, 0.1]] as const) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq * mult;
        const og = ctx.createGain();
        og.gain.value = vol;
        osc.connect(og).connect(gain);
        osc.start(at);
        osc.stop(at + durationSec + 0.02);
      }
    } catch {
      // 浏览器未交互前受安全限制静默跳过
    }
  }
}
