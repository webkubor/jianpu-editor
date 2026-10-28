/**
 * 通用连排组（@beams）回归：任意谱面可声明印刷连排减时线组。
 * 覆盖：指令生效、DSL/JSON 往返、非法声明报错、缺省自动连排不变、边界处旧组隔离。
 * 路由：DSL 编译 / 文本导出 / 工程文件序列化；与具体曲目无关。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLine, compileScore } from "./dsl.ts";
import { toDsl } from "./dsl-export.ts";
import { deserializeScore, serializeScore } from "./serialize.ts";

/** 合成谱面：六个十六分音（自动分两拍）+ 一个四分音符；与任何具体曲目无关。 */
const SYNTHETIC_LINE = "1:0.25/2 2:0.25/2 3:0.25/2 4:0.25/2 5:0.25/2 6:0.25/2 7:1/0";

/** 十六分音序列：自动分组按每拍四个音切分。 */
const SIXTEENTHS = "1:0.25/2 2:0.25/2 3:0.25/2 4:0.25/2 5:0.25/2 6:0.25/2";

test("@beams 声明把区间合成一个连排组，未声明处仍按拍位自动连排", () => {
  const score = compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":3}]`);
  const groups = score.paragraphs[0].notations.map(n => n.beamGroup);
  // 声明区间四个音同属一个连排组
  assert.equal(new Set(groups.slice(0, 4)).size, 1);
  assert.notEqual(groups[0], undefined);
  // 区间外的自动组保持独立，且不与声明组同号
  assert.notEqual(groups[4], groups[0], "区间外自动组不得并入声明组");
  assert.equal(groups[5], groups[4], "区间外同拍音仍相连");
  assert.equal(groups[6], undefined, "四分音符不参与连排");
});

test("@beams 缺省时自动连排行为不变（同一拍内共享横线，跨拍断开）", () => {
  const auto = compileScore(SIXTEENTHS).paragraphs[0].notations.map(n => n.beamGroup);
  // 未声明时：前四音一拍、后两音一拍
  assert.equal(new Set(auto.slice(0, 4)).size, 1);
  assert.equal(new Set(auto.slice(4, 6)).size, 1);
  assert.notEqual(auto[4], auto[0]);
  const declared = compileScore(`${SIXTEENTHS}\n@beams [{"start":0,"end":3}]`)
    .paragraphs[0].notations.map(n => n.beamGroup);
  // 声明只影响 0..3，其余下标的自动分组完全一致
  assert.deepEqual(declared.slice(4), auto.slice(4));
});

test("@beams 区间边界处隔离旧的自动组：区间外的残余各自独立且不越过边界", () => {
  // 六个十六分音自动分成两组（每拍四个音）；声明跨越边界后，
  // 区间外的残余必须拆开，且不得与声明组同号。
  const auto = compileScore(SIXTEENTHS).paragraphs[0].notations.map(n => n.beamGroup);
  assert.equal(new Set(auto).size, 2, "六个音自动分成两组");
  assert.equal(auto[0], auto[3]);
  assert.notEqual(auto[0], auto[4]);
  const score = compileScore(`${SIXTEENTHS}\n@beams [{"start":1,"end":4}]`);
  const groups = score.paragraphs[0].notations.map(n => n.beamGroup);
  assert.notEqual(groups[0], undefined);
  assert.notEqual(groups[0], groups[1], "区间前残余不得与声明组相连");
  assert.equal(new Set(groups.slice(1, 5)).size, 1, "声明区间四音同组");
  assert.notEqual(groups[5], groups[1], "区间后残余不得与声明组相连");
  assert.notEqual(groups[5], groups[0], "区间前后残余互不相连");
});

test("@beams 同一自动组被声明区间从中截断时，区间外残余各自独立成组", () => {
  // 同一拍内四个十六分音自动连成一组；声明中间两个后，
  // 首尾两个残余必须各自独立，不得与声明组相连。
  const line = "1:0.25/2 2:0.25/2 3:0.25/2 4:0.25/2";
  const auto = compileScore(line).paragraphs[0].notations.map(n => n.beamGroup);
  assert.equal(new Set(auto).size, 1, "四个音自动连成一组");
  const score = compileScore(`${line}\n@beams [{"start":1,"end":2}]`);
  const groups = score.paragraphs[0].notations.map(n => n.beamGroup);
  assert.notEqual(groups[0], groups[1], "区间前残余不得与声明组相连");
  assert.equal(new Set(groups.slice(1, 3)).size, 1, "声明区间两音同组");
  assert.notEqual(groups[3], groups[1], "区间后残余不得与声明组相连");
  assert.notEqual(groups[3], groups[0], "区间前后残余互不相连");
});

test("DSL 导出与重编译往返保留声明的连排组", () => {
  const score = compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":3}]`);
  const exported = toDsl(score);
  assert.ok(exported.includes('@beams [{"start":0,"end":3}]'), exported);
  const back = compileScore(exported);
  const original = score.paragraphs[0].notations.map(n => n.beamGroup);
  const round = back.paragraphs[0].notations.map(n => n.beamGroup);
  assert.deepEqual(round, original, "往返后连排分组一致");
  assert.deepEqual(back.paragraphs[0].beamGroups?.map(g => ({
    start: back.paragraphs[0].notations.findIndex(n => n.key === g.startKey),
    end: back.paragraphs[0].notations.findIndex(n => n.key === g.endKey),
  })), [{ start: 0, end: 3 }]);
  // 二次导出稳定
  assert.equal(toDsl(back), exported);
});

test("工程文件 JSON 往返保留声明的连排组与分组", () => {
  const score = compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":3}]`);
  const loaded = deserializeScore(serializeScore(score));
  assert.ok(loaded);
  assert.deepEqual(loaded.paragraphs[0].beamGroups, score.paragraphs[0].beamGroups);
  assert.deepEqual(loaded.paragraphs[0].notations.map(n => n.beamGroup),
    score.paragraphs[0].notations.map(n => n.beamGroup));
});

test("@beams 非法声明报错：端点越界、范围不足、索引非法、端点非整数", () => {
  const cases: [string, RegExp][] = [
    [`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":99}]`, /连排组端点超出本段符号范围/],
    [`${SYNTHETIC_LINE}\n@beams [{"start":-1,"end":2}]`, /连排组端点超出本段符号范围/],
    [`${SYNTHETIC_LINE}\n@beams [{"start":2,"end":1}]`, /连排组起点不能晚于终点/],
    [`${SYNTHETIC_LINE}\n@beams [{"start":2,"end":2}]`, /连排组至少包含两个符号/],
    [`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":1.5}]`, /连排组端点须为整数/],
    [`${SYNTHETIC_LINE}\n@beams [{"start":"0","end":2}]`, /连排组端点须为整数/],
    [`${SYNTHETIC_LINE}\n@beams {"start":0,"end":2}`, /连排组须在音符行后指定数组/],
    [`${SYNTHETIC_LINE}\n@beams [3]`, /连排组须为 \{start,end\} 对象/],
    // 区间内含无减时线音符（这里是四分音符）不可连排
    [`${SYNTHETIC_LINE}\n@beams [{"start":5,"end":6}]`, /只能包含带减时线的音符/],
  ];
  for (const [dsl, message] of cases) {
    assert.throws(() => compileScore(dsl), (error: unknown) => {
      assert.ok(error instanceof SyntaxError, `${dsl} 应抛 SyntaxError`);
      assert.match(error.message, message);
      return true;
    }, dsl);
  }
});

test("@beams 区间重叠报错", () => {
  assert.throws(() => compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":3},{"start":2,"end":5}]`),
    /连排组区间不得重叠/);
  assert.throws(() => compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":3},{"start":3,"end":5}]`),
    /连排组区间不得重叠/);
  // 跨两条 @beams 指令的重叠同样非法
  assert.throws(() => compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":3}]\n@beams [{"start":2,"end":5}]`),
    /连排组区间不得重叠/);
  // 不重叠的相邻区间合法
  const score = compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":2},{"start":4,"end":5}]`);
  assert.equal(score.paragraphs[0].beamGroups?.length, 2);
});

test("@beams 必须跟在音符行后（无前置段落时报错）", () => {
  assert.throws(() => compileScore('@beams [{"start":0,"end":1}]'), /连排组须在音符行后指定数组/);
});

test("多条 @beams 指令分别落到各自段落", () => {
  const score = compileScore(`${SYNTHETIC_LINE}\n@beams [{"start":0,"end":3}]\n${SYNTHETIC_LINE}\n@beams [{"start":0,"end":2}]`);
  assert.equal(score.paragraphs[0].beamGroups?.length, 1);
  assert.equal(score.paragraphs[1].beamGroups?.length, 1);
  assert.equal(new Set(score.paragraphs[0].notations.slice(0, 4).map(n => n.beamGroup)).size, 1);
  assert.equal(new Set(score.paragraphs[1].notations.slice(0, 3).map(n => n.beamGroup)).size, 1);
});

test("散板段落同样支持 @beams，且不影响时值与音高", () => {
  const dsl = `${SYNTHETIC_LINE}\n@section {"freeTime":true}\n@beams [{"start":0,"end":3}]`;
  const score = compileScore(dsl);
  const notes = score.paragraphs[0].notations;
  assert.equal(new Set(notes.slice(0, 4).map(n => n.beamGroup)).size, 1);
  const plain = compileScore(SYNTHETIC_LINE).paragraphs[0].notations;
  assert.deepEqual(notes.map(n => [n.note, n.octave, n.underline, n.beatFrac]),
    plain.map(n => [n.note, n.octave, n.underline, n.beatFrac]));
});

test("声明连排后音高、时值与拍数校验不受影响", async () => {
  const { validateScore } = await import("./validate.ts");
  // 四个八分音符占两拍（每拍两个），声明后合成一个连排组；段落拍号取 2/4。
  const score = compileScore("1/_ 2/_  3/_ 4/_\n@beams [{\"start\":0,\"end\":3}]", { beat: [2, 4] });
  assert.deepEqual(validateScore(score), [], "声明连排不改变小节拍数");
  const plain = compileScore("1/_ 2/_  3/_ 4/_", { beat: [2, 4] });
  assert.deepEqual(score.paragraphs[0].notations.map(n => [n.note, n.underline, n.beatFrac]),
    plain.paragraphs[0].notations.map(n => [n.note, n.underline, n.beatFrac]));
  // 自动分组原本按拍切成两组，声明后合成一组。
  assert.equal(new Set(plain.paragraphs[0].notations.map(n => n.beamGroup)).size, 2);
  assert.equal(new Set(score.paragraphs[0].notations.map(n => n.beamGroup)).size, 1);
});

test("compileLine 保持缺省自动连排（段落级 API 不受影响）", () => {
  const para = compileLine(SYNTHETIC_LINE);
  const groups = para.notations.map(n => n.beamGroup);
  assert.equal(new Set(groups.slice(0, 4)).size, 1);
  assert.equal(groups[6], undefined);
  assert.equal(para.beamGroups, undefined, "未声明时不写 beamGroups");
});

test("未声明连排的谱面导出不含 @beams 指令", () => {
  const exported = toDsl(compileScore(SYNTHETIC_LINE));
  assert.ok(!exported.includes("@beams"), exported);
});
