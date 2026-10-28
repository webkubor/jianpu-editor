/**
 * 续行连音线/滑音几何回归：行边裁切段的抬平进出、平浅中段与端点箭头抑制。
 * 路由：编辑器 SVG 视觉行跨度；continuesLeft/continuesRight 仅渲染层使用，模型不写这两标志。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMusicSpans, type MusicSpan } from "../render/music-spans.ts";

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

// 同一行两个字形：拱高由 place() 按跨度宽度决定且受上层通道影响，断言只取实测值比较。
const positions = new Map([
  ["a", { x: 20, top: 100, bottom: 120 }],
  ["b", { x: 140, top: 100, bottom: 120 }],
]);
const slur: MusicSpan = { kind: "slur", startKey: "a", endKey: "b" };
const slide: MusicSpan = { kind: "slide", startKey: "a", endKey: "b" };
const reverse = <T extends MusicSpan>(span: T): T => ({ ...span, startKey: span.endKey, endKey: span.startKey });

/** 渲染单个跨度，返回其分组；顺带确认渲染不修改输入跨度。 */
function render(span: MusicSpan) {
  const before = JSON.stringify(span);
  const row = new SvgNode("g");
  renderMusicSpans(row as unknown as SVGGElement, [span], positions);
  assert.equal(JSON.stringify(span), before, "rendering must not mutate the span");
  return row.children[0].children[0];
}
const curves = (group: SvgNode) => group.children
  .filter(node => node.tagName === "path")
  .map(node => node.getAttribute("d")!);
/** 基线：无续接标志时的两段实测路径（曲线 + 箭头），用作"未改变"的对照。 */
const baseline = (span: MusicSpan) => curves(render(span));
const curveOf = (span: MusicSpan) => baseline(span)[0];
/** 解析成坐标对：曲线为 [起点, 控制点1, 控制点2, 终点]，直线为 [起点, 终点]。 */
const points = (d: string) => d.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  .reduce<number[][]>((all, value, index, all$) => {
    if (index % 2 === 0) all.push([value, all$[index + 1]]);
    return all;
  }, []);
const curve = (d: string) => {
  const [start, c1, c2, end] = points(d);
  assert.equal(points(d).length, 4, `expected a cubic, got ${d}`);
  return { start, c1, c2, end };
};

test("ordinary slur keeps both endpoints at the bottom, unchanged", () => {
  for (const span of [slur, reverse(slur)]) {
    const d = curveOf(span);
    const { start, end, c1, c2 } = curve(d);
    // 两端落在字形底部（place() 实测的底边），与旧的单一拱形完全一致。
    assert.equal(start[1], end[1], d);
    assert.ok(start[1] > c1[1] && start[1] > c2[1], `${d} must arch above both ends`);
    const group = render(span);
    assert.equal(group.hasAttribute("data-continues-left"), false);
    assert.equal(group.hasAttribute("data-continues-right"), false);
  }
});

test("slur begins elevated with a flat tangent when it continues from a previous row", () => {
  for (const span of [{ ...slur, continuesLeft: true }, reverse({ ...slur, continuesLeft: true })]) {
    const d = curveOf(span);
    const plain = curve(curveOf({ ...span, continuesLeft: false }));
    const next = curve(d);
    // 起点抬到拱高，且与第一控制点同高 => 起始切线水平。
    assert.equal(next.start[1], next.c1[1], d);
    assert.ok(next.start[1] < plain.start[1], `${d} must start above the bottom end`);
    assert.equal(next.end[1], plain.end[1], "the unclipped end stays at the bottom");
    assert.equal(next.c2[1], plain.c2[1], "apex is untouched");
    const group = render(span);
    assert.equal(group.getAttribute("data-continues-left"), "true");
    assert.equal(group.getAttribute("data-continues-right"), null);
  }
});

test("slur ends elevated with a flat tangent when it continues onto the next row", () => {
  for (const span of [{ ...slur, continuesRight: true }, reverse({ ...slur, continuesRight: true })]) {
    const d = curveOf(span);
    const plain = curve(curveOf({ ...span, continuesRight: false }));
    const next = curve(d);
    assert.equal(next.end[1], next.c2[1], d);
    assert.ok(next.end[1] < plain.end[1], `${d} must end above the bottom end`);
    assert.equal(next.start[1], plain.start[1], "the unclipped end stays at the bottom");
    assert.equal(next.c1[1], plain.c1[1], "apex is untouched");
    const group = render(span);
    assert.equal(group.getAttribute("data-continues-right"), "true");
    assert.equal(group.getAttribute("data-continues-left"), null);
  }
});

test("a slur spanning the whole row becomes a flat shallow middle segment", () => {
  for (const span of [{ ...slur, continuesLeft: true, continuesRight: true },
    reverse({ ...slur, continuesLeft: true, continuesRight: true })]) {
    const d = curveOf(span);
    const [left, right] = points(d);
    assert.equal(points(d).length, 2, `expected a straight segment, got ${d}`);
    assert.equal(left[1], right[1], "no sag or arch in the middle of a clipped slur");
    const above = curve(curveOf({ ...span, continuesLeft: false, continuesRight: false }));
    assert.ok(left[1] < Math.min(above.start[1], above.end[1]), "sits on the slur lane, not on glyphs");
    assert.match(render(span).getAttribute("class")!, /music-span-slur/);
  }
});

test("ordinary slide keeps its single end arrow", () => {
  for (const [span, tip] of [[slide, "L 140 92"], [reverse(slide), "L 20 92"]] as const) {
    const paths = curves(render(span));
    assert.equal(paths.length, 2);
    assert.match(paths[1], new RegExp(`^M \\S+ \\S+ ${tip} L `), "arrow tip sits on the slur end");
  }
});

test("slide arrow is suppressed only when its actual endpoint is clipped", () => {
  // 正向箭头在右端：右端裁切则无箭头，左端裁切仍保留。
  assert.equal(curves(render({ ...slide, continuesRight: true })).length, 1);
  assert.equal(curves(render({ ...slide, continuesLeft: true })).length, 2);
  // 反向箭头在左端：镜像。
  assert.equal(curves(render(reverse({ ...slide, continuesLeft: true }))).length, 1);
  assert.equal(curves(render(reverse({ ...slide, continuesRight: true }))).length, 2);
  // 两端都裁切的中段没有任何可见端点。
  for (const span of [{ ...slide, continuesLeft: true, continuesRight: true },
    reverse({ ...slide, continuesLeft: true, continuesRight: true })]) {
    assert.deepEqual(curves(render(span)), ["M 20 74 L 140 74"]);
  }
});

test("continuation flags do not leak into other span kinds", () => {
  const flags = { continuesLeft: true, continuesRight: true };
  const plain = (span: MusicSpan) => curves(render(span));
  assert.deepEqual(plain({ kind: "tuplet", startKey: "a", endKey: "b", label: "", ...flags }),
    plain({ kind: "tuplet", startKey: "a", endKey: "b", label: "" }));
  assert.deepEqual(plain({ kind: "crescendo", startKey: "a", endKey: "b", ...flags }),
    plain({ kind: "crescendo", startKey: "a", endKey: "b" }));
});
