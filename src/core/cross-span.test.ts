/**
 * 跨段跨度回归：工程文件端点校验与 A4 视觉行续接。
 * 路由：编辑器 JSON 打开及分页 SVG；无后端 API。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNote, createParagraph, createScore, type MusicSpan } from "./model.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";
import { renderPageSvg } from "../render/svg-render.ts";
import type { ScorePage } from "../render/pagination.ts";

function fixture() {
  const paragraphs = ["a", "b", "c"].map(prefix => createParagraph(
    [0, 1, 2].map(index => createNote({ key: `${prefix}${index}` })),
  ));
  paragraphs[0].spans = [{ kind: "slur", startKey: "a1", endKey: "c1" }];
  return createScore({ paragraphs });
}

test("JSON accepts global main endpoints while preserving owner anchoring and stable keys", () => {
  const score = fixture();
  const loaded = deserializeScore(serializeScore(score));
  assert.deepEqual(loaded?.paragraphs[0].spans, score.paragraphs[0].spans);
  score.paragraphs[2].spans = [{ kind: "trill", startKey: "c1", endKey: "a1" }];
  assert.ok(deserializeScore(serializeScore(score)), "backward endpoints also belong to the score");
  score.paragraphs[0].spans![0].startKey = "b0";
  assert.equal(deserializeScore(serializeScore(score)), null, "start must belong to owner");
});

test("JSON rejects missing/cue-only endpoints and duplicate keys independently of global scan", () => {
  for (const endKey of ["missing", "cue"]) {
    const score = fixture();
    score.paragraphs[0].cueLayers = [{ label: "cue", startBeat: 0, notations: [createNote({ key: "cue" })] }];
    score.paragraphs[0].spans![0].endKey = endKey;
    assert.equal(deserializeScore(serializeScore(score)), null);
  }
  for (const duplicateInCue of [false, true]) {
    const score = fixture();
    if (duplicateInCue) {
      score.paragraphs[0].cueLayers = [{ label: "cue", startBeat: 0, notations: [createNote({ key: "c1" })] }];
    } else score.paragraphs[2].notations[2].key = "a0";
    assert.equal(deserializeScore(serializeScore(score)), null);
  }
});

// 最小 SVG DOM 支持真实 renderPageSvg/renderMusicSpans，不依赖浏览器或额外包。
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
const svgDocument = {
  createElementNS: (_namespace: string, tag: string) => new SvgNode(tag),
  createElement: () => ({ getContext: () => ({ font: "", measureText: () => ({ width: 16 }) }) }),
};
function descendants(node: SvgNode): SvgNode[] {
  return [node, ...node.children.flatMap(descendants)];
}
function renderRows(score: ReturnType<typeof fixture>, rows: [number, number[]][]) {
  const page: ScorePage = {
    pageIndex: 1,
    totalHeight: rows.length * 100,
    rows: rows.map(([paraIndex, indexes], rowInPara) => ({
      paraIndex, rowInPara, isLastRowOfPara: true, rowHeight: 100, alignJustify: false, lyrics: [],
      rowGlyphs: indexes.map(index => ({ n: score.paragraphs[paraIndex].notations[index], width: 40, core: 16 })),
    })),
  };
  const original = globalThis.document;
  try {
    globalThis.document = svgDocument as unknown as Document;
    return renderPageSvg(page, 2, score) as unknown as SvgNode;
  } finally { globalThis.document = original; }
}
function spansIn(node: SvgNode) {
  return descendants(node).filter(child => child.hasAttribute("data-kind"));
}

test("SVG clips outgoing, incoming and intermediate spans across paragraphs/pages", () => {
  const score = fixture();
  const svg = renderRows(score, [[0, [0, 1, 2]], [1, [0, 1, 2]], [2, [0, 1, 2]]]);
  assert.deepEqual(spansIn(svg).map(span => [span.getAttribute("data-start-key"), span.getAttribute("data-end-key")]),
    [["a1", "a2:span-after"], ["b0:span-before", "b2:span-after"], ["c0:span-before", "c1"]]);
  assert.deepEqual(spansIn(renderRows(score, [[1, [0, 1, 2]]])).map(span => span.getAttribute("data-start-key")), ["b0:span-before"]);
  assert.equal(spansIn(renderRows(score, [[2, [2]]])).length, 0, "row beyond span remains empty");
});

test("SVG retains incoming and local spans in separate lanes and handles singleton intersections", () => {
  const score = fixture();
  score.paragraphs[1].spans = [{ kind: "slur", startKey: "b0", endKey: "b2" }];
  const rendered = spansIn(renderRows(score, [[1, [0, 1, 2]]]));
  assert.equal(rendered.length, 2);
  assert.notEqual(rendered[0].children[0].getAttribute("d"), rendered[1].children[0].getAttribute("d"));
  for (const [paragraph, index] of [[0, 1], [1, 1], [2, 1]]) {
    assert.ok(spansIn(renderRows(score, [[paragraph, [index]]])).length >= 1);
  }
  const before = serializeScore(score);
  const first = renderRows(score, [[1, [1]]]);
  const second = renderRows(score, [[1, [1]]]);
  assert.deepEqual(spansIn(first).map(span => [...span.attributes]), spansIn(second).map(span => [...span.attributes]));
  assert.equal(serializeScore(score), before, "clipping must not rewrite score endpoint keys");
});

test("SVG continues every span kind over wrapped rows with reversed global endpoints", () => {
  for (const kind of ["slur", "crescendo", "diminuendo", "trill", "tuplet"] as MusicSpan["kind"][]) {
    const score = fixture();
    score.paragraphs[0].spans = [];
    score.paragraphs[2].spans = [{ kind, startKey: "c1", endKey: "a1", label: "5" }];
    const rendered = spansIn(renderRows(score, [[1, [0, 1]], [1, [2]]]));
    assert.equal(rendered.length, 2, kind);
    assert.ok(rendered.every(span => span.getAttribute("data-kind") === kind));
  }
});
