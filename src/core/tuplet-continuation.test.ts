/**
 * 连音组续接回归：首段标签、空标签连续括号及默认数字。
 * 路由：编辑器 SVG 视觉行跨度；无后端 API。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMusicSpans, type MusicSpan } from "../render/music-spans.ts";

// 最小 SVG DOM：直接检查真实渲染器的路径和文本，不引入浏览器依赖。
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
  ["b", { x: 140, top: 100, bottom: 120 }],
]);
const tuplet: MusicSpan = { kind: "tuplet", startKey: "a", endKey: "b" };
function render(span: MusicSpan, points = positions) {
  const row = new SvgNode("g");
  renderMusicSpans(row as unknown as SVGGElement, [span], points);
  return row.children[0].children[0];
}

test("tuplet defaults to 3 only when its label is undefined", () => {
  for (const label of [undefined, "5", "7"]) {
    const group = render({ ...tuplet, label });
    assert.deepEqual(group.children.filter(node => node.tagName === "text").map(node => node.textContent),
      [label ?? "3"]);
    assert.equal((group.children[0].getAttribute("d")!.match(/M /g) ?? []).length, 2,
      "labelled bracket leaves a gap for its number");
  }
});

test("tuplet continuation draws a continuous bracket without a text node", () => {
  for (const reverse of [false, true]) {
    for (const width of [1, 120]) {
      const points = new Map([
        ["a", { x: 20, top: 100, bottom: 120 }],
        ["b", { x: 20 + width, top: 100, bottom: 120 }],
      ]);
      const span = { ...tuplet, label: "", ...(reverse ? { startKey: "b", endKey: "a" } : {}) };
      const before = JSON.stringify([span, [...points]]);
      const group = render(span, points);
      assert.equal(group.children.length, 1, "no empty label element");
      assert.equal(group.children[0].tagName, "path");
      assert.equal(group.children[0].getAttribute("d"),
        `M 20 92 L 20 83 L ${20 + width} 83 L ${20 + width} 92`);
      assert.equal(JSON.stringify([span, [...points]]), before);
    }
  }
});

test("a split tuplet keeps its number on the first segment only", () => {
  for (const label of ["5", "7"]) {
    const segments = [render({ ...tuplet, label }), render({ ...tuplet, label: "" }),
      render({ ...tuplet, label: "" })];
    assert.deepEqual(segments.flatMap(group => group.children.filter(node => node.tagName === "text")
      .map(node => node.textContent)), [label]);
    assert.ok(segments.every(group => group.children.some(node => node.tagName === "path")));
  }
});
