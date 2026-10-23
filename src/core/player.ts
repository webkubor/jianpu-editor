/**
 * Web Audio 回放引擎：把 Notation[] 合成唱名音高
 * 原理：简谱首调 → 固定音高需要调号中心频率；唱名音级 + 12*八度 → 半音偏移，
 * 频率 = 440 * 2^((midi-69)/12)。每个 sounding 符号按基准时值（speed bpm）发声。
 */

import { EXTEND, isPitchable } from "./model.ts";
import type { Score } from "./model.ts";

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
}

/** 时值计算：一拍的秒数 */
export function beatSeconds(speed: number): number {
  return 60 / Math.max(1, speed);
}

/**
 * 一个音符的时值（以拍为单位）：
 * underline 条减时线 → 基础 1/2^underline 拍；附点 ×1.5。
 */
export function noteBeats(n: { underline: number; dotted: boolean }): number {
  let beats = 1 / 2 ** Math.max(0, Math.min(3, n.underline));
  if (n.dotted) beats *= 1.5;
  return beats;
}

/** 把整份乐谱编译成播放事件流 */
export function compileEvents(score: Score): PlayEvent[] {
  const events: PlayEvent[] = [];
  const secPerBeat = beatSeconds(score.speed);
  const midiBase = toneToMidiBase(score.tone);
  let t = 0;
  let idx = 0;
  for (const para of score.paragraphs) {
    for (const n of para.notations) {
      if (isPitchable(n)) {
        const acc = (n.prefixAccidentals || []).reduce((a, x) => a + (x === "♯" ? 1 : -1), 0);
        const midi = midiBase + DIGIT_TO_LEVEL[n.note] + acc + 12 * n.octave;
        events.push({ start: t, duration: noteBeats(n) * secPerBeat * 0.92, midi, index: idx });
        t += noteBeats(n) * secPerBeat;
      } else if (n.note === EXTEND) {
        // 延音线无声，只推进时间（时值 = 前一音符号基础拍）
        t += secPerBeat / 2 ** Math.max(0, Math.min(3, n.underline));
      }
      // 小节线不占时值
      idx += 1;
    }
  }
  return events;
}

/** 播放器状态回调 */
export interface PlayerCallbacks {
  /** 每个音符发声时回调（下标） */
  onNote?: (index: number) => void;
  /** 回放结束 */
  onEnd?: () => void;
}

/** 简单正弦+泛音合成器（零依赖，音色柔和接近人声哼唱） */
export class Player {
  private ctx: AudioContext | null = null;
  private stopFlag = false;
  private timers: number[] = [];

  /** 播放事件流 */
  play(events: PlayEvent[], cb: PlayerCallbacks = {}): void {
    this.stop();
    this.stopFlag = false;
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    for (const ev of events) {
      if (ev.midi === null) continue;
      const at = t0 + ev.start;
      // 高亮定时
      const delayMs = Math.max(0, (at - ctx.currentTime) * 1000);
      this.timers.push(
        window.setTimeout(() => {
          if (!this.stopFlag) cb.onNote?.(ev.index);
        }, delayMs)
      );
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
    const totalMs = (events.length ? events[events.length - 1].start + events[events.length - 1].duration : 0) * 1000 + 300;
    this.timers.push(
      window.setTimeout(() => {
        if (!this.stopFlag) cb.onEnd?.();
      }, totalMs)
    );
  }

  /** 立即停止 */
  stop(): void {
    this.stopFlag = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ctx) {
      // 快速淡出避免爆音
      void this.ctx.suspend().then(() => {
        void this.ctx!.resume();
      });
      this.ctx.close();
      this.ctx = null;
    }
  }

  get playing(): boolean {
    return !this.stopFlag;
  }
}
