/**
 * 提示声部工程文件测试：独立时间轴、完整符号往返和非法元数据校验。
 * 路由：编辑器保存/打开。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BAR, createNote, createParagraph, createScore } from "./model.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";
import { compileScore } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { createMuminDraft } from "./mumin-draft.ts";

test("牧民新歌提示声部DSL往返保留起点与并行时长，不拼入主音", () => {
  const { score } = createMuminDraft();
  const back = compileScore(toDsl(score));
  assert.equal(back.paragraphs.length, score.paragraphs.length);
  score.paragraphs.forEach((para, index) => {
    assert.equal(back.paragraphs[index].notations.length, para.notations.length);
    assert.deepEqual(back.paragraphs[index].cueLayers?.map(c => [c.startBeat, c.timelineBeats, c.notations.length,
      c.resumeKey ? back.paragraphs[index].notations.findIndex(n => n.key === c.resumeKey) : null]),
      para.cueLayers?.map(c => [c.startBeat, c.timelineBeats, c.notations.length,
        c.resumeKey ? para.notations.findIndex(n => n.key === c.resumeKey) : null]));
  });
});

function cueScore() {
  const main = createNote({ key: "main", note: "6" });
  const cue = createNote({
    key: "cue", note: "3", octave: -1, dotted: true, underline: 2,
    breakUnderline: true, prefixAccidentals: ["♯"], topDecorators: ["tr"],
    tieTo: "cue-end", beatFrac: 1 / 3,
    graceNotes: [{ note: "5", octave: 1, accidental: "♭" }],
    technique: { trill: true, tonguing: "TK", accent: true, breath: true },
    volta: "1.", dynamic: "pp",
  });
  return createScore({ paragraphs: [{
    ...createParagraph([main]),
    cueLayers: [{ label: "括号提示", startBeat: 0, timelineBeats: 4, notations: [
      cue, createNote({ key: "cue-end", note: "4", tieTo: "cue" }),
      createNote({ key: "cue-bar", note: BAR }),
    ] }, { label: "后续提示", startBeat: 1.5, notations: [] }],
  }] });
}

test("cue layers roundtrip all notation fields without adding main notes or rests", () => {
  const score = cueScore();
  const loaded = deserializeScore(serializeScore(score));
  assert.ok(loaded);
  assert.deepEqual(JSON.parse(serializeScore(loaded)), JSON.parse(serializeScore(score)));
  assert.deepEqual(loaded.paragraphs[0].notations.map(n => n.note), ["6"]);
  assert.equal(loaded.paragraphs[0].cueLayers?.[0].startBeat, 0);
  assert.equal(loaded.paragraphs[0].cueLayers?.[0].timelineBeats, 4);
  assert.equal(loaded.paragraphs[0].cueLayers?.[1].startBeat, 1.5);
  assert.equal(loaded.paragraphs[0].cueLayers?.[1].timelineBeats, undefined);
});

test("scores without cue layers retain their optional shape", () => {
  const loaded = deserializeScore(serializeScore(createScore()));
  assert.ok(loaded);
  assert.equal(Object.hasOwn(loaded.paragraphs[0], "cueLayers"), false);
});

test("invalid cue metadata and notation structures reject the whole document", () => {
  const invalidLayers: unknown[] = [
    null, {}, "cue", [null], [{}],
    [{ label: 1, startBeat: 0, notations: [] }],
    [{ label: "cue", notations: [] }],
    ...[-1, "0", null, NaN, Infinity].map(startBeat => ({ label: "cue", startBeat, notations: [] })).map(layer => [layer]),
    ...[0, -1, "4", null, NaN, Infinity].map(timelineBeats => [{ label: "cue", startBeat: 0, timelineBeats, notations: [] }]),
    [{ label: "cue", startBeat: 0, notations: {} }],
    ...[null, { note: "8" }, { note: "1", dynamic: "fff" }, { note: "1", underline: -1 },
      { note: "1", octave: 0.5 }, { note: "1", beatFrac: 0 },
      { note: "1", prefixAccidentals: ["x"] }, { note: "1", topDecorators: [1] },
      { note: "1", key: "main" }].map(n => [{ label: "cue", startBeat: 0, notations: [n] }]),
  ];
  for (const cueLayers of invalidLayers) {
    const raw = JSON.parse(serializeScore(cueScore()));
    raw.paragraphs[0].cueLayers = cueLayers;
    assert.equal(deserializeScore(JSON.stringify(raw)), null, JSON.stringify(cueLayers));
  }
});

test("cue keys must remain unique between layers and paragraphs", () => {
  const score = cueScore();
  score.paragraphs[0].cueLayers![1].notations = [createNote({ key: "cue" })];
  assert.equal(deserializeScore(serializeScore(score)), null);
  const acrossParagraphs = cueScore();
  acrossParagraphs.paragraphs.push(createParagraph([createNote({ key: "cue" })]));
  assert.equal(deserializeScore(serializeScore(acrossParagraphs)), null);
});
