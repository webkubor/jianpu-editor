/**
 * 核心层测试：DSL 编译 / 转调 / 序列化 / 事件编译
 * 运行：node --experimental-strip-types --test src/core/*.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLine, tokenizeLine } from "./dsl.ts";
import { transpose, transposeTo, parseTone } from "./transpose.ts";
import { serializeScore, deserializeScore } from "./serialize.ts";
import { compileEvents, noteBeats } from "./player.ts";
import { createScore, createNote } from "./model.ts";

test("tokenize：基本音符流", () => {
  const { tokens, beatBreaks } = tokenizeLine("1 2 3 | 6, 5 ‖");
  assert.equal(tokens.filter((t) => t.t === "note").length, 5);
  assert.deepEqual(
    tokens.map((t) => t.t),
    ["note", "note", "note", "bar", "note", "note", "bar"]
  );
  assert.ok(beatBreaks.size === 0); // 单空格不产生拍边界
});

test("tokenize：双空格产生拍边界", () => {
  const { tokens, beatBreaks } = tokenizeLine("1 2  3 4");
  assert.equal(tokens.length, 4);
  assert.deepEqual([...beatBreaks], [2]); // 第 2 个 token 前是拍边界
});

test("tokenize：升降号/八度/附点", () => {
  const { tokens } = tokenizeLine("#4, b7. ^1");
  assert.equal(tokens.length, 3);
  const n1 = JSON.parse(JSON.stringify(tokens[0]));
  const n2 = JSON.parse(JSON.stringify(tokens[1]));
  const n3 = JSON.parse(JSON.stringify(tokens[2]));
  assert.deepEqual(n1.accidentals, ["♯"]);
  assert.equal(n1.octave, -1);
  assert.deepEqual(n2.accidentals, ["♭"]);
  assert.equal(n2.dotted, true);
  assert.equal(n3.octave, 1);
});

test("compileLine：组内 n 音 → n-1 条减时线", () => {
  const para = compileLine("1 2 3  4");
  assert.equal(para.notations.length, 4);
  // 三音平分一拍 → 各 2 条减时线；双空格后单独一拍一个音 → 0 条
  assert.equal(para.notations[0].underline, 2);
  assert.equal(para.notations[1].underline, 2);
  assert.equal(para.notations[2].underline, 2);
  assert.equal(para.notations[3].underline, 0);
});

test("compileLine：两音组 → 1 条减时线", () => {
  const para = compileLine("1 2  3 4");
  assert.equal(para.notations[0].underline, 1);
  assert.equal(para.notations[1].underline, 1);
  assert.equal(para.notations[2].underline, 1);
  assert.equal(para.notations[3].underline, 1);
});

test("compileLine：延音线继承前音层数", () => {
  const para = compileLine("1 2 -");
  const [a, b, ext] = para.notations;
  assert.equal(a.underline, 1);
  assert.equal(b.underline, 1);
  assert.equal(ext.note, "─");
  assert.equal(ext.underline, 1);
});

test("compileLine：tie 建立双向连接", () => {
  const para = compileLine("1~1");
  const [a, b] = para.notations;
  assert.equal(a.tieTo, b.key);
  assert.equal(b.tieTo, a.key);
});

test("compileLine：歌词行对齐发声符号，- 占位跳过", () => {
  const para = compileLine("[词:你 好 - 吗] 1 2 - 3");
  // 发声符号：1 2 - 3 → 4 个词位；第三个 - 占位跳过
  assert.deepEqual(para.lyrics, ["你", "好", "", "吗"]);
  assert.equal(para.notations.length, 4);
});

test("compileLine：无歌词行 lyrics 为空", () => {
  const para = compileLine("1 2 3");
  assert.deepEqual(para.lyrics, []);
});

test("compileScore：词行修饰上方最近音符行", async () => {
  const { compileScore } = await import("./dsl.ts");
  const score = compileScore("1 2 3\n[词:你 好 -]\n5 6");
  assert.equal(score.paragraphs.length, 2);
  assert.deepEqual(score.paragraphs[0].lyrics, ["你", "好", ""]);
  assert.deepEqual(score.paragraphs[1].lyrics, []);
});

test("transpose：C→D 全体 +2 半音，3 升 E 不带号", () => {
  const score = createScore({ tone: "C" });
  score.paragraphs[0].notations = [
    createNote({ note: "1" }),
    createNote({ note: "3" }),
    createNote({ note: "7" }),
  ];
  transpose(score, 2);
  assert.equal(score.paragraphs[0].notations[0].note, "2");
  assert.equal(score.paragraphs[0].notations[1].note, "4");
  assert.equal(score.paragraphs[0].notations[2].note, "1");
  assert.equal(score.paragraphs[0].notations[2].octave, 1); // B(11)+2=13 → 高八度 1
});

test("transpose：F# 音级惯用记号", () => {
  const score = createScore({ tone: "C" });
  score.paragraphs[0].notations = [createNote({ note: "4" })]; // F(5)
  transpose(score, 1); // → F♯(6)
  assert.equal(score.paragraphs[0].notations[0].note, "4");
  assert.deepEqual(score.paragraphs[0].notations[0].prefixAccidentals, ["♯"]);
});

test("transposeTo：♭B 谱转 C 谱", () => {
  const score = createScore({ tone: "♭B" });
  score.paragraphs[0].notations = [createNote({ note: "1" }), createNote({ note: "5" })];
  assert.ok(transposeTo(score, "C"));
  assert.equal(score.tone, "C");
  // ♭B 的 do=B♭(10)，转 C 需 +2：do→2，sol→6
  assert.equal(score.paragraphs[0].notations[0].note, "2");
  assert.equal(score.paragraphs[0].notations[1].note, "6");
});

test("parseTone：各种写法", () => {
  assert.equal(parseTone("C"), 0);
  assert.equal(parseTone("♯F"), 6);
  assert.equal(parseTone("bB"), 10);
  assert.equal(parseTone("♭B"), 10);
  assert.equal(parseTone("H"), null);
});

test("serialize：往返无损", () => {
  const score = createScore({ title: "测试", tone: "♭B" });
  score.paragraphs[0].notations.push(createNote({ note: "6", octave: -1, underline: 2 }));
  const back = deserializeScore(serializeScore(score));
  assert.ok(back);
  assert.equal(back.title, "测试");
  assert.equal(back!.paragraphs[0].notations[0].note, "6");
  assert.equal(back!.paragraphs[0].notations[0].underline, 2);
  assert.equal(back!.paragraphs[0].notations[0].octave, -1);
});

test("serialize：坏数据返回 null", () => {
  assert.equal(deserializeScore("not json"), null);
  assert.equal(deserializeScore('{"schema":"other"}'), null);
});

test("player：事件编译时值", () => {
  const score = createScore({ tone: "C", speed: 60 }); // 一拍 = 1s
  score.paragraphs[0].notations = [
    createNote({ note: "1" }), // 1 拍
    createNote({ note: "2", underline: 1 }), // 1/2 拍
    createNote({ note: "3", dotted: true }), // 1.5 拍
  ];
  const events = compileEvents(score);
  assert.equal(events.length, 3);
  assert.equal(noteBeats({ underline: 1, dotted: true }), 0.75);
  assert.ok(Math.abs(events[0].duration - 0.92) < 1e-9); // 1拍*0.92
  assert.ok(Math.abs(events[1].start - 1) < 1e-9);
  assert.ok(Math.abs(events[2].start - 1.5) < 1e-9);
  assert.equal(events[0].midi, 60); // C 调 do = C4
});

test("player：♭B 调 do 是 B♭", () => {
  const score = createScore({ tone: "♭B", speed: 60 });
  score.paragraphs[0].notations = [createNote({ note: "1" })];
  const events = compileEvents(score);
  assert.equal(events[0].midi, 70); // B♭4
});

test("validateScore：4/4 小节拍数校验", async () => {
  const { validateScore } = await import("./validate.ts");
  const { compileScore } = await import("./dsl.ts");
  const ok = compileScore("1 - - - | 5 - - - ‖");
  assert.deepEqual(validateScore(ok), []); // 每小节 4 拍 ✓
  const bad = compileScore("1 - - | 5 - - - ‖"); // 第一小节 3 拍 ✗
  const issues = validateScore(bad);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].beats, 3);
  assert.equal(issues[0].expected, 4);
});
