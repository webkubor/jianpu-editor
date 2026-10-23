/**
 * 简谱数据模型：一切皆符号（notation）的扁平结构
 * 原理来源：对 numerical-notation-editor（GPL-3.0）的数据模型逆向重写，未复制代码。
 * 音符、休止符、小节线、延音线统一为 Notation 节点，段落 = 有序符号数组。
 */

/** 音符唱名 0-7（0 = 休止符） */
export type NoteDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7";
/** 延音线（占一拍） */
export const EXTEND = "─";
/** 小节线 */
export const BAR = "│";
/** 终止线 */
export const DOUBLE_BAR = "‖";

export type NoteSymbol = NoteDigit | typeof EXTEND | typeof BAR | typeof DOUBLE_BAR;

/** 升降号（渲染在音符左上角） */
export type Accidental = "♯" | "♭";
/** 顶部装饰（如力度记号、装饰音标记，自由文本） */
export type TopDecorator = string;

/** 一个记谱符号：音符 / 休止符 / 小节线 / 延音线 */
export interface Notation {
  /** 唯一键（编辑定位用） */
  key: string;
  /** 音符本体 */
  note: NoteSymbol;
  /** 八度：-2/-1 低音点在下，1/2 高音点在上 */
  octave: number;
  /** 附点（音符右侧圆点，时值 +1/2） */
  dotted: boolean;
  /** 减时线层数（0-3，一条 = 八分音符） */
  underline: number;
  /** 禁止与前一音符的减时线连排 */
  breakUnderline: boolean;
  /** 前缀升降号 */
  prefixAccidentals: Accidental[];
  /** 顶部装饰符 */
  topDecorators: TopDecorator[];
  /** 连音线：指向同段落另一音符的 key（双向） */
  tieTo: string | null;
}

/** 段落（一行乐谱） */
export interface Paragraph {
  key: string;
  notations: Notation[];
  /** 两端对齐撑满页宽 */
  alignJustify: boolean;
  /** 段落左侧歌词（简谱常用上方/下方歌词行，此处按下标对应） */
  lyrics: string[];
}

/** 全局乐谱文档 */
export interface Score {
  version: number;
  title: string;
  /** 调号，如 "C" / "♯F" / "♭B" */
  tone: string;
  /** 拍号 [分母每小节拍数, 以几分音符为一拍]，如 [4,4] */
  beat: [number, number];
  /** 速度（bpm） */
  speed: number;
  /** 词曲作者行 */
  authors: string[];
  paragraphs: Paragraph[];
}

let keySeq = 0;
/** 生成符号唯一键 */
export function newKey(prefix = "n"): string {
  keySeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${keySeq}`;
}

/** 创建一个音符（默认 1 = do） */
export function createNote(init: Partial<Notation> = {}): Notation {
  return {
    key: newKey(),
    note: "1",
    octave: 0,
    dotted: false,
    underline: 0,
    breakUnderline: false,
    prefixAccidentals: [],
    topDecorators: [],
    tieTo: null,
    ...init,
  };
}

/** 创建小节线符号 */
export function createBar(note: typeof BAR | typeof DOUBLE_BAR = BAR): Notation {
  return createNote({ note });
}

/** 创建延音线符号 */
export function createExtend(): Notation {
  return createNote({ note: EXTEND });
}

/** 创建空段落 */
export function createParagraph(notes: Notation[] = []): Paragraph {
  return { key: newKey("p"), notations: notes, alignJustify: true, lyrics: [] };
}

const NOTE_DIGITS: NoteSymbol[] = ["0", "1", "2", "3", "4", "5", "6", "7", EXTEND, BAR, DOUBLE_BAR];

/** 是否音符/休止符（可参与转调的只有 1-7） */
export function isPitchable(n: Notation): boolean {
  return n.note >= "1" && n.note <= "7";
}

/** 是否合法符号本体 */
export function isNoteSymbol(s: string): s is NoteSymbol {
  return NOTE_DIGITS.includes(s as NoteSymbol);
}

/** 深拷贝一个符号（换新 key） */
export function cloneNotation(n: Notation): Notation {
  return createNote(JSON.parse(JSON.stringify(n)));
}

/** 新建空白乐谱 */
export function createScore(init: Partial<Score> = {}): Score {
  return {
    version: 1,
    title: "无标题",
    tone: "C",
    beat: [4, 4],
    speed: 75,
    authors: ["佚名  作词", "简谱编辑器  制谱"],
    paragraphs: [createParagraph()],
    ...init,
  };
}
