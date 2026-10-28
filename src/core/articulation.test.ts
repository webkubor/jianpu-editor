/**
 * 吐音包络回归：验证 T/K 合成差异，同时保持时值、事件数和高亮回调。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBar, createExtend, createNote, createParagraph, createScore } from "./model.ts";
import type { Notation, Score } from "./model.ts";
import { compileEvents, Player } from "./player.ts";

const scoreOf = (...notations: Notation[]) => createScore({
  speed: 60, paragraphs: [createParagraph(notations)],
});
const tongued = (init: Partial<Notation> = {}) => createNote({
  underline: 2, technique: { tonguing: "TK" }, ...init,
});
type Point = { value: number; time: number };

function synthesize(score: Score) {
  const envelopes: Point[][] = [];
  const starts: number[] = [];
  const stops: number[] = [];
  const highlights: number[][] = [];
  const delays: number[] = [];
  class AudioContextMock {
    currentTime = 0;
    destination = {};
    resume = async () => {};
    close = async () => {};
    createGain() {
      const points: Point[] = [];
      envelopes.push(points);
      const record = (value: number, time: number) => points.push({ value, time });
      return {
        gain: { value: 0, setValueAtTime: record, linearRampToValueAtTime: record },
        connect: (target: unknown) => target,
      };
    }
    createOscillator() {
      return {
        type: "sine", frequency: { value: 0 }, connect: (target: unknown) => target,
        start: (at: number) => starts.push(at), stop: (at: number) => stops.push(at),
      };
    }
  }
  const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: AudioContextMock });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout: (callback: () => void, delay: number) => {
      delays.push(delay);
      callback();
      return 0;
    } },
  });
  const player = new Player();
  try {
    const events = compileEvents(score);
    // 应用在播放前用对象展开平移起点，吐音信息必须随副本保留。
    player.play(events.map(event => ({ ...event, start: event.start - 0 })), {
      onNote: (index, paragraph) => highlights.push([index, paragraph]),
    });
    return { events, envelopes: envelopes.filter(points => points.length > 0), starts, stops, highlights, delays };
  } finally {
    player.stop();
    if (audioDescriptor) Object.defineProperty(globalThis, "AudioContext", audioDescriptor);
    else Reflect.deleteProperty(globalThis, "AudioContext");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

const attacks = (result: ReturnType<typeof synthesize>) => result.envelopes.map(points =>
  Math.round((points[1].time - points[0].time) * 1000));

test("metadata produces alternating T/K envelopes; tongued notes keep full printed value", () => {
  const notes = Array.from({ length: 8 }, () => tongued({ topDecorators: ["▼"] }));
  const score = scoreOf(...notes);
  const before = JSON.stringify(score);
  const result = synthesize(score);
  // ▼ 为吐音记号：带 T/K 指令时不按跳音缩短，起点与光标仍与无指令时一致。
  const plain = compileEvents(scoreOf(...notes.map(note => ({ ...note, technique: undefined }))));
  assert.deepEqual(result.events.map(event => [event.start, event.index, event.midi]),
    plain.map(event => [event.start, event.index, event.midi]));
  assert.deepEqual(result.events.map(event => event.duration), Array(8).fill(0.25));
  assert.equal(JSON.stringify(score), before);
  assert.deepEqual(attacks(result), [5, 12, 5, 12, 5, 12, 5, 12]);
  assert.ok(result.envelopes[1][1].value < result.envelopes[0][1].value);
  result.events.forEach((event, index) => {
    assert.equal(result.envelopes[index][3].time, 0.05 + event.start + event.duration);
    assert.deepEqual(result.starts.slice(index * 3, index * 3 + 3), Array(3).fill(0.05 + event.start));
    assert.deepEqual(result.stops.slice(index * 3, index * 3 + 3), Array(3).fill(0.05 + event.start + event.duration + 0.02));
    assert.deepEqual(result.highlights[index], [event.index, event.paragraph]);
    assert.equal(result.delays[index], (0.05 + event.start) * 1000);
  });
});

test("triangle decorators alone retain single-tongue staccato playback", () => {
  for (const mark of ["▼", "▾"]) {
    const result = synthesize(scoreOf(...Array.from({ length: 4 }, () =>
      createNote({ underline: 2, topDecorators: [mark] }))));
    assert.deepEqual(attacks(result), [20, 20, 20, 20]);
    assert.deepEqual(result.events.map(event => event.duration), Array(4).fill(0.25 * 0.45));
  }
});

test("sixteenth parity resets at beats, breaks, rests, bars and paragraphs", () => {
  const score = scoreOf(
    createNote({ underline: 1 }), tongued(), tongued(), // beat 0: T K
    tongued(), tongued({ breakUnderline: true }), tongued(), // beat 1: T T K
    createNote({ note: "0", underline: 2 }),
    tongued(), createBar(), tongued(), tongued(),
  );
  score.paragraphs.push(createParagraph([tongued(), tongued()]));
  assert.deepEqual(attacks(synthesize(score)), [20, 5, 12, 5, 5, 12, 5, 5, 12, 5, 12]);
});

test("all tonguing metadata uses note parity and survives explicit repeats", () => {
  const result = synthesize(scoreOf(
    createBar("||:"), ...(["T", "K", "TK", "TKT"] as const).map(tonguing =>
      tongued({ technique: { tonguing } })), createBar(":||"),
  ));
  assert.deepEqual(attacks(result), [5, 12, 5, 12, 5, 12, 5, 12]);
  assert.deepEqual(result.highlights, [[1, 0], [2, 0], [3, 0], [4, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
});

test("tongued ties and extensions keep one sounding event and original cursor events", () => {
  const target = tongued();
  const first = tongued({ tieTo: target.key });
  const result = synthesize(scoreOf(first, target, createExtend(), createNote()));
  assert.equal(result.events.length, 4);
  assert.equal(result.events[0].duration, 1.5);
  assert.deepEqual(result.events.map(event => [event.start, event.index, event.midi]), [
    [0, 0, 60], [0.25, 1, null], [0.5, 2, null], [1.5, 3, 60],
  ]);
  assert.deepEqual(attacks(result), [5, 20]);
});
