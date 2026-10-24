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
 *   [词:你 好 吗]                              歌词行（与发声符号逐个对应，- 占位跳过）
 *   双空格 = 拍边界（组结束）。例：「1 2  3 4」= 前一拍两音、后一拍两音。
 *   为兼容手滑，也把 | 与 - 视为组边界。
 */

import { BAR, createBar, createExtend, createNote, createParagraph, DOUBLE_BAR, EXTEND, REPEAT_START, REPEAT_END, createScore } from "./model.ts";
import type { NoteDigit, Notation, Paragraph, Score } from "./model.ts";

/** 词法单元 */
export type Token =
  | { t: "note"; digit: string; octave: number; dotted: boolean; accidentals: ("♯" | "♭")[]; decorators: string[] }
  | { t: "duration"; beats: number; underline: number }
  | { t: "extend" }
  | { t: "bar"; double?: boolean; repeat?: "start" | "end" }
  | { t: "tie" }
  | { t: "lyrics"; words: string[] };

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
  // 中文输入法容错：全角数字/符号归一化为半角（１→1、｜→|、～→~、＃→#、　→空格等）
  const normalized = line
    .replace(/　/g, " ")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/｜/g, "|")
    .replace(/‖/g, "‖")
    .replace(/～/g, "~")
    .replace(/＃/g, "#")
    .replace(/ｂ(?=[０-９0-9])/g, "b")
    .replace(/，/g, ",")
    .replace(/－/g, "-")
    .replace(/．/g, ".")
    .replace(/＾/g, "^")
    .replace(/′/g, "'");
  line = normalized;
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
    // 反复结束记号 :||
    if (line.slice(i, i + 3) === ":||" || line.slice(i, i + 3) === ":‖") {
      tokens.push({ t: "bar", repeat: "end" });
      i += 3;
      continue;
    }
    // 反复开始记号 ||:
    if (line.slice(i, i + 3) === "||:" || line.slice(i, i + 2) === "‖:") {
      tokens.push({ t: "bar", repeat: "start" });
      i += line.slice(i, i + 3) === "||:" ? 3 : 2;
      continue;
    }
    // 显式时值后缀 :基础拍数/减时线层数，供无损文本导出。
    if (c === ":") {
      const match = /^:([0-9]+(?:\.[0-9]+)?)\/([0-9]+)/.exec(line.slice(i));
      if (!match || Number(match[1]) <= 0) throw new SyntaxError(`位置 ${i}：时值后缀格式错误`);
      tokens.push({ t: "duration", beats: Number(match[1]), underline: Number(match[2]) });
      i += match[0].length;
      continue;
    }
    if (c === "|" || c === "│") {
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
    // 歌词行：[词:…]，token 数与后续音符行对齐（空格分隔，- 表示无词）
    if (c === "[") {
      const close = line.indexOf("]", i);
      if (close < 0) throw new SyntaxError(`位置 ${i}：歌词行 [词: 缺右括号 ]`);
      const body = line.slice(i + 1, close);
      const colon = body.indexOf(":");
      const words = (colon >= 0 ? body.slice(colon + 1) : body).trim().split(/\s+/).filter(Boolean);
      tokens.push({ t: "lyrics", words });
      i = close + 1;
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
      // 顶部表情/装饰记号：如 5{▾} 或 5{fermata} 或 5{⌒}
      const decorators: string[] = [];
      if (line[i] === "{") {
        const close = line.indexOf("}", i);
        if (close !== -1) {
          const raw = line.slice(i + 1, close).trim();
          if (raw) decorators.push(raw);
          i = close + 1;
        }
      }
      tokens.push({ t: "note", digit, octave, dotted, accidentals, decorators });
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
function compileTokens(tokens: Token[], beatBreaks: Set<number>): { notations: Notation[]; lyrics: string[] | null } {
  const notations: Notation[] = [];
  const explicitDurations = new Map<Notation, { beats: number; underline: number }>();
  // 待连接的 tie：前一音符引用
  let pendingTieFrom: Notation | null = null;
  // 当前拍区间的音符（不含延音线）
  let beatNotes: Notation[] = [];
  // 歌词（本行有 [词:…] 时启用对齐）
  let pendingLyrics: string[] | null = null;

  const flushBeat = () => {
    if (beatNotes.length === 0) return;
    // 减时线视觉上限 3 层（简谱惯例）；真实时值仍记 beatFrac=1/n
    const lines = beatNotes.length > 1 ? Math.min(3, beatNotes.length - 1) : 0;
    for (const n of beatNotes) {
      n.underline = lines;
      // 真实时值：组内 n 音平分一拍（三连音 1/3、四连音 1/4…），单音 1 拍；
      // 附点音（. 后缀）不参与平分——附点是显式时值意图（1.5 拍），保留
      n.beatFrac = n.dotted ? 1.5 : 1 / beatNotes.length;
    }
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
        topDecorators: tk.decorators,
      });
      if (pendingTieFrom) {
        pendingTieFrom.tieTo = n.key;
        n.tieTo = pendingTieFrom.key;
        pendingTieFrom = null;
      }
      notations.push(n);
      beatNotes.push(n);
    } else if (tk.t === "duration") {
      const prev = notations.at(-1);
      if (!prev || prev.note === "│" || prev.note === DOUBLE_BAR) throw new SyntaxError("时值后缀前需要音符或延音线");
      explicitDurations.set(prev, { beats: tk.beats, underline: tk.underline });
    } else if (tk.t === "extend") {
      const ext = createExtend();
      const prev = notations[notations.length - 1] ?? null;
      extendsToFix.push({ ext, prev: prev && isSounding(prev) ? prev : null });
      // 连音线挂起时，延音线是 tie 的直接延续（1~ - → 连到 ─，音持续不重起）
      if (pendingTieFrom) {
        pendingTieFrom.tieTo = ext.key;
        ext.tieTo = pendingTieFrom.key;
        pendingTieFrom = null;
      }
      notations.push(ext);
      flushBeat(); // 延音线自成一拍单元，重置区间
    } else if (tk.t === "bar") {
      flushBeat();
      // 小节线打断挂起的连音线（跨线另起音高，不自动连）
      pendingTieFrom = null;
      let barType: typeof BAR | typeof DOUBLE_BAR | typeof REPEAT_START | typeof REPEAT_END = "│";
      if (tk.repeat === "start") barType = REPEAT_START;
      else if (tk.repeat === "end") barType = REPEAT_END;
      else if (tk.double) barType = DOUBLE_BAR;
      notations.push(createBar(barType));
    } else if (tk.t === "tie") {
      const prev = notations[notations.length - 1];
      if (prev && isSounding(prev)) pendingTieFrom = prev;
    } else if (tk.t === "lyrics") {
      pendingLyrics = tk.words;
    }
  });
  flushBeat();
  // 继承层数：延音线与其延续的前一音符同层（延音线自成一拍，beatFrac=1 由 createExtend 默认）
  for (const { ext, prev } of extendsToFix) ext.underline = prev ? prev.underline : 0;
  for (const [note, duration] of explicitDurations) {
    note.beatFrac = duration.beats;
    note.underline = duration.underline;
  }
  // 歌词对齐：与「发声符号」（音符+延音线）逐个对应，词序按此摊派；`-` 或缺词留空
  if (pendingLyrics) {
    const lyrics: string[] = [];
    let w = 0;
    for (const n of notations) {
      if (isSounding(n)) {
        const word = pendingLyrics[w];
        lyrics.push(word && word !== "-" ? word : "");
        w += 1;
      }
    }
    return { notations, lyrics };
  }
  return { notations, lyrics: null };
}

/** 编译一行 DSL → 段落 */
export function compileLine(line: string): Paragraph {
  const { tokens, beatBreaks } = tokenizeLine(line);
  const { notations, lyrics } = compileTokens(tokens, beatBreaks);
  const para = createParagraph(notations);
  if (lyrics) para.lyrics = lyrics;
  return para;
}

/** 编译整份 DSL 文本 → 乐谱：音符行分段；[词:…] 行修饰其上方最近的音符行（可多行叠加） */
export function compileScore(dsl: string, base?: Partial<Score>): Score {
  const score = createScore(base);
  const paras: Paragraph[] = [];
  for (const raw of dsl.split(/\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^\[词[:：]/.test(line)) {
      // 词行：并入上一个已有段落（没有则忽略）
      const target = paras[paras.length - 1];
      if (!target) continue;
      const { tokens } = tokenizeLine(line);
      const lyricsTk = tokens.find((t): t is Extract<Token, { t: "lyrics" }> => t.t === "lyrics");
      if (lyricsTk) {
        const merged = [...target.lyrics];
        lyricsTk.words.forEach((w, i) => {
          merged[i] = w === "-" ? merged[i] ?? "" : w;
        });
        target.lyrics = merged;
      }
      continue;
    }
    paras.push(compileLine(line));
  }
  score.paragraphs = paras;
  return score;
}
