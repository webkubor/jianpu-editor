/**
 * SVG 渲染器：把 Notation[] 排到 SVG 上
 * 原理（对 numerical-notation-editor placement 的重写）：
 * - 不用音符字体，全部 SVG text/circle/line：数字为主体，八度点/附点是小圆，
 *   减时线是横线（小节内连续同层音符连成一条）。
 * - 文本宽度用 canvas measureText 离屏测量。
 * - 段落两端对齐：段内间隙 = (页宽 - 实宽) / (符号数-1)。
 */

import { EXTEND, Notation, Score } from "../core/model.ts";

/** 排版常量（单位 px，基准字号 28） */
export const LAYOUT = {
  fontSize: 30,
  subFontSize: 16,
  /** 数字间基础步进（由测宽动态计算，此为最小值） */
  minGap: 18,
  /** 音符上方八度点初始偏移 */
  dotAboveY: -14,
  /** 音符下方八度点初始偏移 */
  dotBelowY: 16,
  /** 八度点间距 */
  dotStep: 6,
  dotR: 2.6,
  /** 附点偏移 */
  dottedDx: 14,
  /** 减时线第一层 y */
  underlineY0: 17,
  underlineStep: 5,
  /** 行高 */
  lineHeight: 64,
  /** 段间距 */
  paraGap: 26,
  pageMarginX: 48,
  titleFontSize: 26,
  headerFontSize: 15,
} as const;

/** 离屏 canvas 文本测宽（模块级单例） */
let measureCtx: CanvasRenderingContext2D | null = null;
export function textWidth(text: string, fontSize: number): number {
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  measureCtx!.font = `${fontSize}px "Times New Roman", "Songti SC", serif`;
  return measureCtx!.measureText(text).width;
}

/** SVG 命名空间 */
const NS = "http://www.w3.org/2000/svg";

/** 创建 SVG 元素的便捷函数 */
function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  text?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 一个符号的渲染尺寸 */
interface Glyph {
  n: Notation;
  /** 渲染宽度（含间隙） */
  width: number;
  /** 主体（数字）宽度 */
  core: number;
}

/** 测量一个符号的宽度 */
function measureGlyph(n: Notation): Glyph {
  if (n.note === EXTEND) {
    return { n, core: 26, width: 26 + LAYOUT.minGap };
  }
  if (n.note === "│" || n.note === "‖") {
    return { n, core: 8, width: 8 + LAYOUT.minGap * 1.6 };
  }
  const acc = n.prefixAccidentals.join("");
  const core = textWidth(n.note, LAYOUT.fontSize) + (acc ? textWidth(acc, LAYOUT.subFontSize) + 2 : 0) + (n.dotted ? 8 : 0);
  return { n, core, width: core + LAYOUT.minGap };
}

/** 单个符号 → SVG 节点组（以 x 为符号中心，y 为基线） */
function renderGlyph(g: Glyph, x: number, y: number, selected: boolean): SVGGElement {
  const group = el("g", {
    class: "glyph" + (selected ? " selected" : ""),
    "data-key": g.n.key,
    transform: `translate(${x}, ${y})`,
  });
  const n = g.n;
  if (n.note === "│" || n.note === "‖") {
    const h = 30;
    group.appendChild(el("line", { x1: 0, y1: -h / 2 - 4, x2: 0, y2: h / 2 - 4, stroke: "currentColor", "stroke-width": 1.4 }));
    if (n.note === "‖") {
      group.appendChild(el("line", { x1: 4, y1: -h / 2 - 4, x2: 4, y2: h / 2 - 4, stroke: "currentColor", "stroke-width": 3 }));
    }
    return group;
  }
  if (n.note === EXTEND) {
    group.appendChild(el("text", {
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-size": LAYOUT.fontSize,
      transform: "scale(0.9,1)",
    }, EXTEND));
  } else {
    // 升降号
    let accX = -g.core / 2;
    for (const a of n.prefixAccidentals) {
      group.appendChild(el("text", {
        x: accX + textWidth(a, LAYOUT.subFontSize) / 2,
        y: -8,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": LAYOUT.subFontSize,
      }, a));
      accX += textWidth(a, LAYOUT.subFontSize) + 2;
    }
    // 主体数字
    group.appendChild(el("text", {
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-size": LAYOUT.fontSize,
    }, n.note));
  }
  // 附点
  if (n.dotted) {
    group.appendChild(el("circle", { cx: g.core / 2 + 3, cy: 5, r: LAYOUT.dotR, fill: "currentColor" }));
  }
  // 八度点
  const dir = n.octave > 0 ? -1 : 1;
  const y0 = n.octave > 0 ? LAYOUT.dotAboveY : LAYOUT.dotBelowY;
  for (let i = 0; i < Math.abs(n.octave); i += 1) {
    group.appendChild(el("circle", { cx: 0, cy: y0 + dir * LAYOUT.dotStep * i, r: LAYOUT.dotR, fill: "currentColor" }));
  }
  // 单音符独立减时线（连排的由段落层绘制）
  if (n.underline > 0) {
    for (let i = 0; i < n.underline; i += 1) {
      group.appendChild(el("line", {
        x1: -g.core / 2, x2: g.core / 2,
        y1: LAYOUT.underlineY0 + i * LAYOUT.underlineStep,
        y2: LAYOUT.underlineY0 + i * LAYOUT.underlineStep,
        stroke: "currentColor", "stroke-width": 1.3,
      }));
    }
  }
  return group;
}

/** 渲染整份乐谱到一个容器 */
export function renderScore(container: HTMLElement, score: Score, selectedKey: string | null): void {
  container.innerHTML = "";
  const pageWidth = 860;
  const svg = el("svg", {
    viewBox: `0 0 ${pageWidth} 400`,
    width: "100%",
    class: "score-svg",
  });
  // 标题
  svg.appendChild(el("text", {
    x: pageWidth / 2, y: 44,
    "text-anchor": "middle",
    "font-size": LAYOUT.titleFontSize,
    "font-weight": "bold",
  }, score.title));
  // 调号/拍号/速度行
  const header = `1 = ${score.tone}    ${score.beat[0]}/${score.beat[1]}    ♩= ${score.speed}`;
  svg.appendChild(el("text", {
    x: LAYOUT.pageMarginX, y: 74,
    "font-size": LAYOUT.headerFontSize,
    fill: "#666",
  }, header));
  // 作者行（右对齐）
  svg.appendChild(el("text", {
    x: pageWidth - LAYOUT.pageMarginX, y: 74,
    "text-anchor": "end",
    "font-size": LAYOUT.headerFontSize,
    fill: "#999",
  }, score.authors.join("  ")));

  let yOffset = 118;
  const contentWidth = pageWidth - LAYOUT.pageMarginX * 2;
  for (const para of score.paragraphs) {
    const glyphs = para.notations.map(measureGlyph);
    const totalWidth = glyphs.reduce((s, g) => s + g.width, 0) - (glyphs.length ? LAYOUT.minGap : 0);
    const flex = para.alignJustify && glyphs.length > 1 && totalWidth < contentWidth
      ? (contentWidth - totalWidth) / (glyphs.length - 1)
      : 0;
    let x = LAYOUT.pageMarginX;
    const row = el("g", { class: "paragraph", transform: `translate(0, ${yOffset})` });
    glyphs.forEach((g) => {
      const cx = x + g.width / 2;
      row.appendChild(renderGlyph(g, cx, 0, g.n.key === selectedKey));
      x += g.width + flex;
    });
    svg.appendChild(row);
    yOffset += LAYOUT.lineHeight;
  }
  svg.setAttribute("viewBox", `0 0 ${pageWidth} ${yOffset + 40}`);
  container.appendChild(svg);
}
