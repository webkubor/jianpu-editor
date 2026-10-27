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

/** 只认可从主声部小节末开始、完整接回下一主音的共享小节。 */
function completesSharedBar(
  para: Paragraph, bar: ReturnType<typeof measureBeats>[number], offset: number, expected: number,
): boolean {
  if (!(bar.beats > 0 && bar.beats < expected)) return false;
  const same = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6;
  const isBar = (n: Paragraph["notations"][number]) => ["│", "‖", "||:", ":||"].includes(n.note);
  // 必须已有小节线；其后的反复/小节线可连续，不能越过休止或其他有时值符号。
  let resume = bar.end + 1;
  if (!para.notations[resume] || !isBar(para.notations[resume])) return false;
  while (para.notations[resume] && isBar(para.notations[resume])) resume++;
  const next = para.notations[resume];
  if (!next || !isPitchable(next)) return false;
  return (para.cueLayers ?? []).some(layer => {
    if (layer.resumeKey !== next.key || !same(layer.startBeat, offset + bar.beats)) return false;
    const fragments = measureBeats({ ...para, notations: layer.notations });
    const first = fragments[0];
    if (!first || !layer.notations[first.end + 1] || !isBar(layer.notations[first.end + 1]) ||
        !same(first.beats + bar.beats, expected) ||
        !fragments.slice(1).every(fragment => same(fragment.beats, expected))) return false;
    const total = fragments.reduce((sum, fragment) => sum + fragment.beats, 0);
    const timeline = layer.timelineBeats;
    if (timeline === undefined || !same(timeline, offset + expected * fragments.length) ||
        !same(layer.startBeat + total, timeline)) return false;
    // 其他提示不能在这段补足时间内重叠；端点相接允许。
    return !(para.cueLayers ?? []).some(other => {
      if (other === layer) return false;
      const end = other.startBeat + other.notations.reduce((sum, n) => sum + beatsOf(n), 0);
      return other.startBeat < timeline - 1e-6 && end > layer.startBeat + 1e-6;
    });
  });
}

/** 全谱校验：段落拍号优先；共享声部须完整满足小节与恢复点约束。 */
export function validateScore(score: Score): BeatIssue[] {
  const issues: BeatIssue[] = [];
  score.paragraphs.forEach((para, p) => {
    if (para.freeTime === true) return;
    const [num, den] = para.meter ?? score.beat;
    const expected = num * 4 / den;
    let offset = 0;
    measureBeats(para).forEach((bar, b) => {
      // 忽略拍数为 0 的空小节（纯小节线连打）；共享补足不改变主声部统计。
      if (bar.beats > 0 && Math.abs(bar.beats - expected) > 1e-6 &&
          !completesSharedBar(para, bar, offset, expected)) {
        issues.push({ paragraph: p, bar: b, beats: bar.beats, expected });
      }
      offset += bar.beats;
    });
  });
  return issues;
}
