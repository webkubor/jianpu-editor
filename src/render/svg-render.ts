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
import { renderMusicSpans } from "./music-spans.ts";
import { renderCueLayer } from "./cue-layer.ts";
import { A4_PAGE, INLINE_CUE, paginateScore, spanGlyphBounds, type ScorePage } from "./pagination.ts";

/** 排版常量（单位 px，基准字号 28） */
export const LAYOUT = {
  fontSize: 28,
  subFontSize: 15,
  /** 数字间基础步进（由测宽动态计算，此为最小值） */
  minGap: 20,
  /** 音符上方八度点初始偏移（拉开距离杜绝与数字笔画重合） */
  dotAboveY: -16,
  /** 音符下方八度点初始偏移（拉开距离杜绝与减时线重叠） */
  dotBelowY: 22,
  /** 八度点间距 */
  dotStep: 6,
  dotR: 2.2,
  /** 附点偏移 */
  dottedDx: 14,
  /** 减时线第一层 y */
  underlineY0: 16,
  underlineStep: 4.5,
  /** 行高 */
  lineHeight: 64,
  /** 段间距 */
  paraGap: 26,
  pageMarginX: 48,
  titleFontSize: 26,
  headerFontSize: 14,
  /** 歌词字号与基线偏移 */
  lyricFontSize: 14,
  lyricDy: 34,
} as const;

/** 离屏 canvas 文本测宽（模块级单例） */
let measureCtx: CanvasRenderingContext2D | null = null;
export function textWidth(text: string, fontSize: number, fontFamily = '"Times New Roman", "Songti SC", serif', fontWeight = 400): number {
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  measureCtx!.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
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

const NOTE_FONT = "'PingFang SC', 'MiSans', -apple-system, sans-serif";
const GRACE_FONT = '"Times New Roman", "Songti SC", serif';

/** 测宽与绘制共用的主音锚点；左右附件各自占位，core 仍为整组宽度。 */
function noteGeometry(n: Notation) {
  const digitWidth = n.note === EXTEND ? 26 : textWidth(n.note, LAYOUT.fontSize, NOTE_FONT, 600);
  const accidentalWidths = n.prefixAccidentals.map(a => textWidth(a, LAYOUT.subFontSize, GRACE_FONT));
  const accidentalWidth = accidentalWidths.reduce((sum, width) => sum + width + 2, 0);
  const graceWidths = (n.graceNotes ?? []).map(gn => Math.max(8, textWidth((gn.accidental ?? "") + gn.note, 13, GRACE_FONT, 600)));
  const graceWidth = graceWidths.reduce((sum, width) => sum + width + 4, 0);
  const left = accidentalWidth + (graceWidth ? graceWidth + 4 : 0);
  const postWidth = (n.postGraceNotes ?? []).reduce((sum, gn) => sum + Math.max(8,
    textWidth((gn.accidental ?? "") + gn.note, 13, GRACE_FONT, 600)) + 4, 0);
  const right = (n.dotted ? 6 + LAYOUT.dotR : 0) + (postWidth ? postWidth + 6 : 0);
  const mainX = (left - right) / 2;
  return { digitWidth, accidentalWidths, accidentalWidth, graceWidths, mainX, core: left + digitWidth + right };
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
  const { core } = noteGeometry(n);
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
  const geometry = noteGeometry(n);
  const mainX = n.note === EXTEND ? 0 : geometry.mainX;
  if (n.note === "│" || n.note === "‖") {
    const yTop = -14;
    const yBot = 20;
    group.appendChild(el("line", { x1: 0, y1: yTop, x2: 0, y2: yBot, stroke: "currentColor", "stroke-width": 1.4 }));
    if (n.note === "‖") {
      group.appendChild(el("line", { x1: 4.5, y1: yTop, x2: 4.5, y2: yBot, stroke: "currentColor", "stroke-width": 2.8 }));
    }
    // 跳房子反复门楼标记 (Volta brackets: 1. 或 2.)
    if (n.volta) {
      const vY = -34;
      group.appendChild(el("path", {
        d: `M -6 ${vY + 12} L -6 ${vY} L 45 ${vY}`,
        stroke: "currentColor", fill: "none", "stroke-width": 1.2, class: "volta-bracket",
      }));
      group.appendChild(el("text", {
        x: 4, y: vY + 9, "font-size": 11, "font-weight": 700, "font-family": "Times New Roman, serif",
      }, n.volta));
    }
    return group;
  }
  if (n.note === REPEAT_START || n.note === REPEAT_END) {
    const yTop = -14;
    const yBot = 20;
    if (n.note === REPEAT_START) {
      // 反复开始：左粗右细 + 右侧两圆点
      group.appendChild(el("line", { x1: -4.5, y1: yTop, x2: -4.5, y2: yBot, stroke: "currentColor", "stroke-width": 2.8 }));
      group.appendChild(el("line", { x1: 0, y1: yTop, x2: 0, y2: yBot, stroke: "currentColor", "stroke-width": 1.4 }));
      group.appendChild(el("circle", { cx: 4.5, cy: -2, r: 2.2, fill: "currentColor" }));
      group.appendChild(el("circle", { cx: 4.5, cy: 9, r: 2.2, fill: "currentColor" }));
    } else {
      // 反复结束：左侧两圆点 + 左细右粗
      group.appendChild(el("circle", { cx: -4.5, cy: -2, r: 2.2, fill: "currentColor" }));
      group.appendChild(el("circle", { cx: -4.5, cy: 9, r: 2.2, fill: "currentColor" }));
      group.appendChild(el("line", { x1: 0, y1: yTop, x2: 0, y2: yBot, stroke: "currentColor", "stroke-width": 1.4 }));
      group.appendChild(el("line", { x1: 4.5, y1: yTop, x2: 4.5, y2: yBot, stroke: "currentColor", "stroke-width": 2.8 }));
    }
    return group;
  }
  if (n.note === EXTEND) {
    group.appendChild(el("line", {
      x1: -12, y1: 0, x2: 12, y2: 0,
      stroke: "currentColor",
      "stroke-width": 2.2,
      "stroke-linecap": "round",
      class: "extend-line",
    }));
  } else {
    // 前置倚音小音符渲染（如 ⁵ 或 ³⁵，位于左上方，带小斜线与小圆弧连线）
    if (n.graceNotes && n.graceNotes.length > 0) {
      const startGx = -g.core / 2;
      let graceCursor = startGx;
      n.graceNotes.forEach((gn, gi) => {
        const width = geometry.graceWidths[gi];
        const gx = graceCursor + width / 2;
        graceCursor += width + 4;
        const gy = -10;
        // 小数字
        group.appendChild(el("text", {
          x: gx,
          y: gy,
          "text-anchor": "middle",
          "dominant-baseline": "middle",
          "font-size": 13,
          "font-weight": 600,
          class: "grace-note",
        }, (gn.accidental ?? "") + gn.note));
        // 倚音八度点
        for (let octave = 0; octave < Math.abs(gn.octave); octave++) {
          const gOctY = gn.octave > 0 ? gy - 10 - octave * 4 : gy + 14 + octave * 4;
          group.appendChild(el("circle", { cx: gx, cy: gOctY, r: 1.3, fill: "currentColor" }));
        }
        if (gn.mordent) {
          const waveY = gy - 14 - Math.max(0, gn.octave) * 4;
          group.appendChild(el("path", {
            d: `M ${gx - 5} ${waveY + 2} l 2 -3 l 2 3 l 2 -3 l 2 3 l 2 -3`,
            stroke: "currentColor", "stroke-width": 1.1, fill: "none",
            class: "grace-mordent", "aria-label": "倚音波音",
          }));
        }
        // 倚音下方的双微型减时线
        group.appendChild(el("line", { x1: gx - 4, y1: gy + 7, x2: gx + 4, y2: gy + 7, stroke: "currentColor", "stroke-width": 0.9 }));
        group.appendChild(el("line", { x1: gx - 4, y1: gy + 9.5, x2: gx + 4, y2: gy + 9.5, stroke: "currentColor", "stroke-width": 0.9 }));
      });
      // 倚音到主音的小连弧线
      const arcEndX = mainX - geometry.digitWidth / 2;
      group.appendChild(el("path", {
        d: `M ${startGx} -3 Q ${startGx + 4} 2 ${arcEndX} -2`,
        stroke: "currentColor", fill: "none", "stroke-width": 0.9,
      }));
    }

    if (n.postGraceNotes?.length) {
      let postX = mainX + geometry.digitWidth / 2 + (n.dotted ? 12 : 6);
      n.postGraceNotes.forEach(gn => {
        const width = Math.max(8, textWidth((gn.accidental ?? "") + gn.note, 13, GRACE_FONT, 600));
        const gx = postX + width / 2;
        group.appendChild(el("text", { x: gx, y: -10, "text-anchor": "middle", "dominant-baseline": "middle",
          "font-size": 13, class: "post-grace-note" }, (gn.accidental ?? "") + gn.note));
        for (let octave = 0; octave < Math.abs(gn.octave); octave++) {
          group.appendChild(el("circle", { cx: gx, cy: gn.octave > 0 ? -20 - octave * 4 : 4 + octave * 4, r: 1.3, fill: "currentColor" }));
        }
        group.appendChild(el("line", { x1: gx - 4, x2: gx + 4, y1: -3, y2: -3, stroke: "currentColor", "stroke-width": 0.9 }));
        group.appendChild(el("line", { x1: gx - 4, x2: gx + 4, y1: -0.5, y2: -0.5, stroke: "currentColor", "stroke-width": 0.9 }));
        postX += width + 4;
      });
    }
    // 升降号
    let accX = mainX - geometry.digitWidth / 2 - geometry.accidentalWidth;
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
      x: mainX,
      y: 0,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-size": LAYOUT.fontSize,
      "font-weight": 600,
      "font-family": "'PingFang SC', 'MiSans', -apple-system, sans-serif",
    }, n.note));
  }
  // 附点
  if (n.dotted) {
    group.appendChild(el("circle", { cx: mainX + geometry.digitWidth / 2 + 5, cy: 5, r: LAYOUT.dotR, fill: "currentColor" }));
  }
  // 八度点：若有减时线，下八度点必须排在所有减时线下方！
  const dir = n.octave > 0 ? -1 : 1;
  const y0 = n.octave > 0
    ? LAYOUT.dotAboveY
    : (n.underline > 0 ? LAYOUT.underlineY0 + n.underline * LAYOUT.underlineStep + 4 : LAYOUT.dotBelowY);
  for (let i = 0; i < Math.abs(n.octave); i += 1) {
    group.appendChild(el("circle", { cx: mainX, cy: y0 + dir * LAYOUT.dotStep * i, r: LAYOUT.dotR, fill: "currentColor" }));
  }

  // 民族管乐专属技巧记号渲染 (tr 颤音 / ↗ 上滑音 / ↘ 下滑音 / T/K 吐音 / ~ 波音 / fl 花舌 / vib 气震音)
  const tech = n.technique;
  let techTopY = n.octave > 0 ? LAYOUT.dotAboveY - LAYOUT.dotStep * (n.octave - 1) - 12 : -18;

  if (tech) {
    if (tech.trill) {
      group.appendChild(el("text", {
        x: mainX,
        y: techTopY,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 13,
        "font-weight": 700,
        "font-style": "italic",
        class: "wind-tech-trill",
      }, "tr"));
      techTopY -= 12;
    }
    if (tech.mordent) {
      // 波音用矢量折线，避免文字w在不同字体下变成普通字母。
      const wave = el("path", {
        d: `M ${mainX - 8} ${techTopY + 2} l 3 -5 l 4 5 l 4 -5 l 4 5 l 3 -5`,
        stroke: "currentColor", "stroke-width": 1.6, fill: "none",
        "stroke-linejoin": "miter", class: "wind-tech-mordent", "aria-label": "波音",
      });
      group.appendChild(wave);
      techTopY -= 11;
    }
    if (tech.appoggiatura) {
      // 辅助图例中的叠音为上下横帽相连的沙漏形，不使用依赖字体的星号。
      group.appendChild(el("path", {
        d: `M ${mainX - 4} ${techTopY - 3} H ${mainX + 4} L ${mainX - 4} ${techTopY + 3} H ${mainX + 4} Z`,
        stroke: "currentColor", "stroke-width": 1.2, fill: "none",
        class: "wind-tech-appoggiatura", "aria-label": "叠音",
      }));
      techTopY -= 11;
    }
    if (tech.accent) {
      group.appendChild(el("text", {
        x: mainX,
        y: techTopY,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 14,
        "font-weight": 700,
        class: "wind-tech-accent",
      }, ">"));
      techTopY -= 11;
    }
    if (tech.tonguing) {
      group.appendChild(el("text", {
        x: mainX,
        y: techTopY,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 11,
        "font-weight": 700,
        class: "wind-tech-tonguing",
      }, tech.tonguing));
      techTopY -= 10;
    }
    if (tech.fingerStrike) {
      group.appendChild(el("path", {
        d: `M ${mainX - 3} ${techTopY - 3} H ${mainX + 3} M ${mainX} ${techTopY - 3} V ${techTopY + 3}`,
        stroke: "currentColor", "stroke-width": 1.3, fill: "none",
        class: "wind-tech-finger-strike", "aria-label": "打音",
      }));
      techTopY -= 10;
    }
    if (tech.breath) {
      group.appendChild(el("text", {
        x: mainX + g.core / 2 + 6,
        y: -16,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 12,
        "font-style": "italic",
        class: "wind-tech-breath",
      }, "v"));
    }
    if (tech.slideUp) {
      group.appendChild(el("text", {
        x: mainX + g.core / 2 - 2,
        y: -12,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 14,
        class: "wind-tech-slide-up",
      }, "↗"));
    }
    if (tech.slideDown) {
      group.appendChild(el("text", {
        x: mainX + g.core / 2 - 2,
        y: -4,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 14,
        class: "wind-tech-slide-down",
      }, "↘"));
    }
    if (tech.flutter) {
      group.appendChild(el("text", {
        x: mainX,
        y: techTopY,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 11,
        "font-style": "italic",
      }, "fl"));
      techTopY -= 10;
    }
    if (tech.vibrato) {
      group.appendChild(el("text", {
        x: mainX,
        y: techTopY,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 13,
      }, "〰"));
      techTopY -= 10;
    }
    if (tech.harmonic) {
      group.appendChild(el("circle", {
        cx: mainX, cy: techTopY, r: 2.5,
        stroke: "currentColor", "stroke-width": 1.2, fill: "none",
        class: "wind-tech-harmonic", "aria-label": "泛音",
      }));
      techTopY -= 10;
    }
  }

  // 顶部装饰记号（自由文本或常见音符表情记号：如 ▾ 顿音/跳音、⌒ 保持音、𝄐 延长记号等）
  if (n.topDecorators && n.topDecorators.length > 0) {
    n.topDecorators.forEach((dec, idx) => {
      group.appendChild(el("text", {
        x: mainX,
        y: techTopY - idx * 12,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": 13,
        class: "top-decorator",
      }, dec));
    });
  }
  // 独立减时线（连排横线由段落层连线绘制，未连排则画独立横线）
  if (n.underline > 0) {
    const underX1 = mainX - geometry.digitWidth / 2;
    const underX2 = mainX + geometry.digitWidth / 2;
    for (let i = 0; i < n.underline; i += 1) {
      group.appendChild(el("line", {
        x1: underX1, x2: underX2,
        y1: LAYOUT.underlineY0 + i * LAYOUT.underlineStep,
        y2: LAYOUT.underlineY0 + i * LAYOUT.underlineStep,
        stroke: "currentColor", "stroke-width": 1.6,
        "stroke-linecap": "round",
        class: `underline-line underline-layer-${i}`,
      }));
    }
  }
  if (n.dynamic) {
    const bottom = n.octave < 0 ? y0 + (Math.abs(n.octave) - 1) * LAYOUT.dotStep + 14 :
      Math.max(20, LAYOUT.underlineY0 + n.underline * LAYOUT.underlineStep + 10);
    group.appendChild(el("text", { x: mainX, y: bottom + 12,
      "text-anchor": "middle", "font-size": 15, "font-style": "italic", "font-weight": 700,
      class: "dynamic-mark" }, n.dynamic));
  }
  return group;
}

/** 渲染单个标准 A4 页面卡片 SVG */
export function renderPageSvg(
  page: ScorePage,
  totalPages: number,
  score: Score,
  selectedKey: string | null = null,
  cursorPos: { paragraph: number; itemIndex: number } | null = null
): SVGSVGElement {
  const svg = el("svg", {
    viewBox: `0 0 ${A4_PAGE.width} ${A4_PAGE.height}`,
    width: "100%",
    class: "score-svg a4-page-card",
    xmlns: "http://www.w3.org/2000/svg",
  });

  // 第一页绘制完整曲名大标题与调号作者
  if (page.pageIndex === 0) {
    svg.appendChild(el("text", {
      x: A4_PAGE.width / 2, y: 46,
      "text-anchor": "middle", "font-size": 26, "font-weight": 700,
      class: "score-main-title",
    }, score.title));

    const header = `1 = ${score.tone}    ${score.beat[0]}/${score.beat[1]}    ♩= ${score.speed}`;
    let yHeader = 84;
    const hasLongHeader = score.authors.join("  ").length > 20;
    if (hasLongHeader) {
      // 作者说明较长时，调号居左，作者换下一行或紧跟排列
      svg.appendChild(el("text", {
        x: A4_PAGE.marginLeft, y: 78,
        "font-size": LAYOUT.headerFontSize,
        fill: "var(--bloom-text-muted, #727a80)",
      }, header));

      svg.appendChild(el("text", {
        x: A4_PAGE.width - A4_PAGE.marginRight, y: 78,
        "text-anchor": "end",
        "font-size": LAYOUT.headerFontSize,
        fill: "var(--bloom-text-muted, #727a80)",
      }, score.authors.join("  ")));
    } else {
      svg.appendChild(el("text", {
        x: A4_PAGE.marginLeft, y: yHeader,
        "font-size": LAYOUT.headerFontSize,
        fill: "var(--bloom-text-muted, #727a80)",
      }, header));

      svg.appendChild(el("text", {
        x: A4_PAGE.width - A4_PAGE.marginRight, y: yHeader,
        "text-anchor": "end",
        "font-size": LAYOUT.headerFontSize,
        fill: "var(--bloom-text-muted, #727a80)",
      }, score.authors.join("  ")));
    }
  } else {
    // 后续页简略页眉：微型曲名居中
    svg.appendChild(el("text", {
      x: A4_PAGE.width / 2, y: 36,
      "text-anchor": "middle", "font-size": 13, fill: "var(--bloom-text-muted, #999)",
      "letter-spacing": "1px",
    }, `— ${score.title} —`));
  }

  // 页脚页码：第 X 页 / 共 Y 页
  svg.appendChild(el("text", {
    x: A4_PAGE.width / 2, y: A4_PAGE.footerY,
    "text-anchor": "middle", "font-size": 12, fill: "var(--bloom-text-muted, #888)",
  }, `第 ${page.pageIndex + 1} 页 / 共 ${totalPages} 页`));

  let yOffset = page.pageIndex === 0 ? 128 : A4_PAGE.marginTop;
  const contentWidth = A4_PAGE.width - A4_PAGE.marginLeft - A4_PAGE.marginRight;
  const notations = score.paragraphs.flatMap(paragraph => paragraph.notations);
  const notationOrder = new Map(notations.map((notation, index) => [notation.key, index]));
  const spans = score.paragraphs.flatMap(paragraph => paragraph.spans ?? []);

  for (const r of page.rows) {
    const para = score.paragraphs[r.paraIndex];
    if (!para) continue;
    const rowGlyphs = r.rowGlyphs;
    const totalWidth = rowGlyphs.reduce((s, g) => s + g.width, 0);

    const shouldJustify = r.alignJustify && rowGlyphs.length > 1 && totalWidth < contentWidth &&
      (!r.isLastRowOfPara || totalWidth >= contentWidth * 0.65);
    const flex = shouldJustify ? (contentWidth - totalWidth) / (rowGlyphs.length - 1) : 0;

    let x = A4_PAGE.marginLeft;
    const sectionLabel = r.rowInPara === 0
      ? [para.heading, para.freeTime ? "散板" : para.meter?.join("/")].filter(Boolean).join(" · ")
      : "";
    const headingSpace = r.headingSpace ?? (sectionLabel ? 30 : 0);
    if (sectionLabel) {
      svg.appendChild(el("text", {
        x: A4_PAGE.marginLeft, y: yOffset - 22,
        "font-size": 15, "font-weight": 600, class: "section-heading",
      }, sectionLabel));
    }
    const row = el("g", { class: "paragraph", "data-para": String(r.paraIndex), transform: `translate(0, ${yOffset + headingSpace + (r.topExtra ?? 0)})` });

    if (cursorPos && cursorPos.paragraph === r.paraIndex && cursorPos.itemIndex === 0 && r.rowInPara === 0) {
      row.appendChild(el("line", {
        x1: A4_PAGE.marginLeft - 2, y1: -20, x2: A4_PAGE.marginLeft - 2, y2: 20,
        stroke: "var(--accent, #ea580c)", "stroke-width": 2, class: "editor-caret",
      }));
    }

    let soundingIdx = para.lyrics.length ? countSoundingBefore(score, para, rowGlyphs[0]?.n.key ?? "") : 0;
    const tieFrom = new Map<string, Notation>();
    para.notations.forEach((n, i) => {
      if (!n.tieTo) return;
      const j = para.notations.findIndex(o => o.key === n.tieTo);
      if (j > i) tieFrom.set(para.notations[j].key, n);
    });

    rowGlyphs.forEach((g) => {
      const cx = x + g.width / 2;
      const from = tieFrom.get(g.n.key);
      if (from) {
        const fromGlyph = rowGlyphs.find(gg => gg.n.key === from.key);
        const toCx = cx - A4_PAGE.marginLeft;
        const arc = tieArc(rowGlyphs.map(gg => gg.width), fromGlyph ? rowGlyphs.indexOf(fromGlyph) : -1, flex, toCx);
        if (arc) {
          row.appendChild(el("path", {
            d: arc,
            stroke: "currentColor", fill: "none", "stroke-width": 1.2, class: "tie",
          }));
        }
      }

      const glyph = renderGlyph(g, cx, 0, g.n.key === selectedKey);
      const noteIdx = para.notations.indexOf(g.n);
      glyph.setAttribute("data-idx", String(noteIdx));
      if (isPitchable(g.n) || g.n.note === EXTEND) {
        glyph.setAttribute("data-sounding", String(countSoundingIdx(para, g.n)));
      }
      row.appendChild(glyph);

      if (cursorPos && cursorPos.paragraph === r.paraIndex && cursorPos.itemIndex === noteIdx + 1) {
        const caretX = cx + g.width / 2;
        row.appendChild(el("line", {
          x1: caretX, y1: -20, x2: caretX, y2: 20,
          stroke: "var(--accent, #ea580c)", "stroke-width": 2, class: "editor-caret",
        }));
      }

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

    // 三连音括弧排版
    let tIdx = 0;
    while (tIdx <= rowGlyphs.length - 3) {
      const isTri = (gg: typeof rowGlyphs[0]) =>
        isPitchable(gg.n) && gg.n.beatFrac !== undefined && Math.abs(gg.n.beatFrac - 1 / 3) < 0.01;
      if (isTri(rowGlyphs[tIdx]) && isTri(rowGlyphs[tIdx + 1]) && isTri(rowGlyphs[tIdx + 2])) {
        const maxOct = Math.max(
          rowGlyphs[tIdx].n.octave,
          rowGlyphs[tIdx + 1].n.octave,
          rowGlyphs[tIdx + 2].n.octave
        );
        const topY = maxOct > 0 ? -24 - maxOct * LAYOUT.dotStep - 4 : -24;
        const c0 = rowCenterX(rowGlyphs.map(gg => gg.width), tIdx, flex);
        const c2 = rowCenterX(rowGlyphs.map(gg => gg.width), tIdx + 2, flex);
        const { pathD, midX, textY } = tupletBracketD(c0, c2, topY);

        row.appendChild(el("path", {
          d: pathD,
          stroke: "currentColor", fill: "none", "stroke-width": 1.1, class: "tuplet-bracket",
        }));
        row.appendChild(el("text", {
          x: midX,
          y: textY,
          "text-anchor": "middle",
          "dominant-baseline": "middle",
          "font-size": 11,
          "font-style": "italic",
          "font-family": "Times New Roman, serif",
          class: "tuplet-number",
        }, "3"));
        tIdx += 3;
      } else {
        tIdx += 1;
      }
    }

    if (spans.length) {
      const positions = new Map<string, { x: number; top: number; bottom: number }>();
      rowGlyphs.forEach((g, index) => {
        positions.set(g.n.key, {
          x: A4_PAGE.marginLeft + rowCenterX(rowGlyphs.map(item => item.width), index, flex),
          ...spanGlyphBounds(g.n, para.lyrics.length > 0),
        });
      });
      // 全谱顺序与当前视觉行求交，传入同一批跨度以保留同行避让通道。
      const visibleSpans = spans.flatMap(span => {
        const start = notationOrder.get(span.startKey);
        const end = notationOrder.get(span.endKey);
        if (!rowGlyphs.length || start === undefined || end === undefined || start === end) return [];
        const first = notationOrder.get(rowGlyphs[0].n.key)!;
        const last = notationOrder.get(rowGlyphs[rowGlyphs.length - 1].n.key)!;
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        const left = Math.max(low, first);
        const right = Math.min(high, last);
        if (left > right) return [];
        let startKey = notations[left].key;
        let endKey = notations[right].key;
        // 单音交集也有续接段：使用稳定的行边界锚点，避免零宽跨度消失。
        if (left === right) {
          const position = positions.get(startKey)!;
          const glyph = rowGlyphs.find(g => g.n.key === startKey)!;
          if (low < first) {
            startKey += ":span-before";
            positions.set(startKey, { ...position, x: position.x - glyph.width / 2 });
          }
          if (high > last) {
            endKey += ":span-after";
            positions.set(endKey, { ...position, x: position.x + glyph.width / 2 });
          }
        }
        return [{ ...span, startKey, endKey }];
      });
      renderMusicSpans(row, visibleSpans, positions);
    }
    svg.appendChild(row);
    if (r.isLastRowOfPara) {
      const layers = para.cueLayers ?? [];
      const cueHeight = INLINE_CUE.svgHeight + INLINE_CUE.metadataHeight;
      let cueY = yOffset + r.rowHeight - layers.length * cueHeight;
      for (const layer of layers) {
        const host = document.createElement("div");
        renderCueLayer(host, layer);
        const cueSvg = host.querySelector("svg");
        if (!cueSvg) throw new Error(`提示声部未生成 SVG：${layer.label}`);
        svg.appendChild(el("text", {
          x: A4_PAGE.marginLeft, y: cueY + 15,
          "font-size": 12, class: "cue-metadata", "data-para": r.paraIndex,
        }, `${layer.label || "提示声部"} · 起始拍 ${layer.startBeat}`));
        cueSvg.setAttribute("x", String(A4_PAGE.marginLeft));
        cueSvg.setAttribute("y", String(cueY + INLINE_CUE.metadataHeight));
        cueSvg.setAttribute("width", String(contentWidth));
        cueSvg.setAttribute("height", String(INLINE_CUE.svgHeight));
        cueSvg.setAttribute("preserveAspectRatio", "xMinYMin meet");
        cueSvg.setAttribute("data-para", String(r.paraIndex));
        // 独立渲染器的 auto 高度适用于 HTML；嵌入 A4 后使用分页预留的固定视口。
        cueSvg.style.removeProperty("height");
        svg.appendChild(cueSvg);
        cueY += cueHeight;
      }
    }
    yOffset += r.rowHeight;
  }

  return svg;
}

/** 渲染全部多页乐谱为独立 SVG 列表（供多页打印、多页导出用） */
export function renderScorePagesSvgs(
  score: Score,
  selectedKey: string | null = null,
  cursorPos: { paragraph: number; itemIndex: number } | null = null
): SVGSVGElement[] {
  const pages = paginateScore(score, measureGlyph);
  if (score.paragraphs.every(p => p.notations.length === 0 && !p.cueLayers?.length)) {
    return [renderScoreSvg(score, selectedKey, cursorPos)];
  }
  return pages.map(p => renderPageSvg(p, pages.length, score, selectedKey, cursorPos));
}
export function renderScorePages(
  container: HTMLElement,
  score: Score,
  selectedKey: string | null = null,
  cursorPos: { paragraph: number; itemIndex: number } | null = null
): SVGSVGElement[] {
  const pages = paginateScore(score, measureGlyph);
  container.innerHTML = "";
  const svgs: SVGSVGElement[] = [];

  if (score.paragraphs.every(p => p.notations.length === 0 && !p.cueLayers?.length)) {
    // 空谱单卡提示
    const singleSvg = renderScoreSvg(score, selectedKey, cursorPos);
    container.appendChild(singleSvg);
    return [singleSvg];
  }

  pages.forEach(p => {
    const pageCard = document.createElement("div");
    pageCard.className = "page-card-wrapper";
    const svg = renderPageSvg(p, pages.length, score, selectedKey, cursorPos);
    pageCard.appendChild(svg);
    container.appendChild(pageCard);
    svgs.push(svg);
  });

  return svgs;
}

/** 渲染为独立 SVG 元素（画布与打印导出共用） */
export function renderScoreSvg(
  score: Score,
  selectedKey: string | null = null,
  cursorPos: { paragraph: number; itemIndex: number } | null = null
): SVGSVGElement {
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
    fill: "var(--bloom-text-muted, #727a80)",
  }, header));
  // 作者行（右对齐）
  svg.appendChild(el("text", {
    x: pageWidth - LAYOUT.pageMarginX, y: 74,
    "text-anchor": "end",
    "font-size": LAYOUT.headerFontSize,
    fill: "var(--bloom-text-muted, #727a80)",
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
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const rowGlyphs = rows[rIdx];
      const isLastRowOfPara = rIdx === rows.length - 1;
      const totalWidth = rowGlyphs.reduce((s, g) => s + g.width, 0);
      // 排版美学：如果最后一行内容较少（不足满行宽度的 65%），则不对其强行两端拉伸，避免两三个音符被扯到两端
      const shouldJustify = para.alignJustify && rowGlyphs.length > 1 && totalWidth < contentWidth &&
        (!isLastRowOfPara || totalWidth >= contentWidth * 0.65);
      const flex = shouldJustify ? (contentWidth - totalWidth) / (rowGlyphs.length - 1) : 0;
      let x = LAYOUT.pageMarginX;
      const row = el("g", { class: "paragraph", "data-para": String(paraNo), transform: `translate(0, ${yOffset})` });
      // 如果光标在行首 (itemIndex=0)
      if (cursorPos && cursorPos.paragraph === paraNo && cursorPos.itemIndex === 0 && rIdx === 0) {
        row.appendChild(el("line", {
          x1: LAYOUT.pageMarginX - 2, y1: -20, x2: LAYOUT.pageMarginX - 2, y2: 20,
          stroke: "var(--accent, #ea580c)", "stroke-width": 2, class: "editor-caret",
        }));
      }
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

        // 编辑光标闪烁光标竖线 (Caret indicator)
        if (cursorPos && cursorPos.paragraph === paraNo && cursorPos.itemIndex === (orderIdx.get(g.n) ?? -1) + 1) {
          const caretX = cx + g.width / 2;
          row.appendChild(el("line", {
            x1: caretX, y1: -20, x2: caretX, y2: 20,
            stroke: "var(--accent, #ea580c)", "stroke-width": 2, class: "editor-caret",
          }));
        }

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

      // 三连音 (Tuplet) 顶部弧线与数字 "3" 自动绘制
      // 扫描行内连续且 beatFrac 接近 1/3 (0.3333) 的 3 个音符组
      let tIdx = 0;
      while (tIdx <= rowGlyphs.length - 3) {
        const isTri = (gg: typeof rowGlyphs[0]) =>
          isPitchable(gg.n) && gg.n.beatFrac !== undefined && Math.abs(gg.n.beatFrac - 1 / 3) < 0.01;
        if (isTri(rowGlyphs[tIdx]) && isTri(rowGlyphs[tIdx + 1]) && isTri(rowGlyphs[tIdx + 2])) {
          // 避让高音点与装饰记号：如果三连音内含有高音点，将括弧抬高
          const maxOct = Math.max(
            rowGlyphs[tIdx].n.octave,
            rowGlyphs[tIdx + 1].n.octave,
            rowGlyphs[tIdx + 2].n.octave
          );
          const topY = maxOct > 0 ? -24 - maxOct * LAYOUT.dotStep - 4 : -24;

          // 计算这 3 个音符在行内的中心 x 坐标
          const c0 = rowCenterX(rowGlyphs.map(gg => gg.width), tIdx, flex);
          const c2 = rowCenterX(rowGlyphs.map(gg => gg.width), tIdx + 2, flex);
          const { pathD, midX, textY } = tupletBracketD(c0, c2, topY);

          // 绘制平滑三连音跨弧 (浅弧线从 c0 上方连到 c2 上方，居中开口或上凸)
          row.appendChild(el("path", {
            d: pathD,
            stroke: "currentColor", fill: "none", "stroke-width": 1.1, class: "tuplet-bracket",
          }));
          row.appendChild(el("text", {
            x: midX,
            y: textY,
            "text-anchor": "middle",
            "dominant-baseline": "middle",
            "font-size": 11,
            "font-style": "italic",
            "font-family": "Times New Roman, serif",
            class: "tuplet-number",
          }, "3"));

          tIdx += 3;
        } else {
          tIdx += 1;
        }
      }

      svg.appendChild(row);
      // 有歌词的行增加行高间距，防止歌词与下一行的低音点或音符重叠拥挤
      const rowHasLyrics = para.lyrics.length > 0;
      yOffset += rowHasLyrics ? LAYOUT.lineHeight + 16 : LAYOUT.lineHeight;
    }
  }
  if (score.paragraphs.every((p) => p.notations.length === 0)) {
    // 空谱引导：新用户第一眼知道从哪开始（点击/按键不产生数据，仅提示）
    svg.appendChild(el("text", {
      x: pageWidth / 2, y: yOffset + 48,
      "text-anchor": "middle", "font-size": 15, fill: "var(--bloom-text-muted, #8e959b)",
    }, "直接按 1–7 输入音符 · 支持拖拽 .json / .mid 到画布导入 · 或粘贴简谱 (⌘V)"));
    yOffset += 64;
  }
  svg.setAttribute("viewBox", `0 0 ${pageWidth} ${yOffset + 40}`);
  return svg;
}

/** 计算三连音括弧 path 坐标；抽成纯函数以便跨环境单测 */
export function tupletBracketD(c0: number, c2: number, topY = -24): { pathD: string; midX: number; textY: number } {
  const midX = (c0 + c2) / 2;
  return {
    pathD: `M ${c0} ${topY + 3} Q ${c0} ${topY} ${c0 + 5} ${topY} L ${midX - 7} ${topY} M ${midX + 7} ${topY} L ${c2 - 5} ${topY} Q ${c2} ${topY} ${c2} ${topY + 3}`,
    midX,
    textY: topY + 3,
  };
}
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
