/**
 * 乐谱行布局：按符号占用宽度换行，优先在小节线后断开，保留每个符号。
 * API：wrapRows；纯函数供 SVG 渲染与布局回归测试共用。
 */

/** 按宽度排成视觉行；超长小节按符号拆分，单个超宽符号独占一行。 */
export function wrapRows<T>(
  items: readonly T[],
  maxWidth: number,
  widthOf: (item: T) => number,
  breakAfter: (item: T) => boolean,
): T[][] {
  const rows: T[][] = [];
  let row: T[] = [];
  let width = 0;
  for (const item of items) {
    while (row.length && width + widthOf(item) > maxWidth) {
      let split = row.length;
      for (let i = row.length - 1; i >= 0; i -= 1) {
        if (breakAfter(row[i])) {
          split = i + 1;
          break;
        }
      }
      rows.push(row.slice(0, split));
      row = row.slice(split);
      width = row.reduce((sum, entry) => sum + widthOf(entry), 0);
    }
    row.push(item);
    width += widthOf(item);
  }
  if (row.length) rows.push(row);
  return rows;
}
