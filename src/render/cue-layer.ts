/**
 * 独立提示声部：按共享拍数时间轴绘制可打印 SVG，不改主旋律、不触发播放。
 * 路由：无；由编辑器或打印布局传入专用容器。无需运行时依赖。
 */
import type { GraceNote, Notation } from "../core/model.ts";

const NS = "http://www.w3.org/2000/svg";
const BAR_SYMBOLS = new Set(["│", "‖", "||:", ":||"]);
const FONT = '"Times New Roman", "Songti SC", serif';
const PAD = 16;
const DIGIT_SIZE = 22;
const DOT_STEP = 5;

function svgElement<K extends keyof SVGElementTagNameMap>(
  doc: Document, tag: K, attrs: Record<string, string | number>, text?: string,
): SVGElementTagNameMap[K] {
  const element = doc.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function underlineCount(note: Notation): number {
  return Math.max(0, Math.min(3, Math.trunc(note.underline) || 0));
}

function duration(note: Notation): number {
  if (BAR_SYMBOLS.has(note.note)) return 0;
  const beats = note.beatFrac !== undefined && Number.isFinite(note.beatFrac) && note.beatFrac > 0
    ? note.beatFrac : 1 / 2 ** underlineCount(note);
  return beats * (note.dotted ? 1.5 : 1);
}

function octaveDots(group: SVGGElement, x: number, octave: number, top: number, bottom: number, scale = 1): void {
  for (let i = 0; i < Math.abs(octave); i += 1) {
    group.appendChild(svgElement(group.ownerDocument, "circle", {
      cx: x, cy: octave > 0 ? top - i * DOT_STEP * scale : bottom + i * DOT_STEP * scale,
      r: 1.6 * scale,
    }));
  }
}

function line(group: SVGGElement, x1: number, y1: number, x2: number, y2: number, width = 1.2): void {
  group.appendChild(svgElement(group.ownerDocument, "line", {
    x1, y1, x2, y2, stroke: "currentColor", "stroke-width": width,
  }));
}

function drawBar(group: SVGGElement, symbol: string): void {
  const repeat = symbol === "||:" || symbol === ":||";
  line(group, 0, -18, 0, 18, symbol === "||:" ? 2.5 : 1.2);
  if (symbol !== "│") line(group, 5, -18, 5, 18, symbol === "||:" ? 1.2 : 2.5);
  if (repeat) {
    for (const cy of [-5, 5]) {
      group.appendChild(svgElement(group.ownerDocument, "circle", {
        cx: symbol === "||:" ? 11 : -6, cy, r: 1.8,
      }));
    }
  }
}

function drawGrace(group: SVGGElement, grace: GraceNote[], right: number): void {
  const doc = group.ownerDocument;
  grace.forEach((note, index) => {
    const x = right - (grace.length - index) * 20;
    group.appendChild(svgElement(doc, "text", { x, y: -16, "font-size": 13 }, note.note));
    if (note.accidental) {
      group.appendChild(svgElement(doc, "text", { x: x - 8, y: -23, "font-size": 10 }, note.accidental));
    }
    line(group, x - 4, -13, x + 4, -13, 0.8);
    octaveDots(group, x, note.octave, -30, -9, 0.65);
  });
  if (grace.length) {
    group.appendChild(svgElement(doc, "path", {
      d: `M ${right - grace.length * 20} -7 Q ${right - 8} 0 ${right + 2} -8`,
      fill: "none", stroke: "currentColor", "stroke-width": 0.9,
    }));
  }
}

function drawNote(group: SVGGElement, note: Notation): void {
  if (BAR_SYMBOLS.has(note.note)) {
    drawBar(group, note.note);
    return;
  }
  const doc = group.ownerDocument;
  const underlines = underlineCount(note);
  const accidentalRight = -14;
  const graceRight = accidentalRight - note.prefixAccidentals.length * 11;
  drawGrace(group, note.graceNotes ?? [], graceRight);
  note.prefixAccidentals.forEach((accidental, index) => {
    group.appendChild(svgElement(doc, "text", {
      x: accidentalRight - (note.prefixAccidentals.length - index - 1) * 11,
      y: -8, "font-size": 15,
    }, accidental));
  });
  if (note.note === "─") line(group, -7, -7, 7, -7, 1.5);
  else group.appendChild(svgElement(doc, "text", { x: 0, y: 0, "font-size": DIGIT_SIZE }, note.note));
  for (let i = 0; i < underlines; i += 1) line(group, -7, 5 + i * 4, 7, 5 + i * 4);
  if (note.note >= "1" && note.note <= "7") {
    octaveDots(group, 0, note.octave, -25, 11 + underlines * 4);
  }
  if (note.dotted) group.appendChild(svgElement(doc, "circle", { cx: 12, cy: -7, r: 1.6 }));
  note.topDecorators.forEach((text, index) => {
    group.appendChild(svgElement(doc, "text", {
      x: 0, y: -36 - Math.max(0, note.octave - 1) * DOT_STEP - index * 13, "font-size": 12,
    }, text));
  });
}

/** 在专用容器内重绘提示声部；startBeat 为相对段落起点的拍数，timelineBeats 为共享总拍数。 */
export function renderCueLayer(
  container: HTMLElement,
  layer: { label: string; startBeat: number; notations: Notation[]; timelineBeats?: number },
): void {
  const doc = container.ownerDocument;
  const start = Number.isFinite(layer.startBeat) ? Math.max(0, layer.startBeat) : 0;
  const timed = layer.notations.map(note => ({ note, beats: duration(note) }));
  const end = start + timed.reduce((sum, item) => sum + item.beats, 0);
  const timeline = Math.max(0, end, Number.isFinite(layer.timelineBeats) ? layer.timelineBeats ?? 0 : 0) || 1;
  // 按最拥挤符号决定每拍尺度，附件不会挤压短音符；小节线本身不占拍。
  const beatWidth = timed.reduce((width, { note, beats }) => beats > 0
    ? Math.max(width, (38 + (note.graceNotes?.length ?? 0) * 40 + note.prefixAccidentals.length * 22) / beats)
    : width, 44);
  const above = Math.max(40, ...layer.notations.map(note =>
    36 + Math.max(0, note.octave) * DOT_STEP + note.topDecorators.length * 13),
  ...layer.notations.flatMap(note => (note.graceNotes ?? []).map(grace =>
    34 + Math.max(0, grace.octave) * DOT_STEP)));
  const below = Math.max(24, ...layer.notations.map(note =>
    15 + underlineCount(note) * 4 + Math.max(0, -note.octave) * DOT_STEP),
  ...layer.notations.flatMap(note => (note.graceNotes ?? []).map(grace =>
    14 + Math.max(0, -grace.octave) * DOT_STEP)));
  const baseline = 30 + above;
  const width = PAD * 2 + timeline * beatWidth;
  const height = baseline + below + PAD;
  const label = layer.label.trim() ? `提示声部 · ${layer.label}` : "提示声部";
  const svg = svgElement(doc, "svg", {
    class: "cue-layer", xmlns: NS, viewBox: `0 0 ${width} ${height}`,
    width: "100%", role: "img", "aria-label": label,
    "data-start-beat": start, "data-timeline-beats": timeline,
    fill: "currentColor", "font-family": FONT, "text-anchor": "middle",
  });
  svg.style.display = "block";
  svg.style.height = "auto";
  svg.style.breakInside = "avoid";
  svg.appendChild(svgElement(doc, "title", {}, label));
  svg.appendChild(svgElement(doc, "text", { x: PAD, y: 18, "font-size": 13, "text-anchor": "start" }, label));
  let beat = start;
  for (const { note, beats } of timed) {
    const group = svgElement(doc, "g", {
      class: "cue-glyph", "data-key": note.key, "data-beat": beat, "data-duration": beats,
      transform: `translate(${PAD + (beat + beats / 2) * beatWidth}, ${baseline})`,
    });
    drawNote(group, note);
    svg.appendChild(group);
    beat += beats;
  }
  container.replaceChildren(svg);
}
