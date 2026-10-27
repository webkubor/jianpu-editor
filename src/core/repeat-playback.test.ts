/**
 * 显式反复回放回归：跨段、休止、共享提示时间、嵌套边界与原谱不可变。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBar, createExtend, createNote, createParagraph, createScore, REPEAT_START, REPEAT_END } from "./model.ts";
import type { NoteSymbol } from "./model.ts";
import { compileEvents, timeBefore, toMidi } from "./player.ts";

const notes = (...symbols: NoteSymbol[]) => symbols.map(note => createNote({ note }));
const scoreOf = (...paragraphs: NoteSymbol[][]) => createScore({
  speed: 60, paragraphs: paragraphs.map(symbols => createParagraph(notes(...symbols))),
});

test("explicit paired repeat spans paragraphs and preserves rests and source cursor positions", () => {
  const score = scoreOf(["7", REPEAT_START, "1", "0"], ["2", REPEAT_END, "3"]);
  const before = structuredClone(score);
  const events = compileEvents(score);
  assert.deepEqual(events.map(e => [e.start, e.midi, e.paragraph, e.index]), [
    [0, 71, 0, 0], [1, 60, 0, 2], [2, null, 0, 3], [3, 62, 1, 0],
    [4, 60, 0, 2], [5, null, 0, 3], [6, 62, 1, 0], [7, 64, 1, 2],
  ]);
  assert.equal(events[2].duration, 1);
  assert.equal(timeBefore(score, 0, 2), 1);
  assert.equal(timeBefore(score, 1, 0), 3);
  assert.equal(timeBefore(score, 1, 1), 4);
  assert.equal(timeBefore(score, 1, 2), 7);
  assert.equal(timeBefore(score, 2, 0), 8);
  assert.deepEqual(score, before);
  const midi = toMidi(events, score.speed);
  assert.equal(Array.from(midi).filter((byte, i) => byte === 0x90 && midi[i + 2] === 0x64).length, 6);
});

test("unmatched markers never infer repeats; separate explicit pairs play twice", () => {
  for (const symbols of [[REPEAT_END, "1"], [REPEAT_START, "1"], ["1", REPEAT_END, "2", REPEAT_START]] as NoteSymbol[][]) {
    assert.equal(compileEvents(scoreOf(symbols)).length, symbols.filter(s => s === "1" || s === "2").length);
  }
  assert.deepEqual(compileEvents(scoreOf([REPEAT_START, "1", REPEAT_END, REPEAT_START, "2", REPEAT_END]))
    .map(e => [e.start, e.midi]), [[0, 60], [1, 60], [2, 62], [3, 62]]);
});

test("nested pairs reset the inner repeat for each outer pass", () => {
  const score = scoreOf([REPEAT_START, "1", REPEAT_START, "2", REPEAT_END, "3", REPEAT_END, "4"]);
  assert.deepEqual(compileEvents(score).map(e => e.midi), [60, 62, 62, 64, 60, 62, 62, 64, 65]);
  assert.equal(timeBefore(score, 0, 7), 8);
});

test("deep nested and empty repeats terminate within a bounded expansion and reach the suffix", () => {
  const score = scoreOf([
    ...Array<NoteSymbol>(30).fill(REPEAT_START), "1", ...Array<NoteSymbol>(30).fill(REPEAT_END), "2",
  ]);
  const events = compileEvents(score);
  assert.ok(events.length > 1 && events.length <= 10_001);
  assert.equal(events.at(-1)!.midi, 62);
  assert.ok(events.every((e, i) => i === 0 || e.start >= events[i - 1].start));
  assert.deepEqual(compileEvents(scoreOf([REPEAT_START, REPEAT_END, "1"])).map(e => e.start), [0]);
});

test("cue resume gaps and paragraph tail silence are replayed on the shared timeline", () => {
  const resume = createNote({ note: "2" });
  const first = createParagraph([createBar(REPEAT_START), createNote(), resume]);
  first.cueLayers = [{ label: "cue", startBeat: 1, timelineBeats: 4, resumeKey: resume.key, notations: notes("7") }];
  const second = createParagraph(notes("3"));
  second.cueLayers = [{ label: "cue tail", startBeat: 0, timelineBeats: 3, notations: notes("7") }];
  const score = createScore({ speed: 60, paragraphs: [first, second, createParagraph(notes(REPEAT_END, "4"))] });
  const before = structuredClone(score);
  const events = compileEvents(score);
  assert.deepEqual(events.filter(e => e.midi !== null).map(e => [e.start, e.midi]), [
    [0, 60], [4, 62], [5, 64], [8, 60], [12, 62], [13, 64], [16, 65],
  ]);
  assert.deepEqual(events.filter(e => e.midi === null).map(e => [e.start, e.duration]), [[6, 2], [14, 2]]);
  assert.equal(timeBefore(score, 0, 2), 4);
  assert.equal(timeBefore(score, 2, 1), 16);
  assert.deepEqual(score, before);
});

test("cyclic tie data cannot loop during repeat compilation", () => {
  const group = notes("1", "1", "1");
  group[0].tieTo = group[1].key;
  group[1].tieTo = group[2].key;
  group[2].tieTo = group[1].key;
  const score = createScore({ speed: 60, paragraphs: [createParagraph([
    createBar(REPEAT_START), ...group, createBar(REPEAT_END),
  ])] });
  const events = compileEvents(score);
  assert.deepEqual(events.filter(e => e.midi !== null).map(e => e.start), [0, 3]);
  assert.equal(events.length, 6);
});

test("sustain remains inside repeat boundaries; volta annotations do not guess alternate endings", () => {
  const first = createNote();
  const extension = createExtend();
  const following = createExtend();
  const score = createScore({ speed: 60, paragraphs: [createParagraph([
    createBar(REPEAT_START), first, extension, createBar(REPEAT_END), following, createNote({ note: "2", volta: "2." }),
  ])] });
  first.tieTo = following.key;
  const events = compileEvents(score);
  assert.deepEqual(events.map(e => [e.start, e.index, e.midi]), [
    [0, 1, 60], [1, 2, null], [2, 1, 60], [3, 2, null], [5, 5, 62],
  ]);
  assert.equal(events[0].duration, 1.84);
  assert.equal(events[2].duration, 1.84);
});
