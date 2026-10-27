import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { validateScore } from "./validate.ts";
import { serializeScore, deserializeScore } from "./serialize.ts";
import { createMuminDraft } from "./mumin-draft.ts";

test("牧民新歌工作稿保留原图定位、变拍和复杂连音组", () => {
  const { score, review } = createMuminDraft();
  assert.equal(score.tone, "A");
  assert.equal(score.paragraphs[0].notations[0].note, "6");
  assert.equal(score.paragraphs[0].notations[0].octave, -1);
  assert.equal(score.paragraphs[0].freeTime, true);
  assert.equal(review.filter(r => r.page === 1 && r.row === 5).length, 2);
  assert.deepEqual(score.paragraphs[11].meter, [2, 4]);
  const labels = score.paragraphs.flatMap(p => p.spans ?? []).filter(s => s.kind === "tuplet").map(s => s.label);
  for (const label of ["3", "5", "6", "7", "9"]) assert.ok(labels.includes(label));
  assert.deepEqual(validateScore(score), [{ paragraph: 10, bar: 0, beats: 0.5, expected: 2 }]);
  assert.equal(score.paragraphs[10].cueLayers?.[0].startBeat, 0.5);
  assert.equal(score.paragraphs[10].cueLayers?.[0].timelineBeats, 8);
  assert.equal(score.paragraphs.filter(p => p.cueLayers?.length).length, 5);
  const slowCue = score.paragraphs[5].cueLayers?.[0];
  assert.equal(slowCue?.startBeat, 0);
  assert.equal(slowCue?.timelineBeats, 8);
  assert.equal(slowCue?.resumeKey, undefined);
});

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

test("力度作为音下标记而非顶部自由文本，往返不丢失", () => {
  const score = compileScore("6,{pp}:1/0");
  assert.equal(score.paragraphs[0].notations[0].dynamic, "pp");
  assert.deepEqual(score.paragraphs[0].notations[0].topDecorators, []);
  assert.equal(compileScore(toDsl(score)).paragraphs[0].notations[0].dynamic, "pp");
  assert.equal(deserializeScore(serializeScore(score))?.paragraphs[0].notations[0].dynamic, "pp");
});

test("倚音临时变音和低八度在DSL/工程文件往返保留", () => {
  const score = compileScore("(b7#4,5)6:1/0");
  const expected = [{ note: "7", octave: 0, accidental: "♭" }, { note: "4", octave: -1, accidental: "♯" }, { note: "5", octave: 0 }];
  assert.deepEqual(score.paragraphs[0].notations[0].graceNotes, expected);
  assert.deepEqual(compileScore(toDsl(score)).paragraphs[0].notations[0].graceNotes, expected);
  assert.deepEqual(deserializeScore(serializeScore(score))?.paragraphs[0].notations[0].graceNotes, expected);
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
