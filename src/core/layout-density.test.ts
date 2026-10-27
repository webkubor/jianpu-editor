/**
 * 行密度回归：只按可见跨度避让预留高度，验证预览与导出共用分页和基线。
 * 路由：编辑器 A4 预览/导出；无后端 API。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNote, createParagraph, createScore, type MusicSpan, type Notation } from "./model.ts";
import { A4_PAGE, INLINE_CUE, paginateScore, spanGlyphBounds } from "../render/pagination.ts";
import { renderScorePages, renderScorePagesSvgs } from "../render/svg-render.ts";
import { createMuminDraft } from "./mumin-draft.ts";

const measure = (n: Notation) => ({ n, width: 40, core: 16 });
function fixture(spans: MusicSpan[]) {
  return createScore({ paragraphs: [{ ...createParagraph(Array.from({ length: 16 }, (_, i) => createNote({ key: `n${i}` }))),
    alignJustify: false, heading: "乐段", spans }] });
}
const arc = (start: number, end: number, kind: MusicSpan["kind"] = "slur"): MusicSpan =>
  ({ kind, startKey: `n${start}`, endKey: `n${end}` });
const rows = (score: ReturnType<typeof createScore>) => paginateScore(score, measure).flatMap(page => page.rows);

test("disjoint arcs share padding while nested/shared-anchor arcs reserve separate lanes", () => {
  const disjoint = rows(fixture([arc(0, 2), arc(4, 6), arc(8, 10)]))[0];
  const nested = rows(fixture([arc(0, 10), arc(2, 8), arc(4, 6)]))[0];
  const shared = rows(fixture([arc(0, 2), arc(2, 4), arc(4, 6)]))[0];
  assert.equal(disjoint.headingSpace, 30);
  assert.equal(nested.headingSpace, disjoint.headingSpace);
  assert.equal(nested.topExtra! - disjoint.topExtra!, 60);
  assert.equal(shared.topExtra, nested.topExtra, "touching anchors must retain safe separation");
  assert.equal(nested.rowHeight - disjoint.rowHeight, 60);
  assert.equal(rows(fixture([arc(0, 2, "crescendo"), arc(4, 6, "diminuendo")]))[0].bottomExtra, 22);
  assert.equal(rows(fixture([arc(0, 10, "crescendo"), arc(2, 8, "diminuendo")]))[0].bottomExtra, 44);
});

test("only visible row intersections reserve lanes, including reversed global endpoints", () => {
  const score = fixture([arc(0, 2)]);
  score.paragraphs[0].notations.push(...Array.from({ length: 24 }, (_, i) => createNote({ key: `n${i + 16}` })));
  const local = rows(score);
  assert.ok(local[0].topExtra! > 0);
  assert.equal(local[1].topExtra, 0);
  assert.equal(local[1].headingSpace, 0);
  score.paragraphs.push({ ...createParagraph([createNote({ key: "end" })]),
    spans: [{ kind: "slur", startKey: "end", endKey: "n0" }] });
  const continued = rows(score);
  assert.ok(continued.every(row => row.topExtra! > 0), "incoming and singleton intersections reserve space");
});

test("decoration stacks use row maximum and cue viewport reserve stays on final row", () => {
  const score = fixture([]);
  const plain = rows(score)[0];
  score.paragraphs[0].notations[0].technique = { trill: true, mordent: true, tonguing: "TK" };
  score.paragraphs[0].notations[0].topDecorators = ["𝄐", "⌒"];
  const decorated = rows(score)[0];
  assert.ok(decorated.topExtra! >= 68);
  score.paragraphs[0].notations[1].technique = { trill: true };
  assert.equal(rows(score)[0].topExtra, decorated.topExtra);
  assert.ok(spanGlyphBounds(score.paragraphs[0].notations[0], false).top < -80);
  score.paragraphs[0].cueLayers = [{ label: "提示", startBeat: 0, notations: [] }];
  assert.equal(rows(score)[0].rowHeight - decorated.rowHeight, INLINE_CUE.svgHeight + INLINE_CUE.metadataHeight);
  assert.ok(decorated.rowHeight > plain.rowHeight);
});

// 最小 DOM 运行真实 SVG 路径；字体与几何裁切由 lead 的浏览器验收覆盖。
class SvgNode {
  attributes = new Map<string, string>();
  children: SvgNode[] = [];
  parent: SvgNode | null = null;
  textContent = "";
  ownerDocument = svgDocument;
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set innerHTML(_value: string) { this.children = []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  appendChild(child: SvgNode) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChild(next: SvgNode, previous: SvgNode) { this.children[this.children.indexOf(previous)] = next; next.parent = this; }
  getComputedTextLength() { return this.textContent.length * 14; }
}
const svgDocument = {
  createElementNS: (_namespace: string, tag: string) => new SvgNode(tag),
  createElement: (tag: string) => tag === "canvas"
    ? { getContext: () => ({ font: "", measureText: () => ({ width: 16 }) }) } : new SvgNode(tag),
};
const tree = (node: SvgNode): unknown => [node.tagName, [...node.attributes], node.textContent, node.children.map(tree)];

test("preview and export produce identical pages and shift every baseline by its row padding", () => {
  const original = globalThis.document;
  try {
    globalThis.document = svgDocument as unknown as Document;
    const score = fixture([arc(0, 3), arc(1, 2)]);
    score.paragraphs[0].notations.push(...Array.from({ length: 30 }, (_, i) => createNote({ key: `extra${i}` })));
    const exported = renderScorePagesSvgs(score) as unknown as SvgNode[];
    const preview = renderScorePages(new SvgNode("div") as unknown as HTMLElement, score) as unknown as SvgNode[];
    assert.deepEqual(preview.map(tree), exported.map(tree));
    const layout = paginateScore(score, n => ({ n, width: 36, core: 16 }));
    let y = 128;
    layout[0].rows.forEach((row, index) => {
      const renderedRows = exported[0].children.filter(child => child.getAttribute("class") === "paragraph");
      assert.equal(renderedRows[index].getAttribute("transform"), `translate(0, ${y + row.headingSpace! + row.topExtra!})`);
      y += row.rowHeight;
    });
  } finally { globalThis.document = original; }
});

test("Mumin row density avoids paragraph-total padding and respects page budgets", () => {
  const { score } = createMuminDraft();
  const pages = paginateScore(score, measure);
  // 曲谱不断补入图证符号，固定页数不是正确性门禁；逐行局部避让和页内预算才是约束。
  assert.ok(pages.length > 0);
  const expectedNotes = score.paragraphs.flatMap(p => p.notations).map(n => n.key);
  assert.deepEqual(pages.flatMap(p => p.rows.flatMap(row => row.rowGlyphs.map(g => g.n.key))), expectedNotes);
  for (const page of pages) {
    assert.equal(page.totalHeight, page.rows.reduce((sum, row) => sum + row.rowHeight, 0));
    assert.ok(page.totalHeight <= A4_PAGE.height - A4_PAGE.marginTop - A4_PAGE.marginBottom - (page.pageIndex === 0 ? 40 : 0));
  }
});
