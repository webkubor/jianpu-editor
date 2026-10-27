/** 音符表情文字回归：DSL/JSON 往返、输入校验与安全 SVG 文本锚点。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";
import { renderScorePagesSvgs } from "../render/svg-render.ts";

test("direction combines with existing modifiers and roundtrips through DSL and JSON", () => {
  const score = compileScore("(#4)1^.{text=渐慢,tr,custom,mf}:0.5/1<3>  2{text=自由地}\n@cue {\"label\":\"提示\",\"startBeat\":0,\"dsl\":\"3{text=渐强}\"}");
  const note = score.paragraphs[0].notations[0];
  assert.equal(note.direction, "渐慢");
  assert.deepEqual(note.topDecorators, ["custom"]);
  assert.deepEqual(note.technique, { trill: true });
  assert.equal(note.dynamic, "mf");
  const dsl = toDsl(score);
  assert.match(dsl, /\{custom,tr,mf,text=渐慢\}/);
  assert.equal(toDsl(compileScore(dsl)), dsl);
  const json = deserializeScore(serializeScore(score));
  assert.ok(json);
  assert.deepEqual(JSON.parse(JSON.stringify(json)), JSON.parse(JSON.stringify(score)));
  assert.equal(json.paragraphs[0].cueLayers?.[0].notations[0].direction, "渐强");
});

test("DSL accepts short labels and rejects unsupported text instead of splitting it", () => {
  for (const text of ["渐慢", "rit.", "a".repeat(120), "<script>&"]) {
    assert.equal(compileScore(`1{text=${text}}`).paragraphs[0].notations[0].direction, text);
  }
  for (const text of ["", "a".repeat(121), "渐 慢", "渐\t慢", "渐\u0000慢", "渐\u007f慢", "渐{慢"]) {
    assert.throws(() => compileScore(`1{tr,text=${text},mf}`), SyntaxError, JSON.stringify(text));
  }
  const score = compileScore("1");
  for (const text of ["a b", "a,b", "a}b"]) {
    score.paragraphs[0].notations[0].direction = text;
    assert.throws(() => toDsl(score), SyntaxError);
  }
});

test("JSON validates direction strings, lengths and control characters in main and cue notes", () => {
  for (const cue of [false, true]) {
    for (const direction of [null, false, 1, {}, [], "a".repeat(121), "a\nb", "a\u0085b"]) {
      const data = JSON.parse(serializeScore(compileScore("1")));
      const note = { ...data.paragraphs[0].notations[0], direction };
      if (cue) data.paragraphs[0].cueLayers = [{ label: "cue", startBeat: 0, notations: [{ ...note, key: "cue-note" }] }];
      else data.paragraphs[0].notations = [note];
      assert.equal(deserializeScore(JSON.stringify(data)), null);
    }
  }
  const score = compileScore("1");
  score.paragraphs[0].notations[0].direction = "a tempo";
  assert.equal(deserializeScore(serializeScore(score))?.paragraphs[0].notations[0].direction, "a tempo");
});

// 最小 DOM 跑真实渲染器；innerHTML 赋值直接失败，防止文本变成 SVG 标记。
class SvgNode {
  attributes = new Map<string, string>();
  children: SvgNode[] = [];
  textContent = "";
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set innerHTML(_value: string) { throw new Error("direction must use textContent"); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  appendChild(child: SvgNode) { this.children.push(child); return child; }
  getComputedTextLength() { return this.textContent.length * 14; }
}
const descendants = (node: SvgNode): SvgNode[] => [node, ...node.children.flatMap(descendants)];

test("SVG direction uses safe textContent at mainX above the complete decorator stack", () => {
  const original = globalThis.document;
  try {
    globalThis.document = {
      createElementNS: (_namespace: string, tag: string) => new SvgNode(tag),
      createElement: () => ({ getContext: () => ({ font: "", measureText: () => ({ width: 16 }) }) }),
    } as unknown as Document;
    const score = compileScore("(#4)1^^.{tr,first,second,text=渐慢}:1/0");
    const payload = "<script>alert(1)</script>&";
    score.paragraphs[0].notations[0].direction = payload;
    const nodes = renderScorePagesSvgs(score).flatMap(svg => descendants(svg as unknown as SvgNode));
    const direction = nodes.find(n => n.getAttribute("class") === "score-direction");
    assert.ok(direction);
    assert.equal(direction.tagName, "text");
    assert.equal(direction.textContent, payload);
    assert.equal(direction.children.length, 0);
    assert.equal(direction.getAttribute("font-size"), "14");
    const digit = nodes.find(n => n.textContent === "1" && n.getAttribute("font-size") === "28");
    assert.ok(digit);
    assert.equal(direction.getAttribute("x"), digit.getAttribute("x"));
    for (const mark of nodes.filter(n => ["top-decorator", "wind-tech-trill"].includes(n.getAttribute("class") ?? ""))) {
      assert.ok(Number(direction.getAttribute("y")) <= Number(mark.getAttribute("y")) - 16);
    }
    assert.ok(nodes.every(n => n.tagName !== "script"));
  } finally { globalThis.document = original; }
});
