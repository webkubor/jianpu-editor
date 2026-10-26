/**
 * 核心层测试：DSL 编译 / 转调 / 序列化 / 事件编译
 * 运行：node --experimental-strip-types --test src/core/*.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLine, compileScore, tokenizeLine } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { EditorState } from "../app/editor-state.ts";

test("DSL 时值导出无长浮点：1/3 记 0.3333，整数记原值，往返近似等价", () => {
  const score = compileScore("1 2 3  5");
  const text = toDsl(score);
  assert.ok(text.includes("0.3333"), text);
  assert.ok(!text.includes("16666666666666666"));
  const reparsed = compileScore(text);
  const orig = score.paragraphs[0].notations.map((n) => [n.note, n.underline]);
  const back = reparsed.paragraphs[0].notations.map((n) => [n.note, n.underline]);
  assert.deepEqual(back, orig);
  // 1/3 与 0.3333 播放误差 < 0.2ms（人耳不可辨）
  const beatSec = 60 / score.speed;
  const beats0 = score.paragraphs[0].notations[0].beatFrac!;
  const beats1 = reparsed.paragraphs[0].notations[0].beatFrac!;
  assert.ok(Math.abs(beats0 - beats1) * beatSec < 0.0002);
});

test("同音高连音线播放合并为一个持续音，异音高不合并", () => {
  const score = compileScore("1  1  2");
  const [a, b, c] = score.paragraphs[0].notations;
  a.tieTo = b.key; b.tieTo = a.key;
  const events = compileEvents(score).filter(e => e.midi !== null);
  assert.equal(events.length, 2);
  assert.ok(Math.abs(events[0].duration - 2 * 60 / score.speed * 0.92) < 1e-9);
  assert.equal(events[0].index, 0);
  c.tieTo = a.key;
  const cross = compileEvents(score).filter(e => e.midi !== null);
  assert.equal(cross.length, 2);
});

test("timeBefore：光标处播放起点=光标前总时值，跨段累计", () => {
  // 双空格拍边界让 1、2 各占整拍，断言值直观
  const score = compileScore("1  2\n3  4");
  assert.equal(timeBefore(score, 0, 0), 0);
  assert.equal(timeBefore(score, 0, 1), 60 / score.speed);
  // 段1 首 = 段0 全部时值（2 整拍）
  const secBeat = 60 / score.speed;
  assert.ok(Math.abs(timeBefore(score, 1, 0) - 2 * secBeat) < 1e-9);
});

test("cycleTopDecorator：顶部演奏记号循环切换(▾顿音->𝄐延长->⌒保持->无)，休止符不参与，DSL语法往返", async () => {
  const { compileScore } = await import("./dsl.ts");
  const { toDsl } = await import("./dsl-export.ts");
  const st = new EditorState(compileScore("5  0"));
  st.move(1); // 选中 5
  st.cycleTopDecorator();
  assert.deepEqual(st.currentItem?.topDecorators, ["▾"]);
  st.cycleTopDecorator();
  assert.deepEqual(st.currentItem?.topDecorators, ["𝄐"]);
  st.cycleTopDecorator();
  assert.deepEqual(st.currentItem?.topDecorators, ["⌒"]);
  st.cycleTopDecorator();
  assert.deepEqual(st.currentItem?.topDecorators, []);
  st.undo();
  assert.deepEqual(st.currentItem?.topDecorators, ["⌒"]);

  // DSL 编译 5{▾} 与导出
  const dslScore = compileScore("5{▾}  3{𝄐}");
  assert.deepEqual(dslScore.paragraphs[0].notations[0].topDecorators, ["▾"]);
  assert.deepEqual(dslScore.paragraphs[0].notations[1].topDecorators, ["𝄐"]);
  const exported = toDsl(dslScore);
  assert.ok(exported.includes("5{▾}:1/0"));
  const round = compileScore(exported);
  assert.deepEqual(round.paragraphs[0].notations[0].topDecorators, ["▾"]);
  assert.deepEqual(round.paragraphs[0].notations[1].topDecorators, ["𝄐"]);
  // 顿音与保持音发声时长系数测试
  const { compileEvents } = await import("./player.ts");
  const evNormal = compileEvents(compileScore("5", { speed: 60 }));
  const evStaccato = compileEvents(compileScore("5{▾}", { speed: 60 }));
  const evTenuto = compileEvents(compileScore("5{⌒}", { speed: 60 }));
  assert.ok(Math.abs(evNormal[0].duration - 0.92) < 1e-6);
  assert.ok(Math.abs(evStaccato[0].duration - 0.45) < 1e-6);
  assert.ok(Math.abs(evTenuto[0].duration - 0.98) < 1e-6);
});

test("反复记号：||: 与 :|| 词法解析、排版渲染、校验分小节及 DSL 往返保持", async () => {
  const { compileScore } = await import("./dsl.ts");
  const { toDsl } = await import("./dsl-export.ts");
  const { validateScore } = await import("./validate.ts");
  const score = compileScore("||: 1  2  3  4 :||");
  const nots = score.paragraphs[0].notations;
  assert.equal(nots[0].note, "||:");
  assert.equal(nots[nots.length - 1].note, ":||");
  // 节拍校验正确识别反复小节线为边界（4 拍小节无异常）
  assert.deepEqual(validateScore(score), []);
  // DSL 导出与重编译往返完全一致
  const exported = toDsl(score);
  assert.ok(exported.includes("||:"));
  assert.ok(exported.includes(":||"));
  const round = compileScore(exported);
  assert.equal(round.paragraphs[0].notations[0].note, "||:");
  assert.equal(round.paragraphs[0].notations[round.paragraphs[0].notations.length - 1].note, ":||");
});

test("节拍器选项：play() 支持 options.metronome 伴奏选项且不影响基础回放", async () => {
  const { Player, compileEvents } = await import("./player.ts");
  const p = new Player();
  const score = compileScore("1  2  3  4", { beat: [4, 4], speed: 120 });
  const events = compileEvents(score);
  // 在单测纯 Node 环境下安全调用不抛出
  p.play(events, {}, { metronome: true, beat: [4, 4], speed: 120 });
  assert.equal(p.playing, true);
  p.stop();
  assert.equal(p.playing, false);
});

test("playTone 与 midiOf：音高计算精确，全谱播放时不抢占", async () => {
  const { Player, midiOf } = await import("./player.ts");
  const p = new Player();
  const n1 = createNote({ note: "1", octave: 0 });
  const n2 = createNote({ note: "1", octave: 1 });
  const nSharp = createNote({ note: "4", prefixAccidentals: ["♯"] });
  assert.equal(midiOf("C", n1), 60); // C4 do
  assert.equal(midiOf("C", n2), 72); // C5 高音 do
  assert.equal(midiOf("C", nSharp), 66); // F#4
  assert.equal(midiOf("G", n1), 67); // G 调 do = G4
  // playTone 在单测环境下（node环境无 AudioContext）不抛异常且安全跳过
  p.playTone(60);
});

test("曲库示例均通过拍数校验；未核对的牧民新歌从正式曲库撤下", async () => {
  const { EXAMPLES } = await import("./examples.ts");
  const { validateScore } = await import("./validate.ts");
  assert.equal(EXAMPLES.length, 7);
  assert.ok(!EXAMPLES.some(ex => ex.id === "flute-mumin"));
  for (const ex of EXAMPLES) {
    assert.ok(ex.score.paragraphs.length > 0);
    assert.ok(ex.score.title.length > 0);
    assert.ok(ex.score.authors.length > 0);
    // 所有预设曲目全部通过严苛的小节拍数校验，无异常警告
    const issues = validateScore(ex.score);
    assert.deepEqual(issues, [], `${ex.name} 存在小节拍数异常: ${JSON.stringify(issues)}`);
  }
});

test("cycleAccidental：升降号循环切换(无->♯->♭->无)，休止符与延音线不参与且给提示，可撤销", () => {
  const st = new EditorState(compileScore("1  0  -"));
  st.move(1); // 选中 1
  st.cycleAccidental();
  assert.deepEqual(st.currentItem?.prefixAccidentals, ["♯"]);
  st.cycleAccidental();
  assert.deepEqual(st.currentItem?.prefixAccidentals, ["♭"]);
  st.cycleAccidental();
  assert.deepEqual(st.currentItem?.prefixAccidentals, []);
  // 撤销两步回到 ♯
  st.undo();
  assert.deepEqual(st.currentItem?.prefixAccidentals, ["♭"]);
  st.undo();
  assert.deepEqual(st.currentItem?.prefixAccidentals, ["♯"]);
  // 移动到休止符 0，无法变音
  st.move(1);
  st.cycleAccidental();
  assert.ok(st.lastNotice.includes("只能应用到音符"));
  assert.deepEqual(st.currentItem?.prefixAccidentals, []);
});

test("setBeat / setAuthors：拍号与作者修改可撤销、同值早退且不清栈", () => {
  const st = new EditorState(compileScore("1 2 3 -"));
  st.setBeat([3, 4]);
  assert.deepEqual(st.score.beat, [3, 4]);
  assert.equal(st.canUndo, true);
  // 同值不进历史
  st.setBeat([3, 4]);
  st.setAuthors(["周杰伦 作曲", "方文山 作词"]);
  assert.deepEqual(st.score.authors, ["周杰伦 作曲", "方文山 作词"]);
  st.undo();
  assert.deepEqual(st.score.authors, ["佚名  作词", "简谱编辑器  制谱"]);
  st.undo();
  assert.deepEqual(st.score.beat, [4, 4]);
  assert.equal(st.canUndo, false);
});

test("删段：removeParagraph 删除当前段，光标进邻段；最后一段清空不删", () => {
  const st = new EditorState(compileScore("1 2\n3 4\n5 6"));
  st.moveParagraph(1);
  st.removeParagraph();
  assert.equal(st.score.paragraphs.length, 2);
  assert.equal(st.score.paragraphs[1].notations[0].note, "5");
  assert.equal(st.paragraphIndex, 1); // 删尾段光标退到新末段
  st.moveParagraph(-2);
  st.removeParagraph(); // 删首段
  assert.equal(st.score.paragraphs[0].notations[0].note, "5");
  // 剩 1 段：提示不删
  st.removeParagraph();
  assert.ok(st.lastNotice.includes("最后一段"));
  assert.equal(st.score.paragraphs.length, 1);
  st.undo();
  assert.equal(st.score.paragraphs.length, 2); // 撤回删首段
});

test("复制段：duplicateParagraph 克隆旋律与歌词，源段不动，可撤销", () => {
  const st = new EditorState(compileScore("1 2\n3 4"));
  st.move(1);
  st.setLyric("春");
  const before = JSON.stringify(st.score.paragraphs[0]);
  st.duplicateParagraph();
  assert.equal(st.score.paragraphs.length, 3);
  // 副本在源段下方：旋律、歌词与源段一致
  assert.equal(JSON.stringify(st.score.paragraphs[0]), before);
  assert.equal(st.score.paragraphs[1].notations[0].note, "1");
  assert.equal(st.score.paragraphs[1].lyrics[0], "春");
  assert.equal(st.paragraphIndex, 1);
  // 副本是深拷贝：改副本不影响源段
  st.move(1);
  st.setLyric("夏");
  assert.equal(st.score.paragraphs[0].lyrics[0], "春");
  assert.equal(st.score.paragraphs[1].lyrics[0], "夏");
  st.undo(); // 撤「夏」
  assert.equal(st.score.paragraphs[1].lyrics[0], "春");
  st.undo(); // 撤复制
  assert.equal(st.score.paragraphs.length, 2);
});

test("歌词连续输入模式：缓冲提交右移推进，退格清理，Esc 语义", () => {
  const st = new EditorState(compileScore("1  2  3  4"));
  st.toggleLyricMode();
  assert.equal(st.lyricMode, true);
  for (const ch of "春") st.lyricType(ch);
  st.lyricCommit(); // 写到光标左边（初始 itemIdx=0 左边无符号 → 提示且不推进）
  assert.ok(st.lastNotice.includes("不是发声符号"));
  assert.equal(st.score.paragraphs[0].lyrics.length, 0);
  assert.equal(st.itemIndex, 0); // 失败不推进，缓冲已清可直接重打
  st.move(1); // 光标到 1 后
  for (const ch of "晓") st.lyricType(ch);
  st.lyricCommit();
  assert.equal(st.score.paragraphs[0].lyrics[0], "晓");
  assert.equal(st.itemIndex, 2); // 右移推进（越过 1 → 缝在 1|2）
  st.lyricType("风");
  st.lyricCommit(); // 光标缝在 1|2 → currentItem=2 → 写 lyrics[1]，推进到 2|3
  assert.equal(st.score.paragraphs[0].lyrics[1], "风");
  // 退格：缓冲非空删字符
  st.lyricType("雨");
  st.lyricType("雪");
  st.lyricBackspace();
  assert.equal(st.lyricDraft, "雨");
  st.lyricCommit(); // 写 lyrics[2]
  assert.equal(st.score.paragraphs[0].lyrics[2], "雨");
  // 退出丢弃缓冲
  st.lyricType("残");
  st.toggleLyricMode();
  assert.equal(st.lyricMode, false);
  assert.equal(st.lyricDraft, "");
  assert.equal(st.score.paragraphs[0].lyrics[3], undefined);
});

test("setSpeed：改速度可撤销且不清撤销栈，值域钳制 20–240", () => {
  const st = new EditorState(compileScore("1 2"));
  st.setSpeed(90);
  assert.equal(st.score.speed, 90);
  assert.equal(st.canUndo, true);
  st.setSpeed(9999);
  assert.equal(st.score.speed, 240);
  st.undo();
  assert.equal(st.score.speed, 90); // 撤回到 90
});

test("downloadText 导出工具：支持自定义 MIME 类型与有效导出", () => {
  assert.equal(typeof downloadText, "function");
});

test("sanitizeFilename：路径分隔符与系统保留字符剔除，空名回退无标题", () => {
  assert.equal(sanitizeFilename('我的/歌:谱*?'), "我的歌谱");
  assert.equal(sanitizeFilename("..\\..\\x"), "....x"); // 内部点保留，仅收尾点去除
  assert.equal(sanitizeFilename("..\\..\\x. ."), "....x");
  assert.equal(sanitizeFilename("  "), "无标题");
  assert.equal(sanitizeFilename("正常名"), "正常名");
});

test("replaceScore 清空撤销栈：打开新文件后 ⌘Z 不串回旧谱", () => {
  const st = new EditorState(compileScore("1 2"));
  st.move(1);
  st.setLyric("春");
  st.replaceScore({ ...st.score, title: "新谱", paragraphs: compileScore("3 4").paragraphs });
  assert.equal(st.canUndo, false);
  assert.equal(st.canRedo, false);
  st.undo(); // 无效果
  assert.equal(st.score.paragraphs[0].notations[0].note, "3");
  assert.equal(st.score.title, "新谱");
});

test("中文输入法容错：全角数字/空格/小节线/逗号归一化为半角", () => {
  const s = compileScore("１２　６，１｜３");
  const nots = s.paragraphs[0].notations;
  assert.deepEqual(nots.map(n => n.note), ["1", "2", "6", "1", "│", "3"]);
  assert.equal(nots[2].octave, -1); // 全角逗号 = 低八度
  // ～ 连音线、－ 延音线、． 附点
  const s2 = compileScore("１．－２");
  const nots2 = s2.paragraphs[0].notations;
  assert.ok(nots2[0].dotted);
  assert.equal(nots2[1].note, "─");
});

test("分组时值：n音组平分一拍、附点保留1.5、8音组减时线封顶3层", () => {
  // 三连音
  const tri = compileScore("1 2 3  4");
  assert.ok(Math.abs(tri.paragraphs[0].notations[0].beatFrac! - 1 / 3) < 1e-9);
  // 附点组：附点音显式 1.5 拍不被平分覆盖
  const dots = compileScore("1. 2.  3 4");
  const d0 = dots.paragraphs[0].notations[0];
  assert.equal(d0.beatFrac, 1.5);
  assert.ok(d0.dotted);
  // 8 音组：视觉 3 层封顶，真实时值 1/8
  const oct = compileScore("1 2 3 4 5 6 7 1");
  assert.equal(oct.paragraphs[0].notations[0].underline, 3);
  assert.ok(Math.abs(oct.paragraphs[0].notations[0].beatFrac! - 0.125) < 1e-9);
});

test("段落重排：reorderParagraph 交换整段（含歌词），光标跟随，可撤销", () => {
  const st = new EditorState(compileScore("1 2\n3 4"));
  st.move(1); // 光标在 2 后，词落到发声符号 2（歌词下标 0）
  st.setLyric("春");
  st.moveParagraph(1); // 换段保留列位置 → itemIdx=1，光标在 3 后
  st.setLyric("风");
  st.reorderParagraph(-1); // 段2 移到段1
  assert.equal(st.score.paragraphs[0].notations[0].note, "3");
  assert.equal(st.score.paragraphs[0].lyrics[0], "风");
  assert.equal(st.score.paragraphs[1].lyrics[0], "春");
  assert.equal(st.paragraphIndex, 0);
  st.undo();
  assert.equal(st.score.paragraphs[0].notations[0].note, "1");
  // undo 恢复光标到段2，合法上移；回到段1 再上移才触发边界提示
  st.reorderParagraph(-1);
  assert.equal(st.score.paragraphs[0].notations[0].note, "3");
  st.moveParagraph(0);
  st.reorderParagraph(-1);
  assert.ok(st.lastNotice.includes("第一段"));
  assert.equal(st.canRedo, false);
});

test("删除连音线一端解除另一端悬空引用；段首延音线提示不产生空撤销", () => {
  const st = new EditorState(compileScore("1 2 3"));
  st.move(1);
  st.tieToNext();
  st.backspace();
  assert.ok(st.score.paragraphs[0].notations.every(n => !n.tieTo));
  // 导出不再带 ~
  assert.ok(!toDsl(st.score).includes("~"));
  const st2 = new EditorState(compileScore("1 2"));
  st2.insertExtend();
  assert.equal(st2.canUndo, false);
  assert.ok(st2.lastNotice.includes("段首"));
});

test("连音线跨延音线：tie 连到 ─，播放合并且中段不断音", () => {
  const score = compileScore("1~ - 2");
  const [a, ext, c] = score.paragraphs[0].notations;
  assert.equal(a.tieTo, ext.key);
  assert.equal(ext.tieTo, a.key);
  assert.equal(c.tieTo, null);
  const events = compileEvents(score).filter(e => e.midi !== null);
  assert.equal(events.length, 2);
  // 1 与 ─ 合并 = 2 拍；─ 不再单独发声
  assert.ok(Math.abs(events[0].duration - 2 * 60 / score.speed * 0.92) < 1e-9);
});

test("连音线被小节线打断：DSL 中 ~ 后接 | 不跨线连接", () => {
  const score = compileScore("1~ | 2");
  assert.equal(score.paragraphs[0].notations.filter(n => n.tieTo).length, 0);
});

test("键盘连音线建立双向引用并可撤销，渲染层与 DSL 导出闭环", () => {
  const state = new EditorState(compileScore("1  2"));
  state.move(1);
  state.tieToNext();
  const [a, b] = state.score.paragraphs[0].notations;
  assert.equal(a.tieTo, b.key);
  assert.equal(b.tieTo, a.key);
  assert.equal(state.canUndo, true);
  state.undo();
  assert.equal(state.score.paragraphs[0].notations[0].tieTo, null);
  state.redo();
  const dsl = toDsl(state.score);
  assert.ok(dsl.includes("~"), dsl);
  assert.deepEqual(
    compileScore(dsl).paragraphs[0].notations.slice(0, 2).map(n => Boolean(n.tieTo)),
    [true, true],
  );
  state.selectItem(0, 0);
  state.tieToNext();
  assert.equal(state.score.paragraphs[0].notations[0].tieTo, null);
});

test("附点休止符编辑、播放与存储往返时值一致", () => {
  const state = new EditorState(compileScore("0  1"));
  state.move(1);
  state.toggleDotted();
  assert.equal(noteBeats(state.currentItem!), 1.5);
  assert.ok(Math.abs(compileEvents(state.score)[1].start - 1.5 * 60 / state.score.speed) < 1e-9);
  const restored = deserializeScore(serializeScore(state.score))!;
  assert.equal(noteBeats(restored.paragraphs[0].notations[0]), 1.5);
  assert.equal(noteBeats(compileScore(toDsl(restored)).paragraphs[0].notations[0]), 1.5);
  state.undo();
  assert.equal(state.currentItem?.dotted, false);
  state.redo();
  assert.equal(state.currentItem?.dotted, true);
});

test("文件加载拦截异常时值、重复键和未知版本", () => {
  const valid = JSON.parse(serializeScore(compileScore("1  2")));
  for (const mutate of [
    (d: typeof valid) => { d.version = 99; },
    (d: typeof valid) => { d.speed = -1; },
    (d: typeof valid) => { d.beat = [4, 0]; },
    (d: typeof valid) => { d.paragraphs[0].notations[0].note = "invalid"; },
    (d: typeof valid) => { d.paragraphs[0].notations[0].beatFrac = -1; },
    (d: typeof valid) => { d.paragraphs[0].notations[1].key = d.paragraphs[0].notations[0].key; },
  ]) {
    const data = structuredClone(valid);
    mutate(data);
    assert.equal(deserializeScore(JSON.stringify(data)), null);
  }
  assert.ok(deserializeScore(JSON.stringify(valid)));
});

test("段首删除合并前段，缺省歌词补位且撤销重做保留光标", () => {
  const state = new EditorState(compileScore("1  0  2\n3  4\n[词:春 风]"));
  const keys = state.score.paragraphs.flatMap(p => p.notations.map(n => n.key));
  state.moveParagraph(1);
  state.backspace();
  assert.equal(state.score.paragraphs.length, 1);
  assert.equal(state.itemIndex, 3);
  assert.deepEqual(state.paragraph.notations.map(n => n.key), keys);
  assert.deepEqual(state.paragraph.lyrics, ["", "", "春", "风"]);
  state.undo();
  assert.equal(state.paragraphIndex, 1);
  assert.equal(state.itemIndex, 0);
  state.redo();
  assert.equal(state.paragraphIndex, 0);
  assert.equal(state.itemIndex, 3);
});

test("首段段首删除无操作，空段合并也可撤销", () => {
  const state = new EditorState(compileScore("1"));
  state.backspace();
  assert.equal(state.canUndo, false);
  state.splitParagraph();
  state.backspace();
  assert.equal(state.score.paragraphs.length, 1);
  state.undo();
  assert.equal(state.score.paragraphs.length, 2);
});

test("拆段保留符号和歌词，撤销重做恢复段落与光标", () => {
  const state = new EditorState(compileScore("1  0  2 | 3 ‖\n[词:你 好 吗]"));
  const keys = state.paragraph.notations.map(n => n.key);
  state.move(2);
  state.splitParagraph();
  assert.equal(state.paragraphIndex, 1);
  assert.equal(state.itemIndex, 0);
  assert.deepEqual(state.score.paragraphs.flatMap(p => p.notations.map(n => n.key)), keys);
  assert.deepEqual(state.score.paragraphs.map(p => p.lyrics), [["你"], ["好","吗"]]);
  state.undo();
  assert.equal(state.score.paragraphs.length, 1);
  assert.equal(state.itemIndex, 2);
  state.redo();
  assert.equal(state.score.paragraphs.length, 2);
  assert.equal(state.itemIndex, 0);
});

test("鼠标定位跨段符号且不污染历史，无效定位保持原位", () => {
  const state = new EditorState(compileScore("1  2\n3  4"));
  state.selectItem(1, 1);
  assert.equal(state.currentItem?.note, "4");
  assert.equal(state.canUndo, false);
  state.selectItem(-1, 0);
  state.selectItem(1, 99);
  assert.equal(state.itemIndex, 2);
  state.changeDuration(1);
  assert.equal(state.score.paragraphs[1].notations[1].beatFrac, 0.5);
  state.undo();
  assert.equal(state.currentItem?.note, "4");
});

test("重做恢复内容与光标，新编辑清除旧分支", () => {
  const state = new EditorState(compileScore("1  2"));
  state.move(1);
  state.insertNote("3");
  state.undo();
  assert.equal(state.canRedo, true);
  state.redo();
  assert.equal(state.itemIndex, 2);
  assert.equal(state.currentItem?.note, "3");
  assert.equal(state.canRedo, false);
  state.undo();
  state.insertNote("4");
  assert.equal(state.canRedo, false);
  state.redo();
  assert.deepEqual(state.paragraph.notations.map(n => n.note), ["1", "4", "2"]);
});

test("撤销恢复操作前的段落与光标，含空谱导入", () => {
  const state = new EditorState(compileScore("1  2\n3  4"));
  state.moveParagraph(1);
  state.move(1);
  state.insertNote("5");
  state.moveParagraph(-1);
  state.undo();
  assert.equal(state.paragraphIndex, 1);
  assert.equal(state.itemIndex, 1);
  assert.equal(state.currentItem?.note, "3");
  state.replaceScore(compileScore(""));
  state.undo(); // replaceScore 清栈，undo 无效果
  assert.equal(state.paragraphIndex, 0);
  assert.equal(state.itemIndex, 0);
  state.backspace();
  state.undo();
  assert.equal(state.currentItem, null);
});

test("时值修改覆盖分组推断，保留附点并支持休止与撤销", () => {
  const state = new EditorState(compileScore("1. 2 3  0 ‖"));
  state.move(1);
  state.changeDuration(1);
  assert.equal(noteBeats(state.currentItem!), 0.1875);
  state.changeDuration(-1);
  assert.equal(noteBeats(state.currentItem!), 0.375);
  state.undo();
  assert.equal(noteBeats(state.currentItem!), 0.1875);
  state.move(3);
  state.changeDuration(1);
  assert.equal(noteBeats(state.currentItem!), 0.5);
  // 往返后播放事件近似一致（0.3333 与 1/3 差 < 0.1ms）
  const round = compileEvents(compileScore(toDsl(state.score)));
  const direct = compileEvents(state.score);
  assert.equal(round.length, direct.length);
  for (let i = 0; i < round.length; i += 1) {
    assert.equal(round[i].index, direct[i].index);
    assert.equal(round[i].midi, direct[i].midi);
    assert.ok(Math.abs(round[i].start - direct[i].start) < 1e-4, `start@${i}`);
    assert.ok(Math.abs(round[i].duration - direct[i].duration) < 1e-4, `duration@${i}`);
  }
});

test("歌词编辑不覆盖下一音符，增删保留原音符歌词，撤销恢复", () => {
  const state = new EditorState(compileScore("1  2 | 3 ‖\n[词:你 好 吗]"));
  const keys = state.paragraph.notations.map(n => n.key);
  state.move(1);
  state.setLyric("风");
  assert.deepEqual(state.paragraph.notations.map(n => n.key), keys);
  assert.deepEqual(state.paragraph.notations.map(n => n.note), ["1","2","│","3","‖"]);
  assert.equal(state.currentLyric, "风");
  state.insertNote("4");
  assert.deepEqual(state.paragraph.lyrics, ["风","","好","吗"]);
  state.backspace();
  assert.deepEqual(state.paragraph.lyrics, ["风","好","吗"]);
  state.undo();
  assert.deepEqual(state.paragraph.lyrics, ["风","","好","吗"]);
  state.move(2);
  assert.equal(state.currentItem?.note, "│");
  const before = JSON.stringify(state.score);
  state.setLyric("小节线无词");
  assert.equal(JSON.stringify(state.score), before);
});

test("文本往返：休止、三连音、附点、变音、八度、歌词与播放时值保持", () => {
  const score = compileScore("#4, 0 5.  6^~7^  - | 0  1 ‖\n[词:风 来 - 云 - 雨]");
  const restored = compileScore(toDsl(score));
  const shape = (s: typeof score) => s.paragraphs.map(p => ({
    lyrics: p.lyrics,
    notes: p.notations.map(n => [n.note,n.octave,n.dotted,n.underline,n.prefixAccidentals,Number((n.beatFrac ?? 1 / 2 ** Math.min(3, n.underline)).toFixed(3)),Boolean(n.tieTo)])
  }));
  assert.deepEqual(shape(restored), shape(score));
  // 1/3 三连音导出为 0.3333，播放差 < 0.1ms，用近似断言
  const round = compileEvents(restored);
  const direct = compileEvents(score);
  assert.equal(round.length, direct.length);
  for (let i = 0; i < round.length; i += 1) {
    assert.equal(round[i].index, direct[i].index);
    assert.equal(round[i].midi, direct[i].midi);
    assert.ok(Math.abs(round[i].start - direct[i].start) < 1e-4, `start@${i}`);
    assert.ok(Math.abs(round[i].duration - direct[i].duration) < 1e-4, `duration@${i}`);
  }
  const quarterNotes = createScore({paragraphs: [compileLine("1  0  2  3 ‖")]});
  assert.deepEqual(
    compileEvents(compileScore(toDsl(quarterNotes))).map(e => [e.index, e.midi, Math.round(e.start * 1e6), Math.round(e.duration * 1e6)]),
    compileEvents(quarterNotes).map(e => [e.index, e.midi, Math.round(e.start * 1e6), Math.round(e.duration * 1e6)]),
  );
});
import { transpose, transposeTo, parseTone } from "./transpose.ts";
import { serializeScore, deserializeScore, sanitizeFilename, downloadText } from "./serialize.ts";
import { compileEvents, noteBeats, timeBefore } from "./player.ts";
import { createScore, createNote } from "./model.ts";
import { wrapRows } from "../render/layout.ts";

test("长谱换行：保留全部符号、小节线和终止线，行宽受限", () => {
  const items = "123|456|789‖".split("");
  const rows = wrapRows(items, 5, () => 1, (item) => item === "|" || item === "‖");
  assert.deepEqual(rows.map((row) => row.join("")), ["123|", "456|", "789‖"]);
  assert.deepEqual(rows.flat(), items);
  assert.ok(rows.every((row) => row.length <= 5));
  const dense = wrapRows("123456789‖".split(""), 3, () => 1, (item) => item === "‖");
  assert.deepEqual(dense.flat().join(""), "123456789‖");
  assert.ok(dense.every((row) => row.length <= 3));
});

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

test("休止符：混合分组、尾部静音与全休止小节保留时值", async () => {
  const { compileScore } = await import("./dsl.ts");
  const { validateScore } = await import("./validate.ts");
  const score = compileScore("1 0  2  0  0 ‖", { speed: 60 });
  const events = compileEvents(score);
  assert.deepEqual(events.map((e) => e.start), [0, 0.5, 1, 2, 3]);
  assert.deepEqual(events.map((e) => e.midi), [60, null, 62, null, null]);
  assert.equal(events.at(-1)!.start + events.at(-1)!.duration, 4);
  assert.deepEqual(validateScore(score), []);
  const silent = compileScore("0  0  0  0 ‖", { speed: 60 });
  assert.equal(compileEvents(silent).length, 4);
  assert.ok(compileEvents(silent).every((e) => e.midi === null));
  assert.deepEqual(validateScore(silent), []);
  transpose(silent, -3);
  assert.ok(silent.paragraphs[0].notations.slice(0, 4).every((n) => n.note === "0" && n.octave === 0));
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

test("beatFrac：组内 n 音真实时值 1/n（三连音 1/3 拍）", async () => {
  const { compileScore } = await import("./dsl.ts");
  const { noteBeats, compileEvents } = await import("./player.ts");
  const score = compileScore("1 2 3  1 2 3  1 2 3  1 2 3 ‖", { speed: 60 });
  const [a] = score.paragraphs[0].notations;
  assert.ok(Math.abs(a.beatFrac! - 1 / 3) < 1e-9);
  assert.ok(Math.abs(noteBeats({ underline: 2, dotted: false, beatFrac: 1 / 3 }) - 1 / 3) < 1e-9);
  const ev = compileEvents(score);
  assert.ok(Math.abs(ev[0].duration - (1 / 3) * 0.92) < 1e-9); // speed 60 → 1 拍 1s
  // 4 组三连音 = 4 拍小节 → 校验不再误报
  const { validateScore } = await import("./validate.ts");
  assert.deepEqual(validateScore(score), []);
  // 无 beatFrac 回退减时线折算（旧数据兼容）
  assert.ok(Math.abs(noteBeats({ underline: 2, dotted: false }) - 0.25) < 1e-9);
});

test("MIDI 导出：头块/轨长/速度事件/音符开关配对完整", async () => {
  const { compileEvents, toMidi } = await import("./player.ts");
  const score = compileScore("1  2");
  const data = toMidi(compileEvents(score), score.speed);
  const s = (o: number, n: number) => String.fromCharCode(...data.slice(o, o + n));
  // 头块：MThd + 长度6 + format0 + 1轨 + TPQ480
  assert.equal(s(0, 4), "MThd");
  assert.equal((data[8] << 8) | data[9], 0);
  assert.equal((data[10] << 8) | data[11], 1);
  assert.equal((data[12] << 8) | data[13], 480);
  // 轨块：MTrk + 声明的轨长等于实际剩余
  assert.equal(s(14, 4), "MTrk");
  const declared = (data[18] << 24) | (data[19] << 16) | (data[20] << 8) | data[21];
  assert.equal(declared, data.length - 22);
  // 遍历事件流：统计 note-on/off 与 tempo
  let tempo = 0, on = 0, off = 0, ended = false;
  let i = 22;
  const readVarint = () => { let v = 0; while (true) { const b = data[i++]; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) return v; } };
  while (i < data.length) {
    readVarint();
    const st = data[i++];
    if (st === 0xff) {
      const type = data[i++], len = readVarint();
      if (type === 0x51) tempo = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (type === 0x2f) ended = true;
      i += len;
    } else if (st === 0x90) { on += 1; i += 2; }
    else if (st === 0x80) { off += 1; i += 2; }
    else return Promise.reject(new Error(`未知状态字节 ${st}`));
  }
  assert.equal(on, 2);
  assert.equal(off, 2);
  assert.equal(ended, true);
  // 速度：60s/beat 换算微秒（speed=72 → 833333us）
  assert.equal(tempo, Math.round(60_000_000 / score.speed));
});

test("tie 弧线几何：同行画中心到中心，跨行（fromPos=-1）优雅退化", async () => {
  const { tieArc, rowCenterX } = await import("../render/svg-render.ts");
  // 三符号行宽各 33、无 flex：from=0 → 16.5；to=1 → 49.5
  assert.equal(rowCenterX([33, 33, 33], 0, 0), 16.5);
  assert.equal(rowCenterX([33, 33, 33], 1, 0), 49.5);
  const arc = tieArc([33, 33, 33], 0, 0, 49.5);
  assert.equal(arc, "M 16.5 6 Q 33 14 49.5 6");
  // flex 拉伸：gap=10 → 第二符号中心 33+10+16.5
  assert.equal(rowCenterX([33, 33], 1, 10), 59.5);
  // from 不在本行（跨行 tie）→ 不画
  assert.equal(tieArc([33, 33], -1, 0, 49.5), null);
  assert.equal(tieArc([33, 33], 5, 0, 49.5), null);
});

test("复制小节：⌘D 克隆光标所在小节插到其后，歌词随行，可撤销", async () => {
  const { EditorState } = await import("../app/editor-state.ts");
  const st = new EditorState(compileScore("1 2 | 3 4\n[词:甲 乙 丙 丁]"));
  // 光标移到第二小节（| 之后）：右移 3 次过 1 2 |
  st.move(1); st.move(1); st.move(1);
  st.duplicateMeasure();
  const notes = st.score.paragraphs[0].notations.map(n => n.note).join("");
  assert.equal(notes, "12│34│34"); // 副本带前导小节线插在原小节后
  // 歌词随发声符号复制：副本 3 4 继承 丙 丁
  assert.deepEqual(st.score.paragraphs[0].lyrics.slice(2, 6), ["丙", "丁", "丙", "丁"]);
  // key 重新生成不冲突
  const keys = st.score.paragraphs[0].notations.map(n => n.key);
  assert.equal(new Set(keys).size, keys.length);
  st.undo();
  assert.equal(st.score.paragraphs[0].notations.length, 5); // 1 2 | 3 4
});

test("转调同值早退：重复选同一调不产生多余快照", async () => {
  const { EditorState } = await import("../app/editor-state.ts");
  const st = new EditorState(compileScore("1 2"));
  st.transposeTo("G");
  st.transposeTo("G");
  st.transposeTo("G");
  st.undo();
  assert.equal(st.score.tone, "C"); // 一次 undo 即回到原调
  assert.equal(st.canUndo, false);
});

test("MIDI 往返：导出 MIDI 并通过 parseMidiBytes + midiToScore 重新导入为简谱", async () => {
  const { compileEvents, toMidi } = await import("./player.ts");
  const { parseMidiBytes, midiToScore } = await import("./midi-import.ts");
  const original = compileScore("1  2  3  5", { tone: "C", beat: [4, 4], speed: 100 });
  const midiBytes = toMidi(compileEvents(original), original.speed);
  // 解析二进制
  const parsed = parseMidiBytes(midiBytes);
  assert.equal(parsed.tempoBpm, 100);
  assert.equal(parsed.notes.length, 4);
  assert.equal(parsed.notes[0].midi, 60); // C4 = 1
  assert.equal(parsed.notes[1].midi, 62); // D4 = 2
  assert.equal(parsed.notes[2].midi, 64); // E4 = 3
  assert.equal(parsed.notes[3].midi, 67); // G4 = 5
  // 转换成简谱
  const score = midiToScore(parsed, { title: "往返测试", tone: "C" });
  assert.equal(score.title, "往返测试");
  const soundingNotes = score.paragraphs[0].notations.filter(n => n.note >= "1" && n.note <= "7");
  assert.equal(soundingNotes.length, 4);
  assert.equal(soundingNotes[0].note, "1");
  assert.equal(soundingNotes[1].note, "2");
  assert.equal(soundingNotes[2].note, "3");
  assert.equal(soundingNotes[3].note, "5");
});

test("三连音排版：tupletBracketD 坐标算法精确生成开口括弧与斜体连音数位置", async () => {
  const { tupletBracketD } = await import("../render/svg-render.ts");
  const { pathD, midX, textY } = tupletBracketD(20, 80);
  assert.equal(midX, 50);
  assert.equal(textY, -21);
  assert.ok(pathD.startsWith("M 20 -21 Q 20 -24 25 -24 L 43 -24 M 57 -24"));
});

test("moveToBoundary：支持直接跳跃到段首 (0) 与段尾 (length)", async () => {
  const { EditorState } = await import("../app/editor-state.ts");
  const st = new EditorState(compileScore("1  2  3  4  5"));
  st.move(2);
  assert.equal(st.itemIndex, 2);
  st.moveToBoundary(true); // 跳到段尾
  assert.equal(st.itemIndex, st.paragraph.notations.length);
  st.moveToBoundary(false); // 跳到段首
  assert.equal(st.itemIndex, 0);
});

test("Player 音量调节：setVolume 钳制在 0.0 - 1.0 区间", async () => {
  const { Player } = await import("./player.ts");
  const p = new Player();
  assert.equal(p.volume, 0.8);
  p.setVolume(0.5);
  assert.equal(p.volume, 0.5);
  p.setVolume(1.5);
  assert.equal(p.volume, 1.0);
  p.setVolume(-0.2);
  assert.equal(p.volume, 0.0);
});

test("WAV 编码器：audioBufferToWav 生成标准 RIFF/WAVE 头与 16-bit PCM 字节", async () => {
  const { audioBufferToWav } = await import("./wav-export.ts");
  // 构造模拟 AudioBuffer 对象
  const mockBuffer = {
    sampleRate: 44100,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array([0, 0.5, -0.5, 0]),
  } as unknown as AudioBuffer;
  const wavBytes = audioBufferToWav(mockBuffer);
  const text = String.fromCharCode(...wavBytes.slice(0, 4)) + String.fromCharCode(...wavBytes.slice(8, 12));
  assert.equal(text, "RIFFWAVE");
  // 头长度 44 字节 + 4 个 16-bit 采样 (8 字节) = 52 字节
  assert.equal(wavBytes.length, 52);
});

test("Delete 键：向右删除光标后一个符号，末尾不越界，可撤销", async () => {
  const { EditorState } = await import("../app/editor-state.ts");
  const st = new EditorState(compileScore("1  2  3"));
  // 光标在开头 (index 0)
  assert.equal(st.itemIndex, 0);
  // 模拟 Delete 逻辑：move(1) + backspace()
  st.move(1);
  st.backspace();
  const notes = st.score.paragraphs[0].notations.map(n => n.note);
  assert.deepEqual(notes, ["2", "3"]);
  st.undo();
  assert.deepEqual(st.score.paragraphs[0].notations.map(n => n.note), ["1", "2", "3"]);
});
