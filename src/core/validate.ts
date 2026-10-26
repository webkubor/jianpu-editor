/**
 * 小节拍数校验：按拍号检查每个小节的时值单元数是否正确
 * 职责：measureBeats（单段逐小节统计）→ validateScore（全谱收集违规）
 * 规则：音符/延音线各记 1/2^underline 拍（附点 ×1.5）；小节线分段；词行不参与。
 */

import type { Paragraph, Score } from "./model.ts";
import { isPitchable } from "./model.ts";

/** 单符号时值（拍）：与播放层同一套规则——beatFrac 优先（n 连音真实时值），回退减时线折算；延音线 1 拍 */
function beatsOf(n: Paragraph["notations"][number]): number {
  if (!isPitchable(n) && n.note !== "─" && n.note !== "0") return 0;
  if (n.note === "─") return 1;
  const base = n.beatFrac ?? 1 / 2 ** Math.min(3, n.underline);
  return n.dotted ? base * 1.5 : base;
}

/** 单段落逐小节统计：返回每小节 { 起-止符号下标, 拍数 } */
export function measureBeats(para: Paragraph): Array<{ start: number; end: number; beats: number }> {
  const bars: Array<{ start: number; end: number; beats: number }> = [];
  let start = 0;
  let beats = 0;
  para.notations.forEach((n, i) => {
    if (n.note === "│" || n.note === "‖" || n.note === "||:" || n.note === ":||") {
      bars.push({ start, end: i - 1, beats });
      start = i + 1;
      beats = 0;
      return;
    }
    beats += beatsOf(n);
  });
  if (start < para.notations.length) bars.push({ start, end: para.notations.length - 1, beats });
  return bars;
}

export interface BeatIssue {
  paragraph: number;
  bar: number;
  beats: number;
  expected: number;
}

/** 全谱校验：段落拍号优先，按四分音符折算时值；仅跳过显式散板段落 */
export function validateScore(score: Score): BeatIssue[] {
  const issues: BeatIssue[] = [];
  score.paragraphs.forEach((para, p) => {
    if (para.freeTime === true) return;
    const [num, den] = para.meter ?? score.beat;
    const expected = num * 4 / den;
    measureBeats(para).forEach((bar, b) => {
      // 忽略拍数为 0 的空小节（纯小节线连打）
      if (bar.beats > 0 && Math.abs(bar.beats - expected) > 1e-6) {
        issues.push({ paragraph: p, bar: b, beats: bar.beats, expected });
      }
    });
  });
  return issues;
}
