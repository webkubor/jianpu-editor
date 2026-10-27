/**
 * 倚音波音回归测试：验证 {w} 归属、八度变音与 DSL/JSON 往返。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, tokenizeLine } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";

test("单个倚音波音只修饰倚音", () => {
  const { tokens } = tokenizeLine("(3{w})5");
  assert.equal(tokens.length, 1);
  const note = compileScore("(3{w})5").paragraphs[0].notations[0];
  assert.deepEqual(note.graceNotes, [{ note: "3", octave: 0, mordent: true }]);
  assert.equal(note.note, "5");
  assert.equal(note.technique, undefined);
});

test("多个倚音分别保留波音，不影响主音装饰的右花括号", () => {
  const note = compileScore("(3{w}45{w})6{tr,w,提示}").paragraphs[0].notations[0];
  assert.deepEqual(note.graceNotes, [
    { note: "3", octave: 0, mordent: true },
    { note: "4", octave: 0 },
    { note: "5", octave: 0, mordent: true },
  ]);
  assert.deepEqual(note.technique, { trill: true, mordent: true });
  assert.deepEqual(note.topDecorators, ["提示"]);
});

test("倚音波音在变音与后缀八度后读取，附点主音及所有修饰往返保留", () => {
  const score = compileScore("(#3^^{w}b6,,{w}^2{w})#5^.{w,TK,mf,提示}:0.75/1");
  const note = score.paragraphs[0].notations[0];
  const graceNotes = [
    { note: "3", octave: 2, accidental: "♯", mordent: true },
    { note: "6", octave: -2, accidental: "♭", mordent: true },
    { note: "2", octave: 1, mordent: true },
  ];
  assert.deepEqual(note.graceNotes, graceNotes);
  assert.equal(note.octave, 1);
  assert.equal(note.dotted, true);
  assert.deepEqual(note.prefixAccidentals, ["♯"]);
  assert.equal(note.dynamic, "mf");
  assert.equal(note.beatFrac, 0.75);
  assert.equal(note.underline, 1);
  const dsl = toDsl(score);
  assert.equal(dsl, "(#3^^{w}b6,,{w}2^{w})#5^.{提示,w,TK,mf}:0.75/1");
  for (const back of [compileScore(dsl), deserializeScore(serializeScore(score))]) {
    assert.ok(back);
    const { key: _key, ...fields } = back.paragraphs[0].notations[0];
    const { key: _originalKey, ...originalFields } = note;
    assert.deepEqual(JSON.parse(JSON.stringify(fields)), JSON.parse(JSON.stringify(originalFields)));
  }
});

test("JSON 保留可选波音布尔值并拒绝非布尔值", () => {
  const score = compileScore("(345)6");
  const graceNotes = score.paragraphs[0].notations[0].graceNotes!;
  graceNotes[0].mordent = true;
  graceNotes[1].mordent = false;
  const back = deserializeScore(serializeScore(score));
  assert.deepEqual(back?.paragraphs[0].notations[0].graceNotes, graceNotes);
  for (const invalid of ["true", 1, null, {}, []]) {
    const data = JSON.parse(serializeScore(score));
    data.paragraphs[0].notations[0].graceNotes[0].mordent = invalid;
    assert.equal(deserializeScore(JSON.stringify(data)), null);
  }
});
