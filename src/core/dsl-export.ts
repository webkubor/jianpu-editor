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
    if (para.heading !== undefined || para.meter !== undefined || para.freeTime !== undefined) {
      lines.push(`@section ${JSON.stringify({ heading: para.heading, meter: para.meter, freeTime: para.freeTime })}`);
    }
    const tokens: string[] = [];
    const words: string[] = [];
    const tieDone = new Set<string>();
    for (const n of para.notations) {
      if (n.note === "│" || n.note === "‖" || n.note === "||:" || n.note === ":||") {
        let b = n.note === "│" ? "|" : n.note === "‖" ? "‖" : n.note;
        if (n.volta) b = `[${n.volta}]` + b;
        tokens.push(b);
        continue;
      }
      let prefix = "";
      if (n.graceNotes && n.graceNotes.length > 0) {
        prefix = `(${n.graceNotes.map(g => (g.accidental ?? "").replace("♯", "#").replace("♭", "b") + g.note + "^".repeat(Math.max(0, g.octave)) + ",".repeat(Math.max(0, -g.octave))).join("")})`;
      }
      let techItems: string[] = [];
      if (n.technique) {
        if (n.technique.trill) techItems.push("tr");
        if (n.technique.mordent) techItems.push("w");
        if (n.technique.appoggiatura) techItems.push("die");
        if (n.technique.accent) techItems.push(">");
        if (n.technique.breath) techItems.push("v");
        if (n.technique.slideUp) techItems.push("up");
        if (n.technique.slideDown) techItems.push("down");
        if (n.technique.tonguing) techItems.push(n.technique.tonguing);
        if (n.technique.flutter) techItems.push("fl");
        if (n.technique.vibrato) techItems.push("vib");
        if (n.technique.glissando) techItems.push("gli");
      }
      const allDecorators = [...(n.topDecorators || []), ...techItems, ...(n.dynamic ? [n.dynamic] : [])];
      let token = prefix + (n.note === "─" ? "-" : n.prefixAccidentals.join("").replaceAll("♯", "#").replaceAll("♭", "b") + n.note)
        + "^".repeat(Math.max(0, n.octave)) + ",".repeat(Math.max(0, -n.octave)) + (n.dotted ? "." : "")
        + (allDecorators.length ? `{${allDecorators.join(",")}}` : "");
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
    const localSpans = para.spans?.filter(span => para.notations.some(n => n.key === span.endKey));
    if (localSpans?.length) {
      lines.push(`@spans ${JSON.stringify(localSpans.map(span => ({
        kind: span.kind, start: para.notations.findIndex(n => n.key === span.startKey),
        end: para.notations.findIndex(n => n.key === span.endKey), label: span.label,
      })))}`);
    }
    if (words.some(Boolean)) lines.push(`[词:${words.map((w) => w || "-").join(" ")}]`);
    for (const layer of para.cueLayers ?? []) {
      const cueDsl = toDsl({ ...score, paragraphs: [{ ...para, heading: undefined, meter: undefined,
        freeTime: undefined, spans: undefined, cueLayers: undefined, lyrics: [], notations: layer.notations }] });
      lines.push(`@cue ${JSON.stringify({ label: layer.label, startBeat: layer.startBeat, timelineBeats: layer.timelineBeats,
        ...(layer.resumeKey ? { resume: para.notations.findIndex(n => n.key === layer.resumeKey) } : {}), dsl: cueDsl })}`);
    }
  }
  const addresses = new Map(score.paragraphs.flatMap((para, paragraph) => para.notations.map((n, index) =>
    [n.key, [paragraph, index] as [number, number]] as const)));
  const crossSpans = score.paragraphs.flatMap(para => (para.spans ?? [])
    .filter(span => !para.notations.some(n => n.key === span.endKey))
    .map(span => ({ kind: span.kind, start: addresses.get(span.startKey), end: addresses.get(span.endKey), label: span.label })));
  if (crossSpans.length) lines.push(`@cross-spans ${JSON.stringify(crossSpans)}`);
  return lines.join("\n");
}
