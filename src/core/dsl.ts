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
 *   (12)1^.{w}:0.75/1<3>                     后置倚音在主音修饰及时值后缀之后、tie 之前
 *   1~2                                       连音线（tie）
 *   [词:你 好 吗]                              歌词行（与发声符号逐个对应，- 占位跳过）
 *   双空格 = 拍边界（组结束）。例：「1 2  3 4」= 前一拍两音、后一拍两音。
 *   为兼容手滑，也把 | 与 - 视为组边界。
 */

import { BAR, createBar, createExtend, createNote, createParagraph, DOUBLE_BAR, EXTEND, REPEAT_START, REPEAT_END, createScore, isPitchable } from "./model.ts";
import type { GraceNote, NoteDigit, Notation, Paragraph, Score, WindTechnique } from "./model.ts";

/** 词法单元 */
export type Token =
  | {
      t: "note";
      digit: string;
      octave: number;
      dotted: boolean;
      accidentals: ("♯" | "♭")[];
      decorators: string[];
      dynamic?: Notation["dynamic"];
      direction?: string;
      graceNotes?: { note: string; octave: number; accidental?: "♯" | "♭"; mordent?: boolean }[];
      technique?: WindTechnique;
    }
  | { t: "postGrace"; notes: GraceNote[] }
  | { t: "duration"; beats: number; underline: number }
  | { t: "extend" }
  | { t: "bar"; double?: boolean; repeat?: "start" | "end"; volta?: string }
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

/** 前置与后置倚音共用数字、八度、变音和波音解析。 */
function parseGraceNotes(inner: string): GraceNote[] {
  const parsedGrace: GraceNote[] = [];
  let gi = 0;
  let gOctUp = false;
  let graceAccidental: "♯" | "♭" | undefined;
  while (gi < inner.length) {
    const gc = inner[gi];
    if (gc === "^") { gOctUp = true; gi++; continue; }
    if (/[#b♯♭]/.test(gc)) { graceAccidental = gc === "b" || gc === "♭" ? "♭" : "♯"; gi++; continue; }
    if (/[1-7]/.test(gc)) {
      let oct = gOctUp ? 1 : 0;
      gOctUp = false;
      gi++;
      while (gi < inner.length && (inner[gi] === "'" || inner[gi] === "," || inner[gi] === "^")) {
        oct += inner[gi] === "," ? -1 : 1;
        gi++;
      }
      const mordent = inner.slice(gi, gi + 3) === "{w}";
      if (mordent) gi += 3;
      parsedGrace.push({ note: gc as NoteDigit, octave: oct, ...(graceAccidental ? { accidental: graceAccidental } : {}), ...(mordent ? { mordent: true } : {}) });
      graceAccidental = undefined;
      continue;
    }
    gi++;
  }
  return parsedGrace;
}

export function tokenizeLine(line: string): LexResult {
  const tokens: Token[] = [];
  const beatBreaks = new Set<number>();
  let i = 0;
  let spaceRun = 0;
  let pendingOctaveUp = false;
  let pendingGraceNotes: { note: string; octave: number; accidental?: "♯" | "♭"; mordent?: boolean }[] | undefined;
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
    let c = line[i];
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
    // 后置倚音紧邻主音及其时值后缀，位于连音线之前。
    if (c === "<") {
      const prev = tokens.at(-1);
      if (i === 0 || /\s/.test(line[i - 1]) || !prev || (prev.t !== "note" && prev.t !== "duration")) {
        throw new SyntaxError(`位置 ${i}：后置倚音须紧随音符或其时值后缀`);
      }
      const close = line.indexOf(">", i);
      if (close < 0) throw new SyntaxError(`位置 ${i}：后置倚音缺右括号 >`);
      const notes = parseGraceNotes(line.slice(i + 1, close));
      if (!notes.length) throw new SyntaxError(`位置 ${i}：后置倚音需要数字音符`);
      tokens.push({ t: "postGrace", notes });
      i = close + 1;
      continue;
    }
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
    // 显式减时线下划线后缀：/_ (1层八分) /__ (2层十六分) /___ (3层三十二分)
    if (c === "/" && /^\/_+/.test(line.slice(i))) {
      const match = /^\/(_+)/.exec(line.slice(i))!;
      const lines = match[1].length;
      tokens.push({ t: "duration", beats: 1 / (2 ** lines), underline: lines });
      i += match[0].length;
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
    // 跳房子反复门楼标记：如 [1. 或 [2. 或 [1,2.
    if (c === "[" && /^\[[0-9,\.]+\.?\]?/.test(line.slice(i))) {
      const match = /^\[([0-9,\.]+)/.exec(line.slice(i));
      if (match) {
        tokens.push({ t: "bar", volta: match[1] });
        i += match[0].length;
        if (line[i] === "]") i += 1;
        continue;
      }
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
    // 倚音 / 装饰小音符：如 (5)6 或 (^1)7 或 (3,5)6
    let graceNotes = pendingGraceNotes;
    if (c === "(") {
      const close = line.indexOf(")", i);
      if (close > i + 1) {
        const inner = line.slice(i + 1, close);
        const parsedGrace = parseGraceNotes(inner);
        if (parsedGrace.length > 0) {
          graceNotes = parsedGrace;
          i = close + 1;
          c = line[i] || "";
        }
      }
    }

    // 前缀 ^：高八度记号（^1 = 高音 do），并到下一个音符上
    if (c === "^") {
      pendingGraceNotes = graceNotes;
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
      // 顶部表情/装饰记号与管乐技巧：如 5{▾}、5{tr}、5{up}、5{down}、5{T}、5{TK}、(5)6 倚音等
      const decorators: string[] = [];
      const technique: WindTechnique = {};
      let dynamic: Notation["dynamic"];
      let direction: string | undefined;
      if (line[i] === "{") {
        const close = line.indexOf("}", i);
        if (close !== -1) {
          const raw = line.slice(i + 1, close);
          // 简化语法：表情文字仅支持无空白、逗号或花括号的单个标签，复杂文本留待转义语法。
          for (const match of raw.matchAll(/(?:^|[,，\s])text=([^,，]*)/g)) {
            if (!match[1] || match[1].length > 120 || /[\s{}\u0000-\u001f\u007f-\u009f]/.test(match[1])) {
              throw new SyntaxError("表情文字须为不超过 120 字符的无空白标签，且不能包含控制字符或花括号");
            }
          }
          const items = raw.split(/[,，\s]+/).filter(Boolean);
          for (const it of items) {
            if (it.startsWith("text=")) direction = it.slice(5);
            else if (["ppp", "pp", "p", "mp", "mf", "f", "ff"].includes(it)) dynamic = it as Notation["dynamic"];
            else if (it === "tr" || it === "trill") technique.trill = true;
            else if (it === "mordent" || it === "波音" || it === "w") technique.mordent = true;
            else if (it === "die" || it === "叠" || it === "app") technique.appoggiatura = true;
            else if (it === "harm") technique.harmonic = true;
            else if (it === "strike") technique.fingerStrike = true;
            else if (it === "accent" || it === ">") technique.accent = true;
            else if (it === "v" || it === "breath" || it === "气") technique.breath = true;
            else if (it === "up" || it === "↗" || it === "上滑") technique.slideUp = true;
            else if (it === "down" || it === "↘" || it === "下滑") technique.slideDown = true;
            else if (it === "T" || it === "K" || it === "TK" || it === "TKT") technique.tonguing = it as any;
            else if (it === "fl" || it === "花舌") technique.flutter = true;
            else if (it === "vib" || it === "气震") technique.vibrato = true;
            else if (it === "gli" || it === "历音") technique.glissando = true;
            else decorators.push(it);
          }
          i = close + 1;
        }
      }
      tokens.push({
        t: "note",
        digit,
        octave,
        dotted,
        accidentals,
        decorators,
        dynamic,
        direction,
        graceNotes,
        technique: Object.keys(technique).length ? technique : undefined,
      });
      pendingGraceNotes = undefined;
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
        dynamic: tk.dynamic,
        direction: tk.direction,
        graceNotes: tk.graceNotes as any,
        technique: tk.technique,
      });
      if (pendingTieFrom) {
        pendingTieFrom.tieTo = n.key;
        n.tieTo = pendingTieFrom.key;
        pendingTieFrom = null;
      }
      notations.push(n);
      beatNotes.push(n);
    } else if (tk.t === "postGrace") {
      const prev = notations.at(-1);
      if (!prev || !/^[0-7]$/.test(prev.note)) throw new SyntaxError("后置倚音前需要音符");
      prev.postGraceNotes = tk.notes;
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
      const b = createBar(barType);
      if (tk.volta) b.volta = tk.volta;
      notations.push(b);
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
  // 减时线连排：按原谱惯例同一拍内的减时线音符共享横线（第一层贯穿全组，更高层只连对应音）。
  const ids = autoBeamGroupIds(notations);
  notations.forEach((n, i) => { if (ids[i] !== undefined) n.beamGroup = ids[i]; });
  if (lyrics) para.lyrics = lyrics;
  return para;
}

/**
 * 一段连排声明：段落内符号下标（含首尾）。
 * 与具体曲目无关：任何谱面都可用 @beams 声明印刷连排减时线组。
 */
export interface BeamRange {
  /** 组首符号下标（含） */
  start: number;
  /** 组尾符号下标（含） */
  end: number;
}

/**
 * 自动连排分组：同一拍内的减时线音符共享一条横线。
 * 拍位按小节线清零计算；休止、延音线、小节线与 breakUnderline 均断开连排。
 * 返回每个符号的组号（不属于任何组为 undefined）；不改动词符。
 */
export function autoBeamGroupIds(notations: Notation[]): (number | undefined)[] {
  const ids: (number | undefined)[] = new Array(notations.length).fill(undefined);
  let beamSeq = 0;
  let group: number[] = [];
  let groupBeat = -1;
  let elapsed = 0;
  const flushBeam = () => {
    if (group.length >= 2) {
      beamSeq += 1;
      for (const i of group) ids[i] = beamSeq;
    }
    group = [];
  };
  for (let i = 0; i < notations.length; i += 1) {
    const n = notations[i];
    if (n.note === "│" || n.note === "‖" || n.note === "||:" || n.note === ":||") {
      flushBeam();
      elapsed = 0;
      continue;
    }
    const beats = n.note === EXTEND ? 1 : (n.beatFrac ?? 1 / 2 ** Math.min(3, n.underline)) * (n.dotted ? 1.5 : 1);
    const beat = Math.floor(elapsed + 1e-6);
    if (!(isSounding(n) && n.note !== EXTEND && n.underline >= 1) || n.breakUnderline || beat !== groupBeat) flushBeam();
    if (isSounding(n) && n.note !== EXTEND && n.underline >= 1) {
      group.push(i);
      groupBeat = beat;
    }
    elapsed += beats;
  }
  flushBeam();
  return ids;
}

/**
 * 应用声明的连排组：每个声明区间各自成为一个连排组（组号全新，不与自动组混用）。
 * 与声明区间同属旧自动组、却落在区间外的连续段各自独立成组，
 * 使连线不会越过声明边界；与声明区间无关的自动组保持原样。
 * baseline 为自动分组结果（应用声明前的组号），缺省按当前符号重算。
 */
export function applyDeclaredBeamGroups(
  notations: Notation[],
  ranges: BeamRange[],
  baseline: (number | undefined)[] = autoBeamGroupIds(notations),
): void {
  const inRange = (i: number) => ranges.some(r => i >= r.start && i <= r.end);
  // 被声明区间打断过的自动组：它们在区间外的残余需要拆成独立组。
  const touched = new Set<number>();
  for (const r of ranges) {
    for (let i = r.start; i <= r.end; i += 1) {
      const g = baseline[i];
      if (g !== undefined) touched.add(g);
    }
  }
  let nextId = 0;
  for (const g of baseline) if (g !== undefined && g > nextId) nextId = g;
  for (const r of ranges) {
    nextId += 1;
    for (let i = r.start; i <= r.end; i += 1) notations[i].beamGroup = nextId;
  }
  let previousOld: number | undefined;
  let segmentId = nextId;
  for (let i = 0; i < notations.length; i += 1) {
    const old = baseline[i];
    if (inRange(i)) {
      previousOld = undefined;
      continue;
    }
    if (old !== undefined && touched.has(old)) {
      if (previousOld !== old) {
        nextId += 1;
        segmentId = nextId;
      }
      previousOld = old;
      notations[i].beamGroup = segmentId;
      continue;
    }
    previousOld = undefined;
  }
}

/**
 * 校验 @beams 声明：每项须为 {start,end}，指向本段存在的符号（含首尾）。
 * 区间至少两个符号；区间之间（含本段已有声明）不得重叠。
 */
function parseBeamRanges(declared: unknown[], para: Paragraph, existing: BeamRange[] = []): BeamRange[] {
  const total = para.notations.length;
  const ranges: BeamRange[] = [];
  for (const item of declared) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new SyntaxError("连排组须为 {start,end} 对象");
    const { start, end } = item as { start?: unknown; end?: unknown };
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new SyntaxError("连排组端点须为整数");
    const s = start as number, e = end as number;
    if (s < 0 || e < 0 || s >= total || e >= total) throw new SyntaxError("连排组端点超出本段符号范围");
    if (s > e) throw new SyntaxError("连排组起点不能晚于终点");
    if (e - s + 1 < 2) throw new SyntaxError("连排组至少包含两个符号");
    // 连排横线只连接带减时线的音符：区间内出现休止、延音线或无减时线音符时报错。
    for (let i = s; i <= e; i += 1) {
      const n = para.notations[i];
      if (!isPitchable(n) || n.underline < 1) throw new SyntaxError("连排组只能包含带减时线的音符");
    }
    if ([...ranges, ...existing].some(r => s <= r.end && r.start <= e)) throw new SyntaxError("连排组区间不得重叠");
    ranges.push({ start: s, end: e });
  }
  return ranges;
}

/** 编译整份 DSL 文本 → 乐谱：音符行分段；[词:…] 行修饰其上方最近的音符行（可多行叠加） */
export function compileScore(dsl: string, base?: Partial<Score>): Score {
  const score = createScore(base);
  const paras: Paragraph[] = [];
  let pendingSection: Partial<Pick<Paragraph, "heading" | "meter" | "freeTime">> | undefined;
  const crossSpans: { kind: NonNullable<Paragraph["spans"]>[number]["kind"]; start: [number, number]; end: [number, number]; label?: string }[] = [];
  // 段落 → 已声明的连排区间；同一段多条 @beams 汇总后一次性套用。
  const pendingBeams = new Map<Paragraph, BeamRange[]>();
  /** 把段落已声明的连排区间套用到符号上并回写 beamGroups。 */
  const applyPendingBeams = (para: Paragraph) => {
    const ranges = pendingBeams.get(para);
    if (!ranges?.length) return;
    pendingBeams.delete(para);
    applyDeclaredBeamGroups(para.notations, ranges);
    para.beamGroups = ranges.map(range => ({
      startKey: para.notations[range.start].key,
      endKey: para.notations[range.end].key,
    }));
  };
  for (const raw of dsl.split(/\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("@cross-spans ")) {
      const value = JSON.parse(line.slice(13));
      if (!Array.isArray(value)) throw new SyntaxError("跨段跨度须为数组");
      for (const span of value) {
        if (!span || !["slur", "slide", "crescendo", "diminuendo", "trill", "tuplet"].includes(span.kind) ||
          ![span.start, span.end].every(a => Array.isArray(a) && a.length === 2 && a.every(v => Number.isInteger(v) && v >= 0)) ||
          (span.label !== undefined && typeof span.label !== "string")) throw new SyntaxError("跨段跨度元数据有误");
        crossSpans.push(span);
      }
      continue;
    }
    if (line.startsWith("@cue ")) {
      const target = paras.at(-1);
      const cue = JSON.parse(line.slice(5));
      if (!target || !cue || typeof cue.label !== "string" || typeof cue.dsl !== "string" ||
        !Number.isFinite(cue.startBeat) || cue.startBeat < 0 ||
        (cue.resume !== undefined && (!Number.isInteger(cue.resume) || !target.notations[cue.resume])) ||
        (cue.timelineBeats !== undefined && (!Number.isFinite(cue.timelineBeats) || cue.timelineBeats <= 0))) throw new SyntaxError("提示声部元数据有误");
      target.cueLayers ??= [];
      target.cueLayers.push({ label: cue.label, startBeat: cue.startBeat,
        notations: compileLine(cue.dsl).notations,
        ...(cue.resume !== undefined ? { resumeKey: target.notations[cue.resume].key } : {}),
        ...(cue.timelineBeats !== undefined ? { timelineBeats: cue.timelineBeats } : {}) });
      continue;
    }
    if (line.startsWith("@spans ")) {
      const target = paras.at(-1);
      const spans: unknown = JSON.parse(line.slice(7));
      if (!target || !Array.isArray(spans)) throw new SyntaxError("跨度须在音符行后指定数组");
      target.spans = spans.map(span => {
        if (!span || !["slur", "slide", "crescendo", "diminuendo", "trill", "tuplet"].includes(span.kind) ||
          !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
          !target.notations[span.start] || !target.notations[span.end] ||
          (span.label !== undefined && typeof span.label !== "string")) throw new SyntaxError("跨度端点或类型有误");
        return { kind: span.kind, startKey: target.notations[span.start].key,
          endKey: target.notations[span.end].key, ...(span.label !== undefined ? { label: span.label } : {}) };
      });
      continue;
    }
    if (line.startsWith("@beams ")) {
      const target = paras.at(-1);
      const declared: unknown = JSON.parse(line.slice(7));
      if (!target) throw new SyntaxError("连排组须在音符行后指定数组");
      if (!Array.isArray(declared)) throw new SyntaxError("连排组须在音符行后指定数组");
      // 同一段可多次声明；先汇总全部区间再一次性套用，避免后一次覆盖前一次。
      const pending = pendingBeams.get(target) ?? [];
      const ranges = parseBeamRanges(declared, target, pending);
      pending.push(...ranges);
      pendingBeams.set(target, pending);
      continue;
    }
    if (line.startsWith("@section ")) {
      const metadata: unknown = JSON.parse(line.slice(9));
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new SyntaxError("段落元数据须为对象");
      const m = metadata as Record<string, unknown>;
      if (m.heading !== undefined && typeof m.heading !== "string") throw new SyntaxError("段落标题须为文本");
      if (m.freeTime !== undefined && typeof m.freeTime !== "boolean") throw new SyntaxError("散板标记须为布尔值");
      if (m.meter !== undefined && (!Array.isArray(m.meter) || m.meter.length !== 2 || !m.meter.every(v => Number.isSafeInteger(v) && v > 0))) throw new SyntaxError("段落拍号须为两个正整数");
      pendingSection = {
        ...(m.heading !== undefined ? { heading: m.heading as string } : {}),
        ...(m.meter !== undefined ? { meter: m.meter as [number, number] } : {}),
        ...(m.freeTime !== undefined ? { freeTime: m.freeTime as boolean } : {}),
      };
      continue;
    }
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
    const paragraph = compileLine(line);
    if (pendingSection) Object.assign(paragraph, pendingSection);
    pendingSection = undefined;
    // 新音符行开始前，先把上一段已声明的连排区间落地。
    if (paras.length) applyPendingBeams(paras[paras.length - 1]);
    paras.push(paragraph);
  }
  if (paras.length) applyPendingBeams(paras[paras.length - 1]);
  for (const span of crossSpans) {
    const from = paras[span.start[0]]?.notations[span.start[1]];
    const to = paras[span.end[0]]?.notations[span.end[1]];
    if (!from || !to) throw new SyntaxError("跨段跨度端点超出乐谱");
    const owner = paras[span.start[0]];
    owner.spans ??= [];
    owner.spans.push({ kind: span.kind, startKey: from.key, endKey: to.key, ...(span.label ? { label: span.label } : {}) });
  }
  score.paragraphs = paras;
  return score;
}
