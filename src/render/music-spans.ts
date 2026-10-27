/**
 * 同行音乐跨度渲染：连音线、箭头滑音弧、渐强弱、颤音和连音组括号。
 * 坐标由调用方提供；只负责 SVG 与局部避让，不推断曲谱内容或跨行续接。
 * 路由：乐谱编辑器 SVG 行；无后端 API。
 */

/** 由真实谱面数据指定的跨度；两个 key 必须位于当前行。 */
export type MusicSpan = {
  kind: "slur" | "slide" | "crescendo" | "diminuendo" | "trill" | "tuplet";
  startKey: string;
  endKey: string;
  label?: string;
};

type Position = { x: number; top: number; bottom: number };
type Bounds = { left: number; right: number; top: number; bottom: number };
type Placement = Bounds & { start: number; end: number; forward: boolean; label: string; labelWidth: number };

const NS = "http://www.w3.org/2000/svg";
const LAYER = "data-music-spans";
const GLYPH_GAP = 8;
const LANE_GAP = 6;
const STROKE = 1.4;
const FONT_SIZE = 14;
const FONT = '"Times New Roman", "Songti SC", serif';
const HAIRPIN_HEIGHT = 10;
const TEXT_HEIGHT = 22;
const WAVE_AMPLITUDE = 2;
const WAVE_STEP = 4;
const ARROW_LENGTH = 7;
const ARROW_HALF_WIDTH = 3;

function validPosition(position: Position | undefined): position is Position {
  return !!position && Number.isFinite(position.x) && Number.isFinite(position.top)
    && Number.isFinite(position.bottom) && position.top <= position.bottom;
}

function svg<K extends keyof SVGElementTagNameMap>(
  row: SVGGElement,
  tag: K,
  attributes: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const element = row.ownerDocument.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function path(row: SVGGElement, d: string): SVGPathElement {
  return svg(row, "path", {
    d, fill: "none", stroke: "currentColor", "stroke-width": STROKE,
    "stroke-linecap": "round", "stroke-linejoin": "round",
  });
}

function text(row: SVGGElement, label: string, x: number, y: number, centered = false): SVGTextElement {
  return svg(row, "text", {
    x, y, fill: "currentColor", "font-size": FONT_SIZE,
    "font-family": FONT, "text-anchor": centered ? "middle" : "start",
  }, label);
}

function labelWidth(row: SVGGElement, label: string): number {
  const probe = text(row, label, 0, 0);
  row.appendChild(probe);
  try {
    const width = probe.getComputedTextLength();
    if (Number.isFinite(width) && width > 0) return width;
  } finally {
    probe.remove();
  }
  // 脱离文档时文本测量可能为 0；按全角宽度保守预留，避免低估标签占用。
  return Array.from(label).length * FONT_SIZE;
}

function place(
  row: SVGGElement, span: MusicSpan, positions: Map<string, Position>, occupied: Bounds[],
): Placement | undefined {
  const first = positions.get(span.startKey);
  const last = positions.get(span.endKey);
  if (!validPosition(first) || !validPosition(last) || first.x === last.x) return;
  const start = Math.min(first.x, last.x);
  const end = Math.max(first.x, last.x);
  const label = span.label ?? (span.kind === "trill" ? "tr" : "3");
  const width = span.kind === "trill" || span.kind === "tuplet" ? labelWidth(row, label) : 0;
  const center = (start + end) / 2;
  const left = span.kind === "tuplet" ? Math.min(start, center - width / 2 - 4) : start;
  const right = span.kind === "trill" ? Math.max(end, start + width + 12)
    : span.kind === "tuplet" ? Math.max(end, center + width / 2 + 4) : end;
  const below = span.kind === "crescendo" || span.kind === "diminuendo";
  const height = below ? HAIRPIN_HEIGHT : span.kind === "slur" || span.kind === "slide"
    ? Math.min(24, Math.max(10, (end - start) * 0.15)) : TEXT_HEIGHT;
  let top = Math.min(first.top, last.top);
  let bottom = Math.max(first.bottom, last.bottom);
  for (const position of positions.values()) {
    if (validPosition(position) && position.x >= left && position.x <= right) {
      top = Math.min(top, position.top);
      bottom = Math.max(bottom, position.bottom);
    }
  }
  let edge = below ? bottom + GLYPH_GAP : top - GLYPH_GAP;
  for (const previous of occupied) {
    if (left <= previous.right + LANE_GAP && right >= previous.left - LANE_GAP) {
      edge = below ? Math.max(edge, previous.bottom + LANE_GAP)
        : Math.min(edge, previous.top - LANE_GAP);
    }
  }
  return {
    start, end, forward: last.x > first.x, left, right, label, labelWidth: width,
    top: below ? edge : edge - height,
    bottom: below ? edge + height : edge,
  };
}

function wavyLine(start: number, end: number, y: number): string {
  let d = `M ${start} ${y}`;
  for (let x = start, index = 0; x < end; index += 1) {
    const next = Math.min(end, x + WAVE_STEP);
    const crest = y + (index % 2 === 0 ? -1 : 1) * WAVE_AMPLITUDE;
    d += ` Q ${(x + next) / 2} ${crest} ${next} ${y}`;
    x = next;
  }
  return d;
}

function draw(row: SVGGElement, span: MusicSpan, p: Placement): SVGGElement {
  const group = svg(row, "g", {
    class: `music-span music-span-${span.kind}`,
    "data-kind": span.kind, "data-start-key": span.startKey, "data-end-key": span.endKey,
  });
  const { start, end, top, bottom } = p;
  switch (span.kind) {
    case "slur":
    case "slide": {
      const inset = (end - start) / 4;
      group.appendChild(path(row,
        `M ${start} ${bottom} C ${start + inset} ${top} ${end - inset} ${top} ${end} ${bottom}`));
      if (span.kind === "slide") {
        // 沿终点切线手绘箭头，不使用共享 defs/marker ID，也不推断音高方向。
        const tip = p.forward ? end : start;
        const dx = p.forward ? inset : -inset;
        const dy = bottom - top;
        const length = Math.hypot(dx, dy);
        const ux = dx / length;
        const uy = dy / length;
        const arrowLength = Math.min(ARROW_LENGTH, length / 2);
        const halfWidth = Math.min(ARROW_HALF_WIDTH, arrowLength / 2);
        const baseX = tip - ux * arrowLength;
        const baseY = bottom - uy * arrowLength;
        group.appendChild(path(row,
          `M ${baseX - uy * halfWidth} ${baseY + ux * halfWidth} L ${tip} ${bottom}`
          + ` L ${baseX + uy * halfWidth} ${baseY - ux * halfWidth}`));
      }
      break;
    }
    case "crescendo":
    case "diminuendo": {
      const center = (top + bottom) / 2;
      const tip = span.kind === "crescendo" ? start : end;
      const open = span.kind === "crescendo" ? end : start;
      group.appendChild(path(row, `M ${open} ${top} L ${tip} ${center} L ${open} ${bottom}`));
      break;
    }
    case "trill": {
      const label = text(row, p.label, start, bottom - 4);
      label.setAttribute("font-style", "italic");
      group.appendChild(label);
      group.appendChild(path(row, wavyLine(start + p.labelWidth + 4, p.right, bottom - 8)));
      break;
    }
    case "tuplet": {
      const center = (start + end) / 2;
      const y = bottom - 9;
      const gap = p.labelWidth / 2 + 4;
      let d = `M ${start} ${bottom} L ${start} ${y}`;
      if (center - gap > start) d += ` L ${center - gap} ${y}`;
      d += ` M ${end} ${bottom} L ${end} ${y}`;
      if (center + gap < end) d += ` L ${center + gap} ${y}`;
      group.appendChild(path(row, d));
      group.appendChild(text(row, p.label, center, y + 4, true));
      break;
    }
  }
  return group;
}

/**
 * 在 row 的独立图层渲染同行跨度；再次调用仅替换本模块的图层。
 * positions 与 row 使用同一坐标系，top/bottom 必须包含八度点、减时线等完整字形边界。
 * 检查跨度范围内所有位置；上方跨度与下方渐强弱分别分配互不重叠的通道。
 * 缺端点、非有限坐标、倒置边界和零宽跨度跳过；跨行跨度需调用方先拆分。
 * 简化：只有 x 中心与竖向边界，避让以中心落在跨度内的字形为准；不做水平 bbox 推断。
 * 此模块消费已标注的谱面跨度，不识别或证明 Mumin 参考谱的转录准确性。
 */
export function renderMusicSpans(
  row: SVGGElement,
  spans: readonly MusicSpan[],
  positions: Map<string, { x: number; top: number; bottom: number }>,
): void {
  const layer = svg(row, "g", { [LAYER]: "", "pointer-events": "none" });
  const above: Bounds[] = [];
  const below: Bounds[] = [];
  for (const span of spans) {
    const lanes = span.kind === "crescendo" || span.kind === "diminuendo" ? below : above;
    const placement = place(row, span, positions, lanes);
    if (!placement) continue;
    layer.appendChild(draw(row, span, placement));
    lanes.push(placement);
  }
  const previous = Array.from(row.children).find(child => child.hasAttribute(LAYER));
  if (previous) row.replaceChild(layer, previous);
  else row.appendChild(layer);
}
