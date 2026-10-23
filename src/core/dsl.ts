/**
 * 文本 DSL 编译器：把「数字分组流」编译成显式时值符号
 * 核心思想（对 jianpu-ly / 文本简谱思路的重写）：用户只敲数字与分组，
 * 减时线/延音线由分组推断编译生成；存储层保持显式 Notation[]，所见即所得不变。
 *
 * DSL 语法（一行 = 一段落）：
 *   1 2 3 5 | 6 - 5 - ‖                      单个空格 = 拍内分组（组内 n 音平分一拍）
 *   6, 1 2 3                                  逗号后缀 = 低八度，' 或 ^ = 高八度
 *   #4  b7                                    #=升号 b=降号（也可写 ♯♭）
 *   5. 3.                                     点后缀 = 附点
 *   1~2                                       连音线（tie）
 *   双空格 = 拍边界（组结束）。例：「1 2  3 4」= 前一拍两音、后一拍两音。
 *   为兼容手滑，也把 | 与 - 视为组边界。
 */

import { createBar, createExtend, createNote, createParagraph, DOUBLE_BAR, EXTEND, createScore } from "./model.ts";
import type { NoteDigit, Notation, Paragraph, Score } from "./model.ts";

/** 词法单元 */
export type Token =
  | { t: "note"; digit: string; octave: number; dotted: boolean; accidentals: ("♯" | "♭")[] }
  | { t: "extend" }
  | { t: "bar"; double?: boolean }
  | { t: "tie" };

/**
 * 词法分析：把 DSL 行切成 token 流。
 * 额外产出 beatBreaks：每个 beatBreak 是「token 序号」，表示此 token 前发生了拍边界（双空格）。
 * 单空格 = 同拍分隔（组内音），双空格 = 拍边界。
 */
export interface LexResult {
  tokens: Token[];
  /** tokens 的下标 i：tokens[i] 之前是拍边界 */
  beatBreaks: Set<number>;
}

export function tokenizeLine(line: string): LexResult {
  const tokens: Token[] = [];
  const beatBreaks = new Set<number>();
  let i = 0;
  let spaceRun = 0;
  let pendingOctaveUp = false;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      spaceRun += 1;
      // 双空格且下一个是非空格 → 拍边界
      if (spaceRun >= 2) {
        beatBreaks.add(tokens.length);
      }
      i += 1;
      continue;
    }
    spaceRun = 0;
    if (c === "|") {
      if (line[i + 1] === "|") {
        tokens.push({ t: "bar", double: true });
        i += 2;
      } else {
        tokens.push({ t: "bar" });
        i += 1;
      }
      continue;
    }
    if (c === "‖") {
      tokens.push({ t: "bar", double: true });
      i += 1;
      continue;
    }
    if (c === "-") {
      tokens.push({ t: "extend" });
      i += 1;
      continue;
    }
    if (c === "~") {
      tokens.push({ t: "tie" });
      i += 1;
      continue;
    }
    // 前缀 ^：高八度记号（^1 = 高音 do），并到下一个音符上
    if (c === "^") {
      pendingOctaveUp = true;
      i += 1;
      continue;
    }
    if (/[#b♯♭]/.test(c) || /[0-7]/.test(c)) {
      const accidentals: ("♯" | "♭")[] = [];
      while (i < line.length && /[#b♯♭]/.test(line[i])) {
        accidentals.push(line[i] === "b" ? "♭" : "♯");
        i += 1;
      }
      if (i >= line.length || !/[0-7]/.test(line[i])) {
        throw new SyntaxError(`位置 ${i}：升降号后缺数字：…${line.slice(Math.max(0, i - 4), i + 4)}…`);
      }
      const digit = line[i];
      i += 1;
      let octave = pendingOctaveUp ? 1 : 0;
      pendingOctaveUp = false;
      while (i < line.length && (line[i] === "," || line[i] === "'" || line[i] === "^")) {
        octave += line[i] === "," ? -1 : 1;
        i += 1;
      }
      let dotted = false;
      if (line[i] === ".") {
        dotted = true;
        i += 1;
      }
      tokens.push({ t: "note", digit, octave, dotted, accidentals });
      continue;
    }
    throw new SyntaxError(`位置 ${i}：无法识别的字符 "${c}"`);
  }
  return { tokens, beatBreaks };
}

/** 音符/延音线在播放与推断中的「时值单元」记号 */
function isSounding(n: Notation): boolean {
  return (n.note >= "1" && n.note <= "7") || n.note === EXTEND;
}

/**
 * 编译 token 流 → 显式符号数组
 *
 * 减时线推断规则（定死）：
 * - 拍边界（beatBreak）之间为一个「拍区间」；小节线也重置区间。
 * - 区间内 n 个音符 → 每音 n-1 条减时线（n 音平分一拍）。
 * - 区间内混有延音线：延音线不参与平分，音符按同组减时线处理，延音线继承同组层数
 *   （简谱惯例：5 - 中延音线不带线；这里延音线一律 0 层，只有音符参与推断）。
 * - 区间内恰 1 个音 → 四分音符，0 层。
 */
function compileTokens(tokens: Token[], beatBreaks: Set<number>): Notation[] {
  const notations: Notation[] = [];
  // 待连接的 tie：前一音符引用
  let pendingTieFrom: Notation | null = null;
  // 当前拍区间的音符（不含延音线）
  let beatNotes: Notation[] = [];

  const flushBeat = () => {
    if (beatNotes.length === 0) return;
    const lines = beatNotes.length > 1 ? beatNotes.length - 1 : 0;
    for (const n of beatNotes) n.underline = lines;
    beatNotes = [];
  };

  // 延音线先收集，flushBeat 后统一继承层数（flush 前音符层数未定）
  const extendsToFix: { ext: Notation; prev: Notation | null }[] = [];

  tokens.forEach((tk, idx) => {
    if (beatBreaks.has(idx)) flushBeat();
    if (tk.t === "note") {
      const n = createNote({
        note: tk.digit as NoteDigit,
        octave: tk.octave,
        dotted: tk.dotted,
        prefixAccidentals: tk.accidentals,
      });
      if (pendingTieFrom) {
        pendingTieFrom.tieTo = n.key;
        n.tieTo = pendingTieFrom.key;
        pendingTieFrom = null;
      }
      notations.push(n);
      beatNotes.push(n);
    } else if (tk.t === "extend") {
      const ext = createExtend();
      const prev = notations[notations.length - 1] ?? null;
      extendsToFix.push({ ext, prev: prev && isSounding(prev) ? prev : null });
      notations.push(ext);
      flushBeat(); // 延音线自成一拍单元，重置区间
    } else if (tk.t === "bar") {
      flushBeat();
      notations.push(createBar(tk.double ? DOUBLE_BAR : "│"));
    } else if (tk.t === "tie") {
      const prev = notations[notations.length - 1];
      if (prev && isSounding(prev)) pendingTieFrom = prev;
    }
  });
  flushBeat();
  // 继承层数：延音线与其延续的前一音符同层
  for (const { ext, prev } of extendsToFix) ext.underline = prev ? prev.underline : 0;
  return notations;
}

/** 编译一行 DSL → 段落 */
export function compileLine(line: string): Paragraph {
  const { tokens, beatBreaks } = tokenizeLine(line);
  const notations = compileTokens(tokens, beatBreaks);
  return createParagraph(notations);
}

/** 编译整份 DSL 文本 → 乐谱（空行分段） */
export function compileScore(dsl: string, base?: Partial<Score>): Score {
  const score = createScore(base);
  score.paragraphs = dsl
    .split(/\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => compileLine(l));
  return score;
}
