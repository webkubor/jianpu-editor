import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { validateScore } from "./validate.ts";
import { serializeScore, deserializeScore } from "./serialize.ts";

test("倚音在高八度前缀后保留，技巧完整往返", () => {
  const score = compileScore("(5)^1{w,die,>,v}:0.5/1");
  const note = score.paragraphs[0].notations[0];
  assert.deepEqual(note.graceNotes, [{ note: "5", octave: 0 }]);
  assert.equal(note.octave, 1);
  assert.deepEqual(note.technique, { mordent: true, appoggiatura: true, accent: true, breath: true });
  const back = compileScore(toDsl(score)).paragraphs[0].notations[0];
  assert.deepEqual(back.graceNotes, note.graceNotes);
  assert.deepEqual(back.technique, note.technique);
});

test("跨度对象在 DSL 和 JSON 中保留按音符定位", () => {
  const score = compileScore("1  2  3");
  const notes = score.paragraphs[0].notations;
  score.paragraphs[0].spans = [
    { kind: "slur", startKey: notes[0].key, endKey: notes[2].key },
    { kind: "tuplet", startKey: notes[0].key, endKey: notes[2].key, label: "3" },
  ];
  const back = compileScore(toDsl(score));
  assert.deepEqual(back.paragraphs[0].spans?.map(s => ({
    kind: s.kind, start: back.paragraphs[0].notations.findIndex(n => n.key === s.startKey),
    end: back.paragraphs[0].notations.findIndex(n => n.key === s.endKey),
  })), [{ kind: "slur", start: 0, end: 2 }, { kind: "tuplet", start: 0, end: 2 }]);
  assert.equal(deserializeScore(serializeScore(score))?.paragraphs[0].spans?.length, 2);
});

test("只有显式散板段落跳过拍数检查，1/1不关闭全谱校验", () => {
  const score = compileScore("6,  -\n1  2\n3");
  score.beat = [4, 4];
  score.paragraphs[0].heading = "辽阔地";
  score.paragraphs[0].freeTime = true;
  score.paragraphs[1].meter = [2, 4];
  assert.deepEqual(validateScore(score), [{ paragraph: 2, bar: 0, beats: 1, expected: 4 }]);
  const loaded = deserializeScore(serializeScore(score));
  assert.ok(loaded);
  assert.equal(loaded.paragraphs[0].freeTime, true);
  assert.equal(loaded.paragraphs[0].heading, "辽阔地");
  assert.deepEqual(loaded.paragraphs[1].meter, [2, 4]);
  const textBack = compileScore(toDsl(score), { beat: [4, 4] });
  assert.equal(textBack.paragraphs[0].freeTime, true);
  assert.equal(textBack.paragraphs[0].heading, "辽阔地");
  assert.deepEqual(textBack.paragraphs[1].meter, [2, 4]);
  assert.deepEqual(validateScore(textBack), validateScore(score));
  score.beat = [1, 1];
  assert.equal(validateScore(score).length, 1);
});
