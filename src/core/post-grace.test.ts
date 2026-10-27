/**
 * 后置倚音回归：验证前后倚音共存、DSL/JSON 往返及主音时间轴不变。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, tokenizeLine } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";
import { compileEvents, timeBefore } from "./player.ts";

test("post-grace follows note modifiers and duration, exports before tie", () => {
  const score = compileScore("(12)#1^.{w,mf}:0.75/1<#3^^{w}b6,,{w}^2>~1:1/0");
  const note = score.paragraphs[0].notations[0];
  assert.deepEqual(note.graceNotes, [{ note: "1", octave: 0 }, { note: "2", octave: 0 }]);
  assert.deepEqual(note.postGraceNotes, [
    { note: "3", octave: 2, accidental: "♯", mordent: true },
    { note: "6", octave: -2, accidental: "♭", mordent: true },
    { note: "2", octave: 1 },
  ]);
  const dsl = "(12)#1^.{w,mf}:0.75/1<#3^^{w}b6,,{w}2^>~  1:1/0";
  assert.equal(toDsl(score), dsl);
  const back = compileScore(dsl);
  assert.equal(toDsl(back), dsl);
  const fields = ({ key: _key, tieTo: _tie, ...rest }: typeof note) => JSON.parse(JSON.stringify(rest));
  assert.deepEqual(back.paragraphs[0].notations.map(fields), score.paragraphs[0].notations.map(fields));
  assert.equal(back.paragraphs[0].notations[0].tieTo, back.paragraphs[0].notations[1].key);
  assert.deepEqual(JSON.parse(JSON.stringify(deserializeScore(serializeScore(score)))), JSON.parse(JSON.stringify(score)));
});

test("post-grace attaches only to the preceding main note and needs an adjacent suffix", () => {
  const score = compileScore("(12)1^.<3>  2{tr}<4,>  3/_<5'>");
  assert.deepEqual(score.paragraphs[0].notations.map(n => n.postGraceNotes), [
    [{ note: "3", octave: 0 }], [{ note: "4", octave: -1 }], [{ note: "5", octave: 1 }],
  ]);
  assert.equal(tokenizeLine("1<3>").tokens[1].t, "postGrace");
  for (const invalid of ["<3>1", "1 <3>", "1|<3>", "-<3>", "1:1/0~<3>", "1<>", "1<3", "(12)1^<3>."]) {
    assert.throws(() => compileScore(invalid), SyntaxError, invalid);
  }
});

test("post-grace preserves explicit and inferred durations and playback timing", () => {
  for (const [plain, decorated] of [
    ["1 2  3.  | 4:0.25/2  -", "1<45> 2<6>  3.<7>  | 4:0.25/2<1>  -"],
    ["1:1/0~1:1/0  2", "1:1/0<3>~1:1/0<4>  2<5>"],
  ]) {
    const base = compileScore(plain);
    const score = compileScore(decorated);
    assert.deepEqual(score.paragraphs[0].notations.map(n => [n.beatFrac, n.underline, n.dotted]),
      base.paragraphs[0].notations.map(n => [n.beatFrac, n.underline, n.dotted]));
    assert.deepEqual(compileEvents(score), compileEvents(base));
    for (let i = 0; i <= base.paragraphs[0].notations.length; i++) {
      assert.equal(timeBefore(score, 0, i), timeBefore(base, 0, i));
    }
  }
});

test("JSON post-grace uses the same validation and decoding as pre-grace, including cues", () => {
  const score = compileScore("1<345>\n@cue {\"label\":\"提示\",\"startBeat\":0,\"dsl\":\"2<#4,{w}>\"}");
  const notes = score.paragraphs[0].notations[0].postGraceNotes!;
  notes[0].mordent = true;
  notes[1].mordent = false;
  assert.deepEqual(JSON.parse(JSON.stringify(deserializeScore(serializeScore(score)))), JSON.parse(JSON.stringify(score)));
  for (const invalid of ["true", 1, null, {}, []]) {
    const data = JSON.parse(serializeScore(score));
    data.paragraphs[0].notations[0].postGraceNotes[0].mordent = invalid;
    assert.equal(deserializeScore(JSON.stringify(data)), null);
    const cueData = JSON.parse(serializeScore(score));
    cueData.paragraphs[0].cueLayers[0].notations[0].postGraceNotes[0].mordent = invalid;
    assert.equal(deserializeScore(JSON.stringify(cueData)), null);
  }
  for (const invalid of [null, {}, "3", [null]]) {
    const data = JSON.parse(serializeScore(score));
    data.paragraphs[0].notations[0].postGraceNotes = invalid;
    assert.equal(deserializeScore(JSON.stringify(data)), null);
  }
});
