/**
 * 箭头滑音跨度回归：JSON 主旋律端点、手绘箭头及上方通道避让。
 * 路由：编辑器 JSON 打开与同行 SVG 跨度；无后端 API。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNote, createParagraph, createScore, type MusicSpan } from "./model.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";
import { renderMusicSpans } from "../render/music-spans.ts";

function fixture() {
  const first = createParagraph([createNote({ key: "a", note: "7" })]);
  const last = createParagraph([createNote({ key: "b", note: "1" })]);
  first.spans = [{ kind: "slide", startKey: "a", endKey: "b" }];
  return createScore({ paragraphs: [first, last] });
}

test("slide JSON round-trips global main endpoints without pitch direction", () => {
  const score = fixture();
  assert.deepEqual(deserializeScore(serializeScore(score))?.paragraphs[0].spans, score.paragraphs[0].spans);
  score.paragraphs[0].spans = [];
  score.paragraphs[1].spans = [{ kind: "slide", startKey: "b", endKey: "a", label: "slide" }];
  assert.deepEqual(deserializeScore(serializeScore(score))?.paragraphs[1].spans, score.paragraphs[1].spans);
});

test("slide JSON rejects foreign starts, missing/cue-only ends and duplicate keys", () => {
  for (const [startKey, endKey] of [["b", "a"], ["a", "missing"], ["a", "cue"]]) {
    const score = fixture();
    score.paragraphs[0].cueLayers = [{ label: "cue", startBeat: 0, notations: [createNote({ key: "cue" })] }];
    score.paragraphs[0].spans = [{ kind: "slide", startKey, endKey }];
    assert.equal(deserializeScore(serializeScore(score)), null);
  }
  const score = fixture();
  score.paragraphs[1].notations.push(createNote({ key: "a" }));
  assert.equal(deserializeScore(serializeScore(score)), null);
});

// 最小 SVG DOM：直接执行跨度渲染器，不依赖浏览器或共享 document。
class SvgNode {
  attributes = new Map<string, string>();
  children: SvgNode[] = [];
  parent: SvgNode | null = null;
  textContent = "";
  ownerDocument = svgDocument;
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  appendChild(child: SvgNode) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChild(next: SvgNode, previous: SvgNode) {
    this.children[this.children.indexOf(previous)] = next;
    next.parent = this;
  }
  getComputedTextLength() { return this.textContent.length * 14; }
}
const svgDocument = { createElementNS: (_namespace: string, tag: string) => new SvgNode(tag) };
const positions = new Map([
  ["a", { x: 20, top: 100, bottom: 120 }],
  ["middle", { x: 80, top: 70, bottom: 125 }],
  ["b", { x: 140, top: 90, bottom: 120 }],
]);
function render(spans: MusicSpan[], row = new SvgNode("g"), points = positions) {
  renderMusicSpans(row as unknown as SVGGElement, spans, points);
  return row;
}
function descendants(node: SvgNode): SvgNode[] { return [node, ...node.children.flatMap(descendants)]; }
function numbers(path: SvgNode) {
  return (path.getAttribute("d")!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []).map(Number);
}
const slide: MusicSpan = { kind: "slide", startKey: "a", endKey: "b" };

test("slide draws an above-lane cubic curve and manual arrow at the endKey", () => {
  for (const reverse of [false, true]) {
    const span = reverse ? { ...slide, startKey: "b", endKey: "a" } : slide;
    const row = render([span]);
    const group = row.children[0].children[0];
    assert.equal(group.getAttribute("class"), "music-span music-span-slide");
    assert.equal(group.getAttribute("data-end-key"), span.endKey);
    assert.equal(group.children.length, 2);
    const [curve, arrow] = group.children;
    assert.match(curve.getAttribute("d")!, /^M .* C /);
    assert.match(arrow.getAttribute("d")!, /^M .* L .* L /);
    const c = numbers(curve);
    const a = numbers(arrow);
    assert.deepEqual(a.slice(2, 4), [reverse ? 20 : 140, c[7]], "arrow tip matches semantic endpoint");
    assert.ok(a.every(Number.isFinite));
    assert.ok(c.filter((_, index) => index % 2 === 1).every(y => y <= 62), "clears highest interior glyph");
    assert.ok(reverse ? a[0] > 20 && a[4] > 20 : a[0] < 140 && a[4] < 140);
    assert.equal(curve.getAttribute("fill"), "none");
    assert.equal(arrow.getAttribute("stroke"), "currentColor");
    assert.ok(descendants(row).every(node => node.tagName !== "defs" && node.tagName !== "marker"
      && !node.hasAttribute("id") && !node.hasAttribute("marker-end")));
  }
});

test("slide reserves at least slur height and separates overlapping above lanes", () => {
  for (const width of [1, 120, 400]) {
    const points = new Map([
      ["a", { x: 20, top: 100, bottom: 120 }],
      ["b", { x: 20 + width, top: 100, bottom: 120 }],
    ]);
    const slurCurve = numbers(render([{ ...slide, kind: "slur" }], undefined, points).children[0].children[0].children[0]);
    const slideCurve = numbers(render([slide], undefined, points).children[0].children[0].children[0]);
    assert.ok(slideCurve[1] - slideCurve[3] >= slurCurve[1] - slurCurve[3]);
  }
  const groups = render([slide, { ...slide, kind: "slur" }, { ...slide, kind: "crescendo" }]).children[0].children;
  const first = numbers(groups[0].children[0]);
  const second = numbers(groups[1].children[0]);
  assert.ok(second[1] <= first[3] - 6, "next above lane clears slide height");
  assert.ok(numbers(groups[2].children[0])[1] >= 133, "hairpin stays below glyphs");
});

test("slide rendering replaces its layer, skips invalid endpoints and does not mutate input", () => {
  const spans = [slide, { ...slide, endKey: "missing" }, { ...slide, endKey: "a" }];
  const before = JSON.stringify([spans, [...positions]]);
  const row = render(spans);
  render(spans, row);
  assert.equal(row.children.length, 1);
  assert.equal(row.children[0].children.length, 1);
  assert.equal(JSON.stringify([spans, [...positions]]), before);
});
