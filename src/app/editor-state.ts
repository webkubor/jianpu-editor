/**
 * 编辑器应用状态：持有乐谱、光标（选中符号）、历史（撤销栈）
 * 路由：App 层唯一状态源；core 纯函数 + render 纯渲染，这里做粘合。
 * API：EditorState 类 —— move(+1/-1)、insert(note)、insertExtend()、insertBar()、
 *      backspace()、undo()、transpose(delta)、replaceScore()、toScore()。
 */

import {
  NoteDigit,
  Notation,
  Paragraph,
  Score,
  cloneNotation,
  createBar,
  createExtend,
  createNote,
} from "../core/model.ts";
import { transpose, transposeTo } from "../core/transpose.ts";

/** 撤销快照深度上限 */
const UNDO_LIMIT = 100;

export class EditorState {
  private scoreValue: Score;
  /** 段落索引 */
  private paraIdx = 0;
  /** 段内符号索引（指向光标左边的符号；0 = 段首） */
  private itemIdx = 0;
  /** 撤销栈 */
  private undoStack: Score[] = [];
  /** 变更监听 */
  private listeners = new Set<() => void>();

  constructor(score: Score) {
    this.scoreValue = score;
  }

  get score(): Score {
    return this.scoreValue;
  }

  get paragraphIndex(): number {
    return this.paraIdx;
  }

  get itemIndex(): number {
    return this.itemIdx;
  }

  /** 当前段落（越界保护） */
  get paragraph(): Paragraph {
    const paras = this.scoreValue.paragraphs;
    const idx = Math.min(this.paraIdx, paras.length - 1);
    return paras[Math.max(0, idx)];
  }

  /** 光标左边的符号（可能为 null = 段首） */
  get currentItem(): Notation | null {
    const items = this.paragraph.notations;
    if (this.itemIdx <= 0) return null;
    return items[Math.min(this.itemIdx, items.length) - 1] ?? null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** 变更前压栈（浅拷贝段落结构，符号对象共享——符号本身视为不可变值） */
  private snapshot(): void {
    this.undoStack.push({
      ...this.scoreValue,
      paragraphs: this.scoreValue.paragraphs.map((p) => ({
        ...p,
        notations: p.notations.map(cloneNotation),
      })),
    });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  /** 光标移动（负数 = 左） */
  move(delta: number): void {
    const items = this.paragraph.notations;
    this.itemIdx = Math.max(0, Math.min(items.length, this.itemIdx + delta));
    this.emit();
  }

  /** 上下段切换 */
  moveParagraph(delta: number): void {
    this.paraIdx = Math.max(0, Math.min(this.scoreValue.paragraphs.length - 1, this.paraIdx + delta));
    this.itemIdx = Math.min(this.itemIdx, this.paragraph.notations.length);
    this.emit();
  }

  /** 插入一个音符（继承前音符八度，简谱输入直觉） */
  insertNote(digit: string): void {
    this.snapshot();
    const para = this.paragraph;
    const prev = this.currentItem;
    const octave = prev && prev.note >= "1" && prev.note <= "7" ? prev.octave : 0;
    const note = createNote({ note: digit as NoteDigit, octave });
    const items = [...para.notations];
    items.splice(this.itemIdx, 0, note);
    this.itemIdx += 1;
    this.replaceParagraphNotations(items);
  }

  /** 插入延音线（继承前音符的减时线层数与八度） */
  insertExtend(): void {
    this.snapshot();
    const para = this.paragraph;
    const prev = this.currentItem;
    if (!prev) return;
    const ext = createExtend();
    ext.underline = prev.underline;
    const items = [...para.notations];
    items.splice(this.itemIdx, 0, ext);
    this.itemIdx += 1;
    this.replaceParagraphNotations(items);
  }

  /** 插入小节线 */
  insertBar(): void {
    this.snapshot();
    const para = this.paragraph;
    const bar = createBar();
    const items = [...para.notations];
    items.splice(this.itemIdx, 0, bar);
    this.itemIdx += 1;
    this.replaceParagraphNotations(items);
  }

  /** 删除光标左边一个符号 */
  backspace(): void {
    if (this.itemIdx === 0) return;
    this.snapshot();
    const para = this.paragraph;
    const items = [...para.notations];
    items.splice(this.itemIdx - 1, 1);
    this.itemIdx -= 1;
    this.replaceParagraphNotations(items);
  }

  /** 修改光标左边音符的八度（dir +1 高八度 / -1 低八度） */
  tweakOctave(dir: number): void {
    const prev = this.currentItem;
    if (!prev || prev.note < "1" || prev.note > "7") return;
    this.snapshot();
    const para = this.paragraph;
    const idx = this.itemIdx - 1;
    const items = [...para.notations];
    items[idx] = cloneNotation(prev);
    items[idx].octave = Math.max(-2, Math.min(2, prev.octave + dir));
    this.replaceParagraphNotations(items);
  }

  /** 修改光标左边音符的附点开关 */
  toggleDotted(): void {
    const prev = this.currentItem;
    if (!prev || prev.note < "1" || prev.note > "7") return;
    this.snapshot();
    const para = this.paragraph;
    const idx = this.itemIdx - 1;
    const items = [...para.notations];
    items[idx] = cloneNotation(prev);
    items[idx].dotted = !prev.dotted;
    this.replaceParagraphNotations(items);
  }

  /** 整谱转调（相对半音数）——transpose 原地改，先深拷贝再替换 */
  transpose(delta: number): void {
    this.snapshot();
    const next: Score = {
      ...this.scoreValue,
      paragraphs: this.scoreValue.paragraphs.map((p) => ({
        ...p,
        notations: p.notations.map(cloneNotation),
      })),
    };
    transpose(next, delta);
    this.scoreValue = next;
    this.emit();
  }

  /** 整谱转到目标调 */
  transposeTo(destTone: string): void {
    this.snapshot();
    const next: Score = {
      ...this.scoreValue,
      paragraphs: this.scoreValue.paragraphs.map((p) => ({
        ...p,
        notations: p.notations.map(cloneNotation),
      })),
    };
    transposeTo(next, destTone);
    this.scoreValue = next;
    this.emit();
  }

  /** 整体替换乐谱（DSL 导入等） */
  replaceScore(score: Score): void {
    this.snapshot();
    this.scoreValue = score;
    this.paraIdx = 0;
    this.itemIdx = 0;
    this.emit();
  }

  /** 撤销 */
  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.scoreValue = prev;
    this.paraIdx = Math.min(this.paraIdx, prev.paragraphs.length - 1);
    this.itemIdx = Math.min(this.itemIdx, prev.paragraphs[this.paraIdx]?.notations.length ?? 0);
    this.emit();
  }

  /** 用新的符号数组替换当前段落并广播 */
  private replaceParagraphNotations(items: Notation[]): void {
    const paras = [...this.scoreValue.paragraphs];
    paras[this.paraIdx] = { ...this.paragraph, notations: items };
    this.scoreValue = { ...this.scoreValue, paragraphs: paras };
    this.emit();
  }
}
