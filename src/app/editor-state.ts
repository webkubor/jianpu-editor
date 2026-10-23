/**
 * 编辑器应用状态：持有乐谱、光标（选中符号）、历史（撤销栈）
 * 路由：App 层唯一状态源；core 纯函数 + render 纯渲染，这里做粘合。
 * API：EditorState 类 —— move(+1/-1)、insert(note)、insertExtend()、insertBar()、
 *      backspace()、undo()、transpose(delta)、replaceScore()、toScore()。
 */

import {
  cloneNotation,
  createBar,
  createExtend,
  createNote,
  createParagraph,
  isPitchable,
} from "../core/model.ts";
import type { NoteDigit, Notation, Paragraph, Score } from "../core/model.ts";
import { transpose, transposeTo } from "../core/transpose.ts";

/** 撤销快照深度上限 */
const UNDO_LIMIT = 100;

type HistoryEntry = { score: Score; paragraph: number; item: number };

export class EditorState {
  private scoreValue: Score;
  /** 段落索引 */
  private paraIdx = 0;
  /** 段内符号索引（指向光标左边的符号；0 = 段首） */
  private itemIdx = 0;
  /** 撤销栈 */
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  /** 是否存在可撤销或重做的编辑。 */
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
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

  /** 当前段落（越界保护；空谱时先补一个空段） */
  get paragraph(): Paragraph {
    const paras = this.scoreValue.paragraphs;
    if (paras.length === 0) {
      paras.push(createParagraph());
      this.paraIdx = 0;
    }
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
  private capture(): HistoryEntry {
    return {
      score: {
        ...this.scoreValue,
        paragraphs: this.scoreValue.paragraphs.map((p) => ({
          ...p,
          lyrics: [...p.lyrics],
          notations: p.notations.map(cloneNotation),
        })),
      },
      paragraph: this.paraIdx,
      item: this.itemIdx,
    };
  }

  /** 新编辑记录历史并清除旧分支的重做记录。 */
  private snapshot(): void {
    this.undoStack.push(this.capture());
    this.redoStack = [];
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  /** 光标移动（负数 = 左） */
  move(delta: number): void {
    const items = this.paragraph.notations;
    this.itemIdx = Math.max(0, Math.min(items.length, this.itemIdx + delta));
    this.emit();
  }

  /** 按段落和符号下标定位；选择不进入编辑历史。 */
  selectItem(paragraph: number, index: number): void {
    if (!Number.isInteger(paragraph) || !Number.isInteger(index)) return;
    const para = this.scoreValue.paragraphs[paragraph];
    if (!para || index < 0 || index >= para.notations.length) return;
    this.paraIdx = paragraph;
    this.itemIdx = index + 1;
    this.emit();
  }

  /** 上下段切换 */
  moveParagraph(delta: number): void {
    this.paraIdx = Math.max(0, Math.min(this.scoreValue.paragraphs.length - 1, this.paraIdx + delta));
    this.itemIdx = Math.min(this.itemIdx, this.paragraph.notations.length);
    this.emit();
  }

  /** 整段上移/下移（重排）；光标跟随本段。 */
  reorderParagraph(delta: number): void {
    const from = this.paraIdx;
    const to = from + delta;
    const paras = [...this.scoreValue.paragraphs];
    if (to < 0 || to >= paras.length) {
      this.lastNotice = delta < 0 ? "已经在第一段" : "已经是最后一段";
      this.emit();
      return;
    }
    this.snapshot();
    [paras[from], paras[to]] = [paras[to], paras[from]];
    this.paraIdx = to;
    this.scoreValue = { ...this.scoreValue, paragraphs: paras };
    this.emit();
  }

  /** 删除当前整段；至少保留一段（最后一段清空而不是删除）。 */
  removeParagraph(): void {
    if (this.scoreValue.paragraphs.length <= 1) {
      this.lastNotice = "最后一段不可删除（会先清空内容）";
      this.emit();
      return;
    }
    this.snapshot();
    const paras = [...this.scoreValue.paragraphs];
    paras.splice(this.paraIdx, 1);
    this.paraIdx = Math.min(this.paraIdx, paras.length - 1);
    this.itemIdx = 0;
    this.scoreValue = { ...this.scoreValue, paragraphs: paras };
    this.emit();
  }

  /** 从光标拆段，歌词随所属音符移动，光标进入新段首。 */
  splitParagraph(): void {
    const para = this.paragraph;
    this.snapshot();
    const left = para.notations.slice(0, this.itemIdx);
    const right = para.notations.slice(this.itemIdx);
    const wordCount = left.filter(hasLyricSlot).length;
    const next = { ...createParagraph(right), alignJustify: para.alignJustify, lyrics: para.lyrics.slice(wordCount) };
    const paragraphs = [...this.scoreValue.paragraphs];
    paragraphs.splice(this.paraIdx, 1, { ...para, notations: left, lyrics: para.lyrics.slice(0, wordCount) }, next);
    this.scoreValue = { ...this.scoreValue, paragraphs };
    this.paraIdx += 1;
    this.itemIdx = 0;
    this.emit();
  }

  /** 复制当前段并插入到其下方（旋律重复是简谱高频操作），光标进入副本段首。 */
  duplicateParagraph(): void {
    const para = this.paragraph;
    this.snapshot();
    const copy: Paragraph = {
      ...createParagraph(para.notations.map(cloneNotation)),
      alignJustify: para.alignJustify,
      lyrics: [...para.lyrics],
    };
    const paragraphs = [...this.scoreValue.paragraphs];
    paragraphs.splice(this.paraIdx + 1, 0, copy);
    this.scoreValue = { ...this.scoreValue, paragraphs };
    this.paraIdx += 1;
    this.itemIdx = 0;
    this.emit();
  }

  /** 插入一个音符（继承前音符八度，简谱输入直觉） */
  insertNote(digit: string): void {
    this.snapshot();
    const para = this.paragraph;
    const prev = this.currentItem;
    const octave = prev && prev.note >= "1" && prev.note <= "7" ? prev.octave : 0;
    const note = createNote({ note: digit as NoteDigit, octave });
    // 休止符不吃八度/升降号（无音高）；渲染时也按裸 0 处理
    if (digit === "0") {
      note.octave = 0;
      note.prefixAccidentals = [];
    }
    const items = [...para.notations];
    items.splice(this.itemIdx, 0, note);
    this.itemIdx += 1;
    this.replaceParagraphNotations(items);
  }

  /** 插入延音线（继承前音符的减时线层数与八度）；段首无处延续则提示并忽略。 */
  insertExtend(): void {
    const prev = this.currentItem;
    if (!prev) {
      this.lastNotice = "延音线：段首没有可延续的音符";
      this.emit();
      return;
    }
    this.snapshot();
    const para = this.paragraph;
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

  /** 删除光标左边一个符号；段首时合并上一段。 */
  backspace(): void {
    if (this.itemIdx === 0) {
      if (this.paraIdx === 0) return;
      this.snapshot();
      const paragraphs = [...this.scoreValue.paragraphs];
      const previous = paragraphs[this.paraIdx - 1];
      const current = paragraphs[this.paraIdx];
      const wordCount = previous.notations.filter(hasLyricSlot).length;
      const lyrics = Array.from({ length: wordCount }, (_, i) => previous.lyrics[i] ?? "");
      paragraphs.splice(this.paraIdx - 1, 2, {
        ...previous,
        notations: [...previous.notations, ...current.notations],
        lyrics: [...lyrics, ...current.lyrics],
      });
      this.itemIdx = previous.notations.length;
      this.paraIdx -= 1;
      this.scoreValue = { ...this.scoreValue, paragraphs };
      this.emit();
      return;
    }
    this.snapshot();
    const para = this.paragraph;
    const items = [...para.notations];
    // 删除连音线一端时同步解除另一端的悬空引用
    const removed = items[this.itemIdx - 1];
    if (removed?.tieTo) {
      const partner = items.find(o => o.key === removed.tieTo);
      if (partner) {
        const patched = cloneNotation(partner);
        patched.tieTo = null;
        items[items.indexOf(partner)] = patched;
      }
    }
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

  /** 调整当前音符或休止符的减时线，覆盖分组推断时值。 */
  changeDuration(delta: number): void {
    const prev = this.currentItem;
    if (!prev || prev.note < "0" || prev.note > "7") return;
    const underline = Math.max(0, Math.min(3, prev.underline + delta));
    if (underline === prev.underline && prev.beatFrac === 1 / 2 ** underline) return;
    this.snapshot();
    const items = [...this.paragraph.notations];
    items[this.itemIdx - 1] = { ...cloneNotation(prev), underline, beatFrac: 1 / 2 ** underline };
    this.replaceParagraphNotations(items);
  }

  /** 修改光标左边音符或休止符的附点开关。 */
  toggleDotted(): void {
    const prev = this.currentItem;
    if (!prev || prev.note < "0" || prev.note > "7") return;
    this.snapshot();
    const para = this.paragraph;
    const idx = this.itemIdx - 1;
    const items = [...para.notations];
    items[idx] = cloneNotation(prev);
    items[idx].dotted = !prev.dotted;
    this.replaceParagraphNotations(items);
  }

  /** 设置光标左边音符的歌词（空串 = 清除） */
  setLyric(text: string): void {
    const prev = this.currentItem;
    if (!prev || !hasLyricSlot(prev)) return;
    this.snapshot();
    const para = this.paragraph;
    const soundingIdx = para.notations.slice(0, this.itemIdx).filter(hasLyricSlot).length - 1;
    const lyrics = [...para.lyrics];
    while (lyrics.length <= soundingIdx) lyrics.push("");
    lyrics[soundingIdx] = text;
    const paras = [...this.scoreValue.paragraphs];
    paras[this.paraIdx] = { ...this.paragraph, lyrics };
    this.scoreValue = { ...this.scoreValue, paragraphs: paras };
    this.emit();
  }

  /** 光标左边音符的当前歌词（最近一次操作被忽略时返回简短原因） */
  get currentLyric(): string {    const prev = this.currentItem;
    if (!prev || !hasLyricSlot(prev)) return "";
    const para = this.paragraph;
    let soundingIdx = -1;
    for (let i = 0; i <= this.itemIdx - 1 && i < para.notations.length; i += 1) {
      const n = para.notations[i];
      if ((n.note >= "1" && n.note <= "7") || n.note === "─") soundingIdx += 1;
    }
    return para.lyrics[soundingIdx] ?? "";
  }

  /** 最近一次操作被忽略的简短原因（空串 = 无），由状态栏显示。 */
  lastNotice = "";

  /** 歌词连续输入模式（Shift+L 切换）。模式中普通字符累积成词、空格/回车提交并右移到下一发声符号。 */
  lyricMode = false;
  private lyricBuffer = "";

  get lyricDraft(): string {
    return this.lyricBuffer;
  }

  /** 词模式：累积字符（含中文）。 */
  lyricType(ch: string): void {
    if (!this.lyricMode) return;
    this.lyricBuffer += ch;
    this.emit();
  }

  /** 词模式：提交当前缓冲到光标左边发声符号，光标右移到下一发声符号（正向逐词推进）。 */
  lyricCommit(): void {
    if (!this.lyricMode) return;
    const word = this.lyricBuffer.trim();
    this.lyricBuffer = "";
    if (!word) {
      this.lastNotice = "词模式：空词跳过（输入内容后按空格提交）";
      this.emit();
      return;
    }
    const prev = this.currentItem;
    if (!prev || !hasLyricSlot(prev)) {
      this.lastNotice = "词模式：光标左边不是发声符号（←→ 移到音符后再提交）";
      this.emit();
      return;
    }
    this.setLyric(word);
    // 写入成功：右移越过当前符号，下一个词落到下一个发声符号
    this.move(1);
  }

  /** 词模式：退格删缓冲末字符；缓冲空时清掉光标左边符号的词。 */
  lyricBackspace(): void {
    if (!this.lyricMode) return;
    if (this.lyricBuffer) {
      this.lyricBuffer = this.lyricBuffer.slice(0, -1);
      this.emit();
    } else {
      this.setLyric("");
    }
  }

  /** 切换词模式；退出时丢弃未提交缓冲。 */
  toggleLyricMode(): void {
    this.lyricMode = !this.lyricMode;
    this.lyricBuffer = "";
    this.emit();
  }

  /** 在光标左边音符与下一个符号建立连音线；已连接时断开。目标无效时记录原因不静默。 */
  tieToNext(): void {
    this.lastNotice = "";
    const prev = this.currentItem;
    const next = this.paragraph.notations[this.itemIdx];
    if (!prev) { this.lastNotice = "连音线：光标左边没有音符"; this.emit(); return; }
    if (!next) { this.lastNotice = "连音线：右边没有可连的音符"; this.emit(); return; }
    if (!isPitchable(prev) || !isPitchable(next)) { this.lastNotice = "连音线：只能连接两个音符"; this.emit(); return; }
    this.snapshot();
    const paras = [...this.scoreValue.paragraphs];
    paras[this.paraIdx] = { ...this.paragraph, notations: this.paragraph.notations.map(cloneNotation) };
    const items = paras[this.paraIdx].notations;
    const left = items[this.itemIdx - 1];
    const right = items[this.itemIdx];
    if (left.tieTo === right.key) {
      left.tieTo = null;
      right.tieTo = null;
    } else {
      left.tieTo = right.key;
      right.tieTo = left.key;
    }
    this.scoreValue = { ...this.scoreValue, paragraphs: paras };
    this.emit();
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

  /** 修改播放速度（BPM 20–240）。常规编辑，可撤销（不走 replaceScore 以免清撤销栈）。 */
  setSpeed(bpm: number): void {
    const speed = Math.max(20, Math.min(240, Number.isFinite(bpm) ? bpm : 72));
    if (speed === this.scoreValue.speed) return;
    this.snapshot();
    this.scoreValue = { ...this.scoreValue, speed };
    this.emit();
  }

  /** 修改曲名并保留编辑光标；空白曲名使用默认值。 */
  setTitle(title: string): void {
    const next = title.trim() || "未命名";
    if (next === this.scoreValue.title) return;
    this.snapshot();
    this.scoreValue = { ...this.scoreValue, title: next };
    this.emit();
  }

  /** 整体替换乐谱（打开文件 / DSL 灌入）。新谱是新起点：清空撤销/重做栈，避免 ⌘Z 串回旧谱。 */
  replaceScore(score: Score): void {
    this.scoreValue = score;
    this.paraIdx = 0;
    this.itemIdx = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /** 撤销 */
  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.capture());
    this.restore(prev);
  }

  /** 重做最近撤销的编辑，同时恢复光标。 */
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.capture());
    this.restore(next);
  }

  private restore(prev: HistoryEntry): void {
    this.scoreValue = prev.score;
    this.paraIdx = Math.max(0, Math.min(prev.paragraph, prev.score.paragraphs.length - 1));
    this.itemIdx = Math.min(prev.item, prev.score.paragraphs[this.paraIdx]?.notations.length ?? 0);
    this.emit();
  }

  /** 用新的符号数组替换当前段落并广播 */
  private replaceParagraphNotations(items: Notation[]): void {
    const paras = [...this.scoreValue.paragraphs];
    const oldParagraph = this.paragraph;
    const wordsByKey = new Map<string, string>();
    let wordIndex = 0;
    for (const note of oldParagraph.notations) {
      if (hasLyricSlot(note)) wordsByKey.set(note.key, oldParagraph.lyrics[wordIndex++] ?? "");
    }
    const lyrics = items.filter(hasLyricSlot).map(note => wordsByKey.get(note.key) ?? "");
    paras[this.paraIdx] = { ...oldParagraph, notations: items, lyrics };
    this.scoreValue = { ...this.scoreValue, paragraphs: paras };
    this.emit();
  }
}

/** 音符与延音线拥有歌词位置；休止符、小节线跳过。 */
function hasLyricSlot(note: Notation): boolean {
  return (note.note >= "1" && note.note <= "7") || note.note === "─";
}
