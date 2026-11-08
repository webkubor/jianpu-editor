/**
 * 转调模块
 * 原理（参考 numerical-notation-editor 的 tone-convert 后独立实现）：
 * 简谱是首调记谱，转调 = 全体音符的音级（semitone level）平移。
 * 音级映射：1=C(0) 2=D(2) 3=E(4) 4=F(5) 5=G(7) 6=A(9) 7=B(11)。
 * 平移后落不在白键上的音级，用 ♯/♭ 前缀表示（惯用记法：1♯ 2♯ 4♯ 5♯ 6♯，3♭ 7♭ 取 ♭）。
 */

import { isPitchable } from "./model.ts";
import type { NoteSymbol, Score } from "./model.ts";

/** 唱名 → 半音级 */
const DIGIT_TO_LEVEL: Record<string, number> = { "1": 0, "2": 2, "3": 4, "4": 5, "5": 7, "6": 9, "7": 11 };
/** 半音级 → 唱名（0-11） */
const LEVEL_TO_DIGIT: string[] = ["1", "1", "2", "2", "3", "4", "4", "5", "5", "6", "7", "7"];
/** 非白键音级的惯用变音记号：1♯ 2♯ 4♯ 5♯ 6♯（即 3、7 级降记法） */
const LEVEL_TO_ACCIDENTAL: Record<number, "♯" | "♭"> = { 1: "♯", 3: "♯", 6: "♯", 8: "♯", 10: "♭" };

/** 音名字母 → 半音级 */
const TONE_LETTER_TO_LEVEL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 解析调号字符串（如 "C" "♯F" "♭B"）为半音级；非法返回 null */
export function parseTone(tone: string): number | null {
  const m = tone.match(/^([#♯b♭]?)([A-G])$/);
  if (!m) return null;
  const base = TONE_LETTER_TO_LEVEL[m[2]];
  const adj = m[1] === "#" || m[1] === "♯" ? 1 : m[1] === "b" || m[1] === "♭" ? -1 : 0;
  return (base + adj + 12) % 12;
}

/**
 * 全体音符平移 delta 个半音。
 * 八度跨行进位；原升降号清掉后按新音级重贴惯用记号。
 */
export function transpose(score: Score, delta: number): void {
  const d = delta | 0;
  if (d === 0) return;
  for (const para of score.paragraphs) {
    for (const n of para.notations) {
      if (!isPitchable(n)) continue;
      const oldAcc = (n.prefixAccidentals || []).reduce(
        (acc, a) => acc + (a === "♯" ? 1 : -1),
        0
      );
      const baseLevel = DIGIT_TO_LEVEL[n.note] + oldAcc;
      let newLevel = baseLevel + d;
      let octaveShift = 0;
      while (newLevel >= 12) {
        newLevel -= 12;
        octaveShift += 1;
      }
      while (newLevel < 0) {
        newLevel += 12;
        octaveShift -= 1;
      }
      n.octave += octaveShift;
      n.note = LEVEL_TO_DIGIT[newLevel] as NoteSymbol;
      n.prefixAccidentals = LEVEL_TO_ACCIDENTAL[newLevel] ? [LEVEL_TO_ACCIDENTAL[newLevel]] : [];
    }
  }
}

/** 转调到指定调（如把当前 ♭B 谱转到 C）：delta = 目标 - 当前 */
export function transposeTo(score: Score, destTone: string): boolean {
  const from = parseTone(score.tone);
  const to = parseTone(destTone);
  if (from === null || to === null) return false;
  transpose(score, to - from);
  score.tone = normalizeTone(destTone);
  return true;
}

/** 规范调号写法（f→♭F 等） */
export function normalizeTone(tone: string): string {
  const m = tone.match(/^([#♯b♭]?)([A-G])$/);
  if (!m) return tone;
  const sign = m[1] === "#" || m[1] === "♯" ? "♯" : m[1] === "b" || m[1] === "♭" ? "♭" : "";
  return `${sign}${m[2]}`;
}
