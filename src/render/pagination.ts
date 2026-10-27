/**
 * 多页 A4 排版数据结构与纯函数算法
 * 标准 A4 纵向像素规格：宽 860px，高 1216px (约 1 : 1.414 标准比率)
 * 具备页眉（曲名、调号）、页脚（页码 第 X 页 / 共 Y 页）与自动跨页溢出折行
 */
import type { Notation, Score } from "../core/model.ts";
import { BAR, DOUBLE_BAR, REPEAT_START, REPEAT_END } from "../core/model.ts";
import { wrapRows } from "./layout.ts";

export const A4_PAGE = {
  width: 860,
  height: 1216,
  marginTop: 90,
  marginBottom: 80,
  marginLeft: 48,
  marginRight: 48,
  headerY: 45,
  footerY: 1165,
  defaultRowHeight: 74,
  lyricRowHeight: 96,
  techRowExtraHeight: 18,
} as const;

/** 内嵌提示声部固定视口；分页与 SVG 绘制共享占位，保持内容等比缩放。 */
export const INLINE_CUE = { svgHeight: 140, metadataHeight: 22 } as const;

export interface LayoutRow {
  paraIndex: number;
  rowInPara: number;
  rowGlyphs: { n: Notation; width: number; core: number }[];
  rowHeight: number;
  isLastRowOfPara: boolean;
  alignJustify: boolean;
  lyrics: string[];
}

export interface ScorePage {
  pageIndex: number; // 0-based
  rows: LayoutRow[];
  totalHeight: number;
}

/** 估算行高度：综合低音点、高音点、倚音、技巧标记与歌词，防止行与行垂直碰撞 */
export function estimateRowHeight(glyphs: { n: Notation }[], hasLyrics: boolean): number {
  let baseH = hasLyrics ? A4_PAGE.lyricRowHeight : A4_PAGE.defaultRowHeight;
  let maxTechExtra = 0;
  for (const g of glyphs) {
    const n = g.n;
    if (n.technique && Object.keys(n.technique).length > 0) maxTechExtra = Math.max(maxTechExtra, 16);
    if (n.graceNotes && n.graceNotes.length > 0) maxTechExtra = Math.max(maxTechExtra, 14);
    if (n.octave > 1) maxTechExtra = Math.max(maxTechExtra, (n.octave - 1) * 8);
    if (n.octave < -1) maxTechExtra = Math.max(maxTechExtra, (-n.octave - 1) * 8);
    if (n.volta) maxTechExtra = Math.max(maxTechExtra, 16);
  }
  return baseH + maxTechExtra;
}

/**
 * 将整篇乐谱符号流先切分为视觉行，再将视觉行分页打包为多个标准 A4 页面卡片
 */
export function paginateScore<G extends { n: Notation; width: number; core: number }>(
  score: Score,
  measureWidthFn: (n: Notation) => G
): ScorePage[] {
  const contentWidth = A4_PAGE.width - A4_PAGE.marginLeft - A4_PAGE.marginRight;
  const allRows: LayoutRow[] = [];

  score.paragraphs.forEach((para, paraIndex) => {
    const glyphs: G[] = para.notations.map(measureWidthFn);
    const splitRows: G[][] = wrapRows(
      glyphs,
      contentWidth,
      (g) => g.width,
      (g) => g.n.note === BAR || g.n.note === DOUBLE_BAR || g.n.note === REPEAT_START || g.n.note === REPEAT_END
    );

    // 只有提示声部的段落也保留一个锚点行，避免空正文吞掉提示内容。
    if (!splitRows.length && para.cueLayers?.length) splitRows.push([]);
    const hasLyrics = para.lyrics.length > 0;
    splitRows.forEach((rowGlyphs, rowInPara) => {
      const isLastRowOfPara = rowInPara === splitRows.length - 1;
      const rowHeight = estimateRowHeight(rowGlyphs, hasLyrics) +
        (rowInPara === 0 && (para.heading || para.meter || para.freeTime)
          ? 30 + Math.min(100, (para.spans?.filter(s => !["crescendo", "diminuendo"].includes(s.kind)).length ?? 0) * 14) : 0) +
        Math.min(120, (para.spans?.length ?? 0) * 18) +
        (isLastRowOfPara ? (para.cueLayers?.length ?? 0) * (INLINE_CUE.svgHeight + INLINE_CUE.metadataHeight) : 0);
      allRows.push({
        paraIndex,
        rowInPara,
        rowGlyphs: rowGlyphs as any,
        rowHeight,
        isLastRowOfPara,
        alignJustify: para.alignJustify,
        lyrics: para.lyrics,
      });
    });
  });

  // 分页：第一页顶部有标题与调号，可用高度相对较小；后续页可用高度更大
  const firstPageMaxHeight = A4_PAGE.height - A4_PAGE.marginTop - A4_PAGE.marginBottom - 40;
  const otherPageMaxHeight = A4_PAGE.height - A4_PAGE.marginTop - A4_PAGE.marginBottom;

  const pages: ScorePage[] = [];
  let curPageRows: LayoutRow[] = [];
  let curPageHeight = 0;

  for (const r of allRows) {
    const isFirstPage = pages.length === 0;
    const maxH = isFirstPage ? firstPageMaxHeight : otherPageMaxHeight;

    if (curPageRows.length > 0 && curPageHeight + r.rowHeight > maxH) {
      pages.push({
        pageIndex: pages.length,
        rows: curPageRows,
        totalHeight: curPageHeight,
      });
      curPageRows = [r];
      curPageHeight = r.rowHeight;
    } else {
      curPageRows.push(r);
      curPageHeight += r.rowHeight;
    }
  }

  if (curPageRows.length > 0 || pages.length === 0) {
    pages.push({
      pageIndex: pages.length,
      rows: curPageRows,
      totalHeight: curPageHeight,
    });
  }

  return pages;
}
