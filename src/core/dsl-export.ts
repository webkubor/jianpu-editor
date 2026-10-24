/** 格式化时值数字：整数不带小数点，小数最多 4 位（1/3 → 0.3333）。 */
function fmtBeats(beats: number): string {
  if (Number.isInteger(beats)) return String(beats);
  return String(Number(beats.toFixed(4)));
}

/** 文本反投影：显式记录基础时值与减时线，保留休止符、八度、附点、连音和歌词。 */
import type { Score } from "./model.ts";

/** 将乐谱导出为可再次编译的 DSL；:拍数/层数 避免重新分组改变节奏。 */
export function toDsl(score: Score): string {
  const lines: string[] = [];
  for (const para of score.paragraphs) {
    const tokens: string[] = [];
    const words: string[] = [];
    const tieDone = new Set<string>();
    for (const n of para.notations) {
      if (n.note === "│" || n.note === "‖" || n.note === "||:" || n.note === ":||") {
        tokens.push(n.note === "│" ? "|" : n.note === "‖" ? "‖" : n.note);
        continue;
      }
      let token = n.note === "─" ? "-" : n.prefixAccidentals.join("").replaceAll("♯", "#").replaceAll("♭", "b") + n.note
        + "^".repeat(Math.max(0, n.octave)) + ",".repeat(Math.max(0, -n.octave)) + (n.dotted ? "." : "");
      const beats = n.beatFrac ?? 1 / 2 ** Math.min(3, n.underline);
      token += `:${fmtBeats(beats)}/${n.underline}`;
      if (n.tieTo && !tieDone.has(n.key)) {
        token += "~";
        tieDone.add(n.tieTo);
      }
      tokens.push(token);
      if (n.note !== "0") words.push(para.lyrics[words.length] ?? "");
    }
    lines.push(tokens.join("  "));
    if (words.some(Boolean)) lines.push(`[词:${words.map((w) => w || "-").join(" ")}]`);
  }
  return lines.join("\n");
}
