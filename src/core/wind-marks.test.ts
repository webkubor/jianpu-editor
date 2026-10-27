/** 管乐图例记号回归：DSL、JSON 与 SVG 矢量形状；释义暂据辅助图例。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, tokenizeLine } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";
import { renderScorePagesSvgs } from "../render/svg-render.ts";

test("harm/strike/die parse as techniques and keep tongue T distinct", () => {
  const token = tokenizeLine("5{harm,strike,die,T}").tokens[0];
  assert.equal(token.t, "note");
  if (token.t !== "note") return;
  assert.deepEqual(token.technique, { harmonic: true, fingerStrike: true, appoggiatura: true, tonguing: "T" });
  assert.deepEqual(token.decorators, []);
  for (const alias of ["die", "app", "叠"]) {
    assert.deepEqual(compileScore(`5{${alias}}`).paragraphs[0].notations[0].technique, { appoggiatura: true });
  }
});

test("wind marks preserve existing modifiers through DSL and JSON", () => {
  const score = compileScore("(#4{w})5^.{harm,strike,die,tr,w,>,v,up,down,TK,fl,vib,gli,pp,custom}:0.5/1");
  const note = score.paragraphs[0].notations[0];
  const dsl = toDsl(score);
  assert.match(dsl, /die,harm,strike/);
  for (const back of [compileScore(dsl), deserializeScore(serializeScore(score))]) {
    assert.ok(back);
    const actual = back.paragraphs[0].notations[0];
    assert.deepEqual(actual.technique, note.technique);
    for (const key of ["note", "octave", "dotted", "underline", "beatFrac", "dynamic", "topDecorators", "graceNotes"] as const) {
      assert.deepEqual(actual[key], note[key]);
    }
  }
});

test("JSON validates optional wind booleans in main and cue notes", () => {
  for (const flag of ["harmonic", "fingerStrike", "appoggiatura"]) {
    for (const value of [true, false]) {
      const score = compileScore("5");
      score.paragraphs[0].notations[0].technique = { [flag]: value };
      assert.deepEqual(deserializeScore(serializeScore(score))?.paragraphs[0].notations[0].technique, { [flag]: value });
    }
    for (const value of ["true", 1, null, [], {}]) {
      for (const cue of [false, true]) {
        const data = JSON.parse(serializeScore(compileScore("5")));
        const note = { ...data.paragraphs[0].notations[0], key: "cue-note", technique: { [flag]: value } };
        if (cue) data.paragraphs[0].cueLayers = [{ label: "cue", startBeat: 0, notations: [note] }];
        else data.paragraphs[0].notations = [note];
        assert.equal(deserializeScore(JSON.stringify(data)), null, `${flag}=${JSON.stringify(value)}, cue=${cue}`);
      }
    }
  }
});

// 最小 DOM 运行真实 SVG 导出；仅验证向量结构，不模拟字体与浏览器绘制。
class SvgNode {
  attributes = new Map<string, string>();
  children: SvgNode[] = [];
  textContent = "";
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  appendChild(child: SvgNode) { this.children.push(child); return child; }
  getComputedTextLength() { return this.textContent.length * 14; }
}
const svgDocument = {
  createElementNS: (_namespace: string, tag: string) => new SvgNode(tag),
  createElement: () => ({ getContext: () => ({ font: "", measureText: () => ({ width: 16 }) }) }),
};
const descendants = (node: SvgNode): SvgNode[] => [node, ...node.children.flatMap(descendants)];

test("SVG uses hollow harmonic circle, separate finger T, and capped hourglass", () => {
  const original = globalThis.document;
  try {
    globalThis.document = svgDocument as unknown as Document;
    const nodes = renderScorePagesSvgs(compileScore("5^{die,strike,T,harm}:1/0"))
      .flatMap(svg => descendants(svg as unknown as SvgNode));
    const mark = (name: string) => {
      const node = nodes.find(n => n.getAttribute("class") === `wind-tech-${name}`);
      assert.ok(node, name);
      return node;
    };
    const harmonic = mark("harmonic");
    assert.equal(harmonic.tagName, "circle");
    assert.equal(harmonic.getAttribute("fill"), "none");
    assert.equal(harmonic.getAttribute("r"), "2.5");
    const strike = mark("finger-strike");
    assert.equal(strike.tagName, "path");
    assert.match(strike.getAttribute("d")!, /H .* M .* V /);
    assert.equal(mark("tonguing").textContent, "T");
    const hourglass = mark("appoggiatura");
    assert.equal(hourglass.tagName, "path");
    assert.equal(hourglass.getAttribute("fill"), "none");
    const coordinates = hourglass.getAttribute("d")!.match(/^M (-?\d+) (-?\d+) H (-?\d+) L (-?\d+) (-?\d+) H (-?\d+) Z$/);
    assert.ok(coordinates);
    const [, left, top, right, lowerLeft, bottom, lowerRight] = coordinates.map(Number);
    assert.equal(left, lowerLeft);
    assert.equal(right, lowerRight);
    assert.ok(left < right && top < bottom);
    assert.ok(Number(harmonic.getAttribute("cy")) < top);
    assert.ok(nodes.every(n => !n.textContent.includes("⚹")));
  } finally { globalThis.document = original; }
});
