/** 小节校验回归：提示声部仅在时间、分段和恢复主音均吻合时补足主声部。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLine, compileScore } from "./dsl.ts";
import { createMuminDraft } from "./mumin-draft.ts";
import type { Paragraph } from "./model.ts";
import { measureBeats, validateScore } from "./validate.ts";

type Cue = NonNullable<Paragraph["cueLayers"]>[number];

function mumin() {
  const { score } = createMuminDraft();
  const para = score.paragraphs[10];
  return { score, para, cue: para.cueLayers![0] };
}

function warns(mutate: (para: Paragraph, cue: Cue) => void) {
  const { score, para, cue } = mumin();
  mutate(para, cue);
  assert.ok(validateScore(score).some(issue => issue.paragraph === 10 && issue.bar === 0));
}

test("actual mumin shared half-beat bar validates without changing main measures", () => {
  const { score, para, cue } = mumin();
  const before = structuredClone(para);
  assert.equal(cue.resumeKey, para.notations[3].key);
  assert.equal(cue.startBeat, 0.5);
  assert.equal(cue.timelineBeats, 8);
  assert.deepEqual(measureBeats({ ...para, notations: cue.notations }).map(bar => bar.beats), [1.5, 2, 2, 2]);
  assert.deepEqual(validateScore(score), []);
  assert.equal(measureBeats(para)[0].beats, 0.5);
  assert.deepEqual(para, before);
});

const mutations: Array<[string, (para: Paragraph, cue: Cue) => void]> = [
  ["missing cue", para => { delete para.cueLayers; }],
  ["missing start", (_para, cue) => { delete (cue as Partial<Cue>).startBeat; }],
  ["early overlapping start", (_para, cue) => { cue.startBeat = 0; }],
  ["late start", (_para, cue) => { cue.startBeat = 1; }],
  ["nonfinite start", (_para, cue) => { cue.startBeat = NaN; }],
  ["missing resume", (_para, cue) => { delete cue.resumeKey; }],
  ["unknown resume", (_para, cue) => { cue.resumeKey = "missing"; }],
  ["resume on initial note", (para, cue) => { cue.resumeKey = para.notations[0].key; }],
  ["resume on barline", (para, cue) => { cue.resumeKey = para.notations[1].key; }],
  ["resume on repeat", (para, cue) => { cue.resumeKey = para.notations[2].key; }],
  ["resume skips first pitched note", (para, cue) => { cue.resumeKey = para.notations[4].key; }],
  ["rest before resume", para => { para.notations[2].note = "0"; }],
  ["missing main barline", para => { para.notations.splice(1, 2); }],
  ["short first cue fragment", (_para, cue) => { cue.notations[0].beatFrac = 0.125; }],
  ["long first cue fragment", (_para, cue) => { cue.notations[0].beatFrac = 0.5; }],
  ["main duration changed", para => { para.notations[0].beatFrac = 0.25; }],
  ["missing first cue barline", (_para, cue) => { cue.notations.splice(4, 1); }],
  ["unbarred first cue fragment", (_para, cue) => { cue.notations = cue.notations.slice(0, 4); cue.timelineBeats = 2; }],
  ["short second fragment", (_para, cue) => { cue.notations[5].beatFrac = 0.25; }],
  ["short third fragment", (_para, cue) => { cue.notations[10].beatFrac = 0.25; }],
  ["short final fragment", (_para, cue) => { cue.notations[16].beatFrac = 0.25; }],
  ["compensated subsequent fragments", (_para, cue) => { cue.notations[5].beatFrac = 0.25; cue.notations[10].beatFrac = 0.75; }],
  ["missing timeline", (_para, cue) => { delete cue.timelineBeats; }],
  ["short timeline", (_para, cue) => { cue.timelineBeats = 7.5; }],
  ["long timeline", (_para, cue) => { cue.timelineBeats = 10; }],
  ["nonfinite timeline", (_para, cue) => { cue.timelineBeats = Infinity; }],
  ["overlapping cue", (para, cue) => { para.cueLayers!.push({ ...cue, startBeat: 1 }); }],
];
for (const [name, mutate] of mutations) {
  test(`shared bar still warns with ${name}`, () => warns(mutate));
}

test("complete preceding bars contribute to the cue's absolute start and timeline", () => {
  const { score, para, cue } = mumin();
  const prefix = compileLine("1:1/0 2:1/0 |").notations;
  para.notations.unshift(...prefix);
  cue.startBeat += 2;
  cue.timelineBeats! += 2;
  assert.deepEqual(validateScore(score), []);
  assert.deepEqual(measureBeats(para).map(bar => bar.beats), [2, 0.5, 0, 2, 2, 2]);
  cue.startBeat = 0.5;
  cue.timelineBeats = 8;
  assert.ok(validateScore(score).some(issue => issue.paragraph === 10 && issue.bar === 1));
});

test("valid cue completion does not hide another malformed main bar", () => {
  const { score, para } = mumin();
  para.notations[3].beatFrac = 0.25;
  assert.deepEqual(validateScore(score), [{ paragraph: 10, bar: 2, beats: 1.75, expected: 2 }]);
});

test("arbitrary parallel cues cannot suppress short or overfull bars", () => {
  const score = compileScore("1:1/0 | 2:1/0 3:1/0 4:1/0 |");
  score.beat = [2, 4];
  const para = score.paragraphs[0];
  para.cueLayers = [{ label: "parallel", startBeat: 0, timelineBeats: 4,
    notations: compileLine("5 6 | 7 1 |").notations }];
  assert.deepEqual(validateScore(score), [
    { paragraph: 0, bar: 0, beats: 1, expected: 2 },
    { paragraph: 0, bar: 1, beats: 3, expected: 2 },
  ]);
});

test("a separate cue touching the shared interval endpoint is allowed", () => {
  const { score, para } = mumin();
  para.cueLayers!.push({ label: "later", startBeat: 8, notations: compileLine("1:1/0 2:1/0 |").notations });
  assert.deepEqual(validateScore(score), []);
});
