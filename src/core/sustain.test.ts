/**
 * 回放延音回归：普通延音线、连音线去重、光标时序与跳音别名。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBar, createExtend, createNote, createParagraph, createScore } from "./model.ts";
import type { Notation } from "./model.ts";
import { compileEvents } from "./player.ts";

const scoreOf = (...notations: Notation[]) => createScore({
  speed: 60, paragraphs: [createParagraph(notations)],
});

test("ordinary extensions sustain the pitch across bars and preserve cursor timing", () => {
  const score = scoreOf(
    createNote({ note: "5", octave: -1, prefixAccidentals: ["♯"] }),
    createExtend(), createBar(), createExtend(), createExtend(), createNote({ note: "2" }),
  );
  const events = compileEvents(score);
  assert.deepEqual(events.map(e => [e.start, e.index, e.midi]), [
    [0, 0, 56], [1, 1, null], [2, 3, null], [3, 4, null], [4, 5, 62],
  ]);
  assert.equal(events[0].duration, 4 * 0.92);
});

test("extension durations respect dotted and fractional beats without shifting the next note", () => {
  const events = compileEvents(scoreOf(
    createNote({ beatFrac: 0.5 }),
    createNote({ note: "─", dotted: true }),
    createNote({ note: "─", beatFrac: 0.25 }),
    createNote({ note: "3" }),
  ));
  assert.equal(events[0].duration, 2.25 * 0.92);
  assert.deepEqual(events.map(e => e.start), [0, 0.5, 2, 2.25]);
});

test("rests and new pitches break sustain; leading extensions remain silent", () => {
  const events = compileEvents(scoreOf(
    createExtend(), createNote(), createNote({ note: "0" }), createExtend(),
    createNote({ note: "2" }), createExtend(), createNote({ note: "3" }),
  ));
  assert.deepEqual(events.map(e => [e.start, e.index, e.midi]), [
    [1, 1, 60], [2, 2, null], [4, 4, 62], [5, 5, null], [6, 6, 64],
  ]);
  assert.equal(events[0].duration, 0.92);
  assert.equal(events[2].duration, 2 * 0.92);
});

test("ties to pitches or extensions consume each extension only once", () => {
  for (const target of [createNote(), createExtend()]) {
    const first = createNote({ tieTo: target.key });
    target.tieTo = first.key;
    const events = compileEvents(scoreOf(first, target, createExtend(), createNote({ note: "2" })));
    assert.deepEqual(events.map(e => [e.start, e.index, e.midi]), [
      [0, 0, 60], [1, 1, null], [2, 2, null], [3, 3, 62],
    ]);
    assert.equal(events[0].duration, 3 * 0.92);
  }
});

test("a terminal extension retains the full playback timeline", () => {
  const events = compileEvents(scoreOf(createNote(), createExtend(), createExtend()));
  assert.equal(events.filter(e => e.midi !== null).length, 1);
  assert.equal(events[0].duration, 3 * 0.92);
  assert.equal(events.at(-1)!.start + events.at(-1)!.duration, 3);
});

test("both triangle decorators produce the same staccato duration", () => {
  for (const mark of ["▼", "▾"]) {
    const events = compileEvents(scoreOf(createNote({ topDecorators: [mark] }), createNote()));
    assert.equal(events[0].duration, 0.45);
    assert.equal(events[1].start, 1);
  }
});
