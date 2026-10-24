/**
 * SVG 渲染器：把 Notation[] 排到 SVG 上
 * 原理（对 numerical-notation-editor placement 的重写）：
 * - 不用音符字体，全部 SVG text/circle/line：数字为主体，八度点/附点是小圆，
 *   减时线是横线（小节内连续同层音符连成一条）。
 * - 文本宽度用 canvas measureText 离屏测量。
 * - 段落两端对齐：段内间隙 = (页宽 - 实宽) / (符号数-1)。
 */

import { BAR, DOUBLE_BAR, EXTEND, REPEAT_START, REPEAT_END, isPitchable } from "../core/model.ts";
import type { Notation, Paragraph, Score } from "../core/model.ts";
import { wrapRows } from "./layout.ts";

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
  /** 歌词字号与基线偏移 */
  lyricFontSize: 15,
  lyricDy: 34,
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
  if (n.note === REPEAT_START || n.note === REPEAT_END) {
    return { n, core: 14, width: 14 + LAYOUT.minGap * 1.8 };
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
  // 透明命中区让数字周围空隙和细小节线也容易点击。
  group.appendChild(el("rect", {
    x: -g.width / 2, y: -32, width: g.width, height: 62,
    fill: "transparent", "pointer-events": "all",
  }));
  const n = g.n;
  if (n.note === "│" || n.note === "‖") {
    const h = 30;
    group.appendChild(el("line", { x1: 0, y1: -h / 2 - 4, x2: 0, y2: h / 2 - 4, stroke: "currentColor", "stroke-width": 1.4 }));
    if (n.note === "‖") {
      group.appendChild(el("line", { x1: 4, y1: -h / 2 - 4, x2: 4, y2: h / 2 - 4, stroke: "currentColor", "stroke-width": 3 }));
    }
    return group;
  }
  if (n.note === REPEAT_START || n.note === REPEAT_END) {
    const h = 30;
    if (n.note === REPEAT_START) {
      // 反复开始：左粗右细 + 右侧两圆点
      group.appendChild(el("line", { x1: -4, y1: -h / 2 - 4, x2: -4, y2: h / 2 - 4, stroke: "currentColor", "stroke-width": 3 }));
      group.appendChild(el("line", { x1: 0, y1: -h / 2 - 4, x2: 0, y2: h / 2 - 4, stroke: "currentColor", "stroke-width": 1.4 }));
      group.appendChild(el("circle", { cx: 4, cy: -8, r: 2, fill: "currentColor" }));
      group.appendChild(el("circle", { cx: 4, cy: 0, r: 2, fill: "currentColor" }));
    } else {
      // 反复结束：左侧两圆点 + 左细右粗
      group.appendChild(el("circle", { cx: -4, cy: -8, r: 2, fill: "currentColor" }));
      group.appendChild(el("circle", { cx: -4, cy: 0, r: 2, fill: "currentColor" }));
      group.appendChild(el("line", { x1: 0, y1: -h / 2 - 4, x2: 0, y2: h / 2 - 4, stroke: "currentColor", "stroke-width": 1.4 }));
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
  container.appendChild(renderScoreSvg(score, selectedKey));
}

/** 渲染为独立 SVG 元素（画布与打印导出共用） */
export function renderScoreSvg(score: Score, selectedKey: string | null = null): SVGSVGElement {
  const pageWidth = 860;
  const svg = el("svg", {
    viewBox: `0 0 ${pageWidth} 400`,
    width: "100%",
    class: "score-svg",
    xmlns: "http://www.w3.org/2000/svg",
  });
  svg.appendChild(el("text", {
    x: pageWidth / 2, y: 40,
    "text-anchor": "middle", "font-size": 24, "font-weight": 600,
    ...(textWidth(score.title, 24) > pageWidth - 80 ? { textLength: pageWidth - 80 } : {}),
    lengthAdjust: "spacingAndGlyphs",
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
    // 段内全序下标（含小节线）——播放高亮 data-idx 与 PlayEvent.index 对齐
    const orderIdx = new Map<Notation, number>();
    para.notations.forEach((n, i) => orderIdx.set(n, i));
    // width 已含基础间隙；优先在已有小节线后断行，超长小节才按符号拆分。
    const rows = wrapRows(glyphs, contentWidth, (g) => g.width,
      (g) => g.n.note === BAR || g.n.note === DOUBLE_BAR || g.n.note === REPEAT_START || g.n.note === REPEAT_END);

    const paraNo = score.paragraphs.indexOf(para);
    for (const rowGlyphs of rows) {
      const totalWidth = rowGlyphs.reduce((s, g) => s + g.width, 0);
      const flex = para.alignJustify && rowGlyphs.length > 1 && totalWidth < contentWidth
        ? (contentWidth - totalWidth) / (rowGlyphs.length - 1)
        : 0;
      let x = LAYOUT.pageMarginX;
      const row = el("g", { class: "paragraph", "data-para": String(paraNo), transform: `translate(0, ${yOffset})` });
      // 发声符号序号（歌词对齐用）——段内全序，跨视觉行连续
      let soundingIdx = para.lyrics.length ? countSoundingBefore(score, para, rowGlyphs[0]?.n.key ?? "") : 0;
      const tieFrom = new Map<string, Notation>();
      para.notations.forEach((n, i) => {
        if (!n.tieTo) return;
        const j = para.notations.findIndex(o => o.key === n.tieTo);
        if (j > i) tieFrom.set(para.notations[j].key, n);
      });
      rowGlyphs.forEach((g) => {
        const cx = x + g.width / 2;
        // 连音线：只由配对中靠后的一方绘制，从其中心连到前方符号中心，画在音符下方。
        // tie 可能跨延音线（1~ - 2 中 to 是 ─），target 不限音符；跨视觉行时退化为在 to 所在行内画短弧。
        const from = tieFrom.get(g.n.key);
        if (from) {
          const fromGlyph = rowGlyphs.find(gg => gg.n.key === from.key);
          const toCx = cx - LAYOUT.pageMarginX;
          const arc = tieArc(rowGlyphs.map(gg => gg.width), fromGlyph ? rowGlyphs.indexOf(fromGlyph) : -1, flex, toCx);
          if (arc) {
            row.appendChild(el("path", {
              d: arc,
              stroke: "currentColor", fill: "none", "stroke-width": 1.2, class: "tie",
            }));
          }
        }
        const glyph = renderGlyph(g, cx, 0, g.n.key === selectedKey);
        glyph.setAttribute("data-idx", String(orderIdx.get(g.n) ?? -1));
        if (isPitchable(g.n) || g.n.note === EXTEND) {
          glyph.setAttribute("data-sounding", String(countSoundingIdx(para, g.n)));
        }
        row.appendChild(glyph);
        // 歌词：仅发声符号（音符/延音线）有词位；data-sounding 记发声序号（卡拉OK 高亮用）
        if (isPitchable(g.n) || g.n.note === EXTEND) {
          soundingIdx += 1;
          const word = para.lyrics[soundingIdx - 1] ?? "";
          if (word) {
            row.appendChild(el("text", {
              x: cx, y: LAYOUT.lyricDy,
              "text-anchor": "middle",
              "font-size": LAYOUT.lyricFontSize,
              class: "lyric",
              "data-sounding": String(soundingIdx - 1),
            }, word));
          }
        }
        x += g.width + flex;
      });
      svg.appendChild(row);
      yOffset += LAYOUT.lineHeight;
    }
  }
  if (score.paragraphs.every((p) => p.notations.length === 0)) {
    // 空谱引导：新用户第一眼知道从哪开始（点击/按键不产生数据，仅提示）
    svg.appendChild(el("text", {
      x: pageWidth / 2, y: yOffset + 48,
      "text-anchor": "middle", "font-size": 16, fill: "#bbb",
    }, "直接按 1–7 输入音符 · 或把简谱文本粘贴到画布（⌘V）"));
    yOffset += 64;
  }
  svg.setAttribute("viewBox", `0 0 ${pageWidth} ${yOffset + 40}`);
  return svg;
}

/** 统计段内某符号之前的发声符号数（歌词跨行对齐用） */
function countSoundingBefore(score: Score, para: Paragraph, key: string): number {
  const list = score.paragraphs.find((p) => p === para)?.notations ?? [];
  let count = 0;
  for (const n of list) {
    if (n.key === key) break;
    if (isPitchable(n) || n.note === EXTEND) count += 1;
  }
  return count;
}

/** 符号在段内的发声序号（非发声符号返回 -1；卡拉OK 歌词高亮用） */
function countSoundingIdx(para: Paragraph, target: Notation): number {
  let count = 0;
  for (const n of para.notations) {
    if (n === target) return count;
    if (isPitchable(n) || n.note === EXTEND) count += 1;
  }
  return -1;
}

/** 行内符号中心 x（相对行起点；pageMarginX 与 flex 拉伸都计入） */
export function rowCenterX(widths: number[], index: number, flex: number): number {
  let x = 0;
  for (let i = 0; i < index; i++) x += widths[i] + flex;
  return x + widths[index] / 2;
}

/** 计算 tie 弧线的 path d 值；fromPos < 0（from 不在本行，跨行 tie）返回 null（优雅退化不画）。
 * 抽成纯函数以便单测几何语义：起点=from 行内中心，终点=to 行内中心，控制点居中下鼓 8px。 */
export function tieArc(widths: number[], fromPos: number, flex: number, toCx: number): string | null {
  if (fromPos < 0 || fromPos >= widths.length) return null;
  const fromCx = rowCenterX(widths, fromPos, flex);
  return `M ${fromCx} 6 Q ${(fromCx + toCx) / 2} 14 ${toCx} 6`;
}
