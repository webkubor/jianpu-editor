/**
 * 共享提示声部时间轴回归：显式恢复点、段尾静音、光标与跨段偏移。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBar, createExtend, createNote, createParagraph, createScore, REPEAT_START } from "./model.ts";
import type { Notation, Paragraph } from "./model.ts";
import { compileEvents, timeBefore } from "./player.ts";

function withCue(notations: Notation[], startBeat: number, timelineBeats: number, resumeKey?: string): Paragraph {
  return {
    ...createParagraph(notations),
    cueLayers: [{ label: "提示", startBeat, timelineBeats, resumeKey, notations: [createNote({ note: "7" })] }],
  } as Paragraph;
}

test("p2row2 resumes after the leading eighth and bar at beat 8", () => {
  const resume = createNote({ note: "2", underline: 1 });
  const para = withCue([
    createNote({ note: "6", underline: 1 }), createBar(), createBar(REPEAT_START), resume,
    createNote({ note: "3" }),
  ], 0.5, 8, resume.key);
  const score = createScore({ speed: 60, paragraphs: [para, createParagraph([createNote()])] });
  const events = compileEvents(score);
  assert.deepEqual(events.filter(e => e.midi !== null).map(e => [e.start, e.midi]), [
    [0, 69], [8, 62], [8.5, 64], [9.5, 60],
  ]);
  assert.equal(timeBefore(score, 0, 1), 0.5);
  assert.equal(timeBefore(score, 0, 3), 8);
  assert.equal(timeBefore(score, 0, 4), 8.5);
  assert.equal(timeBefore(score, 1, 0), 9.5);
});

test("p3row5 keeps two sustained bars and resumes the articulated main voice at beat 12", () => {
  const resume = createNote({ note: "3", topDecorators: ["▼"] });
  const score = createScore({ speed: 60, paragraphs: [withCue([
    createNote(), createExtend(), createBar(), createNote(), createExtend(), createBar(),
    resume, createNote({ note: "4" }),
  ], 3, 12, resume.key)] });
  const events = compileEvents(score);
  assert.deepEqual(events.filter(e => e.midi !== null).map(e => [e.start, e.duration]), [
    [0, 1.84], [2, 1.84], [12, 0.45], [13, 0.92],
  ]);
  for (const event of events) assert.equal(timeBefore(score, event.paragraph, event.index), event.start);
  assert.equal(timeBefore(score, 0, 8), 14);
});

test("p2row9 pads a four-beat main voice to 16 silently without inserting a flute rest", () => {
  const para = withCue([createNote(), createExtend(), createExtend(), createExtend()], 0, 16);
  const before = structuredClone(para);
  const score = createScore({ speed: 120, paragraphs: [para, createParagraph([createNote({ note: "2" })])] });
  const events = compileEvents(score);
  assert.deepEqual(events.filter(e => e.paragraph === 0 && e.midi === null).at(-1), {
    start: 2, duration: 6, midi: null, index: 3, paragraph: 0,
  });
  assert.deepEqual(events.filter(e => e.midi !== null).map(e => [e.start, e.midi]), [[0, 60], [8, 62]]);
  assert.equal(timeBefore(score, 0, 4), 8);
  assert.equal(timeBefore(score, 1, 0), 8);
  assert.deepEqual(para, before);
});

test("a horsecall timeline of 8 leaves a twelve-beat main voice unchanged", () => {
  const notes = Array.from({ length: 12 }, () => createNote());
  const para = withCue(notes, 0, 8);
  const score = createScore({ speed: 60, paragraphs: [para, createParagraph([createNote()])] });
  const events = compileEvents(score);
  assert.deepEqual(events.map(e => e.start), Array.from({ length: 13 }, (_, i) => i));
  assert.equal(events.filter(e => e.midi === null).length, 0);
  assert.equal(timeBefore(score, 1, 0), 12);
});

test("a cue without a resume key never infers a gap from rests or bar lines", () => {
  const score = createScore({ speed: 60, paragraphs: [withCue([
    createNote({ note: "0" }), createBar(), createNote({ note: "2" }),
  ], 1, 8)] });
  const events = compileEvents(score);
  assert.equal(events.find(e => e.midi !== null)!.start, 1);
  assert.equal(timeBefore(score, 0, 2), 1);
  assert.equal(events.at(-1)!.start + events.at(-1)!.duration, 8);
});

test("an already elapsed resume endpoint never pulls the main voice backward", () => {
  const resume = createNote({ note: "2" });
  const score = createScore({ speed: 60, paragraphs: [withCue([
    createNote(), createExtend(), createBar(), resume,
  ], 0.5, 1, resume.key)] });
  assert.equal(compileEvents(score).find(e => e.index === 3)!.start, 2);
  assert.equal(timeBefore(score, 0, 3), 2);
});

test("ties retain one attack and cursor starts when their resume point needs no gap", () => {
  const target = createNote();
  const first = createNote({ tieTo: target.key });
  const score = createScore({ speed: 60, paragraphs: [withCue([
    first, createBar(), target, createExtend(), createNote({ note: "2" }),
  ], 0.5, 1, target.key)] });
  const events = compileEvents(score);
  assert.equal(events[0].duration, 3 * 0.92);
  assert.deepEqual(events.map(e => [e.start, e.index, e.midi]), [
    [0, 0, 60], [1, 2, null], [2, 3, null], [3, 4, 62],
  ]);
  for (const event of events) assert.equal(timeBefore(score, 0, event.index), event.start);
});
