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
  /** 所属段落号（跨段高亮定位） */
  paragraph: number;
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

/** 把整份乐谱编译成播放事件流 */
export function compileEvents(score: Score): PlayEvent[] {
  const events: PlayEvent[] = [];
  const secPerBeat = beatSeconds(score.speed);
  const midiBase = toneToMidiBase(score.tone);
  let t = 0;
  score.paragraphs.forEach((para, paraIdx) => {
    para.notations.forEach((n, idx) => {
      if (isPitchable(n)) {
        const acc = (n.prefixAccidentals || []).reduce((a, x) => a + (x === "♯" ? 1 : -1), 0);
        const midi = midiBase + DIGIT_TO_LEVEL[n.note] + acc + 12 * n.octave;
        events.push({ start: t, duration: noteBeats(n) * secPerBeat * 0.92, midi, index: idx, paragraph: paraIdx });
        t += noteBeats(n) * secPerBeat;
      } else if (n.note === EXTEND) {
        // 延音线无声，只推进时间（自成一拍，或继承前一音 beatFrac 语义——延音线 beatFrac 恒 1）
        t += noteBeats(n) * secPerBeat;
      }
      // 小节线不占时值
    });
  });
  return events;
}

/** 播放器状态回调 */
export interface PlayerCallbacks {
  /** 每个音符发声时回调（符号下标、段落号） */
  onNote?: (index: number, paragraph: number) => void;
  /** 回放结束 */
  onEnd?: () => void;
}

/** 简单正弦+泛音合成器（零依赖，音色柔和接近人声哼唱） */
export class Player {
  private ctx: AudioContext | null = null;
  private stopFlag = false;
  /** play() 调用到结束之间的窗口（playing 的真值来源，与按钮 toggle 态一致） */
  private active = false;
  private timers: number[] = [];

  /** 播放事件流 */
  play(events: PlayEvent[], cb: PlayerCallbacks = {}): void {
    this.stop();
    this.stopFlag = false;
    this.active = true;
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    void ctx.resume();
    const t0 = ctx.currentTime + 0.05;
    for (const ev of events) {
      if (ev.midi === null) continue;
      const at = t0 + ev.start;
      // 高亮定时
      const delayMs = Math.max(0, (at - ctx.currentTime) * 1000);
      this.timers.push(
        window.setTimeout(() => {
          if (!this.stopFlag) cb.onNote?.(ev.index, ev.paragraph);
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
      // 快速淡出避免爆音
      void this.ctx.suspend().then(() => {
        void this.ctx!.resume();
      });
      this.ctx.close();
      this.ctx = null;
    }
  }

  get playing(): boolean {
    return this.active;
  }
}
