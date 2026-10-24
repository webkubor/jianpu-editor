/**
 * 简谱编辑器入口：单页应用壳
 * 职责：挂载 SVG 画布、键盘事件路由（数字=音符，空格=延音线，|，Backspace，方向键），
 *       工具栏（转调/速度/DSL/保存/播放），把 core+render+state 三层粘起来。
 */

import { EditorState } from "./editor-state.ts";
import { renderScore, renderScoreSvg } from "../render/svg-render.ts";
import { Player, compileEvents, midiOf, timeBefore, toMidi } from "../core/player.ts";
import { compileScore } from "../core/dsl.ts";
import { toDsl } from "../core/dsl-export.ts";
import { validateScore } from "../core/validate.ts";
import { createScore, isPitchable } from "../core/model.ts";
import { autosave, deserializeScore, downloadBinary, downloadScore, downloadText, loadAutosave, sanitizeFilename } from "../core/serialize.ts";
import { EXAMPLES } from "../core/examples.ts";

/** 从 localStorage 恢复或用默认谱 */
function initialScore() {
  return loadAutosave() ?? createScore({
    title: "未命名",
    tone: "C",
    speed: 72,
    paragraphs: [],
  });
}

const state = new EditorState(initialScore());
const player = new Player();
const canvas = document.getElementById("canvas")!;
const titleInput = document.getElementById("score-title") as HTMLInputElement;
const beatSelect = document.getElementById("beat") as HTMLSelectElement;
const toneSelect = document.getElementById("tone") as HTMLSelectElement;
const speedInput = document.getElementById("speed") as HTMLInputElement;
const authorsInput = document.getElementById("authors") as HTMLInputElement;
const dslArea = document.getElementById("dsl") as HTMLTextAreaElement;
// DSL 面板是双向入口：画布编辑会回写 DSL 文本，但用户手打的草稿不能被覆盖（点「导入」或外部灌入后才清除标记）
let dslDirty = false;
let metronomeEnabled = false;
const metronomeBtn = document.getElementById("metronome") as HTMLButtonElement | null;
metronomeBtn?.addEventListener("click", () => {
  metronomeEnabled = !metronomeEnabled;
  metronomeBtn.classList.toggle("active", metronomeEnabled);
  metronomeBtn.textContent = metronomeEnabled ? "⏱ 节拍器 (开)" : "⏱ 节拍器";
});
dslArea.addEventListener("input", () => { dslDirty = true; });
dslArea.addEventListener("blur", () => {
  // 离开面板且内容与当前谱一致时视为已同步，恢复自动回写
  if (dslArea.value === toDsl(state.score)) dslDirty = false;
});
const statusEl = document.getElementById("status")!;

/** 当前光标符号 key（渲染高亮用） */
function selectedKey(): string | null {
  return state.currentItem?.key ?? null;
}

/** 渲染 + 自动保存 + 拍数校验 */
function refresh(): void {
  renderScore(canvas, state.score, selectedKey());
  autosave(state.score);
  (document.getElementById("undo") as HTMLButtonElement).disabled = !state.canUndo;
  (document.getElementById("redo") as HTMLButtonElement).disabled = !state.canRedo;
  if (document.activeElement !== titleInput) titleInput.value = state.score.title;
  document.title = `${state.score.title} · 简谱编辑器`;
  beatSelect.value = `${state.score.beat[0]}/${state.score.beat[1]}`;
  toneSelect.value = state.score.tone;
  speedInput.value = String(state.score.speed);
  if (document.activeElement !== authorsInput) authorsInput.value = state.score.authors.join("  ");
  if (!dslDirty) dslArea.value = toDsl(state.score);  const issues = validateScore(state.score);
  const warn = issues.length
    ? ` · ⚠ ${issues.length} 个小节拍数异常（${issues.slice(0, 2).map((i) => `段${i.paragraph + 1}小节${i.bar + 1}:${i.beats}/${i.expected}拍`).join("、")}）`
    : "";
  const notice = state.lastNotice ? ` · ${state.lastNotice}` : "";
  const lyric = state.lyricMode ? ` · ✎ 词模式「${state.lyricDraft}」空格提交 / Esc 退出` : "";
  statusEl.textContent = `${state.score.title} · ${state.score.paragraphs.length} 段 · 光标 段${state.paragraphIndex + 1}/位${state.itemIndex}${warn}${notice}${lyric}`;
  // 光标滚动跟随：↑↓ 换段 / 长段编辑时光标保持在视口内（播放跟随走 highlightIndex，此处只管编辑光标）
  const cursorGlyph = canvas.querySelector(
    `.paragraph[data-para="${state.paragraphIndex}"] .glyph[data-idx="${state.itemIndex - 1}"]`,
  );
  cursorGlyph?.scrollIntoView({ block: "nearest", inline: "nearest" });
  restorePlayingHighlight();
}
state.subscribe(refresh);

/** 画布点击直接选中符号，跨段与自动换行使用相同定位信息。 */
canvas.addEventListener("click", (event) => {
  const glyph = (event.target as Element).closest<SVGGElement>(".glyph");
  const row = glyph?.closest<SVGGElement>(".paragraph");
  if (!glyph || !row) return;
  state.selectItem(Number(row.dataset.para), Number(glyph.dataset.idx));
  previewCurrentTone();
  (document.activeElement as HTMLElement | null)?.blur();
});

/** 当前光标所在音符触发单音试听反馈。 */
function previewCurrentTone(): void {
  const item = state.currentItem;
  if (item && isPitchable(item)) {
    player.playTone(midiOf(state.score.tone, item));
  }
}

/** 键盘主路由 */
window.addEventListener("keydown", (e) => {
  // 输入框聚焦时不劫持
  const target = e.target as HTMLElement;
  if (e.isComposing || e.defaultPrevented || target.closest('input, textarea, select, [contenteditable="true"]')) return;
  // 保留系统组合键：⌘1 切标签、⌘± 缩放等不应修改乐谱（⌥↑↓ 段重排、⌘⇧Enter 复制段除外）。
  if (e.metaKey || e.ctrlKey || (e.altKey && e.key !== "ArrowUp" && e.key !== "ArrowDown")) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
      if (e.shiftKey) state.redo();
      else state.undo();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
      state.duplicateParagraph();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
      state.removeParagraph();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
      state.duplicateMeasure();
      e.preventDefault();
    }
    return;
  }
  // 按钮保留原生 Enter/空格激活行为。
  if (target.closest('button, a') && (e.key === "Enter" || e.key === " ")) return;

  state.lastNotice = "";
  if (/^[0-7]$/.test(e.key)) {
    state.insertNote(e.key);
    if (e.key !== "0") previewCurrentTone();
    e.preventDefault();
    return;
  }
  // 歌词连续输入模式：可打印字符进词缓冲（数字/字母/汉字/常用符号），Esc 退出
  if (state.lyricMode) {
    if (e.key === "Escape") {
      state.toggleLyricMode();
      e.preventDefault();
      return;
    }
    if (e.key.length === 1 && e.key !== " " && e.key !== "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      state.lyricType(e.key);
      e.preventDefault();
      return;
    }
  }
  switch (e.key) {
    case " ": {
      if (state.lyricMode) {
        state.lyricCommit();
        e.preventDefault();
        break;
      }
      state.insertExtend();
      e.preventDefault();
      break;
    }
    case "|":
      if (!state.lyricMode) state.insertBar();
      e.preventDefault();
      break;
    case "Backspace":
      if (state.lyricMode) state.lyricBackspace();
      else state.backspace();
      e.preventDefault();
      break;
    case "ArrowLeft":
      state.move(-1);
      e.preventDefault();
      break;
    case "ArrowRight":
      state.move(1);
      e.preventDefault();
      break;
    case "ArrowUp":
      if (e.altKey) state.reorderParagraph(-1);
      else state.moveParagraph(-1);
      e.preventDefault();
      break;
    case "ArrowDown":
      if (e.altKey) state.reorderParagraph(1);
      else state.moveParagraph(1);
      e.preventDefault();
      break;
    case "=":
    case "+":
      state.tweakOctave(1);
      previewCurrentTone();
      e.preventDefault();
      break;
    case "-":
      state.tweakOctave(-1);
      previewCurrentTone();
      e.preventDefault();
      break;
    case "[":
      state.changeDuration(-1);
      e.preventDefault();
      break;
    case "~":
      state.tieToNext();
      e.preventDefault();
      break;
    case "]":
      state.changeDuration(1);
      e.preventDefault();
      break;
    case ".":
      state.toggleDotted();
      e.preventDefault();
      break;
    case ";":
    case "；":
      if (!state.lyricMode) {
        state.cycleTopDecorator();
        e.preventDefault();
      }
      break;
    case "#":
    case "b":
    case "B":
      if (!state.lyricMode) {
        state.cycleAccidental();
        previewCurrentTone();
        e.preventDefault();
      }
      break;
    case "l":
    case "L": {
      if (e.shiftKey) {
        // Shift+L 切换歌词连续输入模式：逐词空格提交，向左推进
        state.toggleLyricMode();
      } else {
        // 歌词：弹出行内输入，回车写入当前符号
        const word = window.prompt("歌词（写入光标左边发声符号；留空清除）", state.currentLyric);
        if (word !== null) state.setLyric(word.trim());
      }
      e.preventDefault();
      break;
    }
    case "Enter": {
      if (e.shiftKey) {
        state.splitParagraph();
        e.preventDefault();
        break;
      }
      // 播放/停止（⇧Enter 拆段占用；⇧+播放按钮 = 从光标处播）
      if (player.playing) {
        player.stop();
        clearHighlight();
      } else {
        const score = state.score;
        const from = e.shiftKey ? timeBefore(score, state.paragraphIndex, state.itemIndex) : 0;
        const events = compileEvents(score).filter(ev => ev.start >= from - 1e-9)
          .map(ev => ({ ...ev, start: ev.start - from }));
        player.play(
          events,
          { onNote: (i, p) => highlightIndex(i, p), onEnd: clearHighlight },
          { metronome: metronomeEnabled, beat: score.beat, speed: score.speed }
        );
        updatePlayButton();
      }
      e.preventDefault();
      break;
    }
    default:
      break;
  }
});

const playButton = document.getElementById("play") as HTMLButtonElement | null;

function updatePlayButton(): void {
  if (playButton) {
    if (player.playing) {
      playButton.textContent = "⏹ 停止 (Enter)";
      playButton.classList.add("btn-playing");
    } else {
      playButton.textContent = "▶ 播放 (Enter)";
      playButton.classList.remove("btn-playing");
    }
  }
}
let playingNow: { index: number; paragraph: number } | null = null;

function highlightIndex(index: number, paragraph: number): void {
  // 只摘除旧高亮 class，playingNow 由下方赋值更新（clearHighlight 会清状态，不能先用）
  canvas.querySelectorAll(".playing").forEach((g) => g.classList.remove("playing"));
  canvas.querySelectorAll(".lyric-playing").forEach((t) => t.classList.remove("lyric-playing"));
  playingNow = { index, paragraph };
  const target = canvas.querySelector(
    `.paragraph[data-para="${paragraph}"] .glyph[data-idx="${index}"]`,
  );
  target?.classList.add("playing");
  // 卡拉OK：当前音符发声时亮它自己的词（data-sounding 在渲染时挂在 glyph 与 lyric 上）
  const sounding = target?.getAttribute("data-sounding");
  if (sounding !== undefined && sounding !== null) {
    canvas.querySelector(
      `.paragraph[data-para="${paragraph}"] .lyric[data-sounding="${sounding}"]`,
    )?.classList.add("lyric-playing");
  }
  // 长谱播放：当前音滚入视口（已在视口内则不动；auto 避免快速音符动画堆积）
  target?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function clearHighlight(): void {
  playingNow = null;
  canvas.querySelectorAll(".playing").forEach((g) => g.classList.remove("playing"));
  canvas.querySelectorAll(".lyric-playing").forEach((t) => t.classList.remove("lyric-playing"));
  updatePlayButton();
}

/** 播放期间编辑乐谱会全量重建 DOM 抹掉高亮——每次刷新后按播放位置补挂。 */
function restorePlayingHighlight(): void {
  if (playingNow) {
    const { index, paragraph } = playingNow;
    const target = canvas.querySelector(
      `.paragraph[data-para="${paragraph}"] .glyph[data-idx="${index}"]`,
    );
    target?.classList.add("playing");
    const sounding = target?.getAttribute("data-sounding");
    if (sounding !== undefined && sounding !== null) {
      canvas.querySelector(
        `.paragraph[data-para="${paragraph}"] .lyric[data-sounding="${sounding}"]`,
      )?.classList.add("lyric-playing");
    }
  }
}

/** 工具栏事件 */
document.getElementById("undo")?.addEventListener("click", () => state.undo());
document.getElementById("redo")?.addEventListener("click", () => state.redo());
titleInput.addEventListener("input", () => {
  state.setTitle(titleInput.value);
});
titleInput.addEventListener("change", () => {
  state.setTitle(titleInput.value);
});
beatSelect.addEventListener("change", () => {
  const parts = beatSelect.value.split("/").map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
    state.setBeat([parts[0], parts[1]]);
  }
});
authorsInput.addEventListener("input", () => {
  const raw = authorsInput.value.split(/[,，\s]+/).filter(Boolean);
  state.setAuthors(raw);
});
authorsInput.addEventListener("change", () => {
  const raw = authorsInput.value.split(/[,，\s]+/).filter(Boolean);
  state.setAuthors(raw);
});
document.getElementById("transpose-up")?.addEventListener("click", () => state.transpose(1));
document.getElementById("transpose-down")?.addEventListener("click", () => state.transpose(-1));

toneSelect.addEventListener("change", () => {
  state.transposeTo(toneSelect.value);
});

speedInput.addEventListener("change", () => {
  state.setSpeed(Number(speedInput.value));
});

document.getElementById("apply-dsl")?.addEventListener("click", () => {
  applyDsl(dslArea.value);
});

/** DSL 灌入共用入口（按钮与 ⌘V 粘贴）；失败在状态栏报错，不打断输入。灌入成功后恢复 DSL 自动回写。 */
function applyDsl(text: string): void {
  try {
    const score = compileScore(text, { ...state.score, paragraphs: [] });
    state.replaceScore(score);
    dslDirty = false;
  } catch (err) {
    statusEl.textContent = `DSL 错误：${(err as Error).message}`;
  }
}

/** 画布上 ⌘C：把全谱 DSL 复制到剪贴板——与 ⌘V 灌入对称，方便把谱子发给别人。 */
/** IME 中文输入：composition 期间 keydown 的 key='Process' 不进词缓冲，组合完成后在 compositionend 整段入词。 */
canvas.addEventListener("compositionend", (ev) => {
  if (!state.lyricMode) return;
  const text = ev.data ?? "";
  for (const ch of text) state.lyricType(ch);
});

canvas.addEventListener("copy", (ev) => {
  ev.clipboardData?.setData("text/plain", toDsl(state.score));
  ev.preventDefault();
});

/** 画布上 ⌘V：剪贴板里像简谱 DSL 的文本直接灌入（复制别人发的谱子也能直接用）。
 * 行级判定：音符行必须由数字/DSL 符号组成，词行必须是 [词:…] 格式；至少含一行音符行。
 * 词行语义是「修饰上方音符行」，若粘贴文本把词行写在音符行前，先重排成规范顺序。 */
canvas.addEventListener("paste", (ev) => {
  const text = ev.clipboardData?.getData("text/plain") ?? "";
  if (!text.trim()) return;
  const noteLine = /^[0-9０-９\s|‖~～\-－.,，'′＾^#ｂ♭♯ｂ＃]+$/;
  const lyricLine = /^\[词:[^\]\n]*\]$/;
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const isScore = lines.length > 0 && lines.every(l => noteLine.test(l) || lyricLine.test(l)) && lines.some(l => /[0-9０-９]/.test(l));
  if (!isScore) return;
  ev.preventDefault();
  // 词行重排：前缀词行吸附到其后最近音符行**之后**（DSL 语义词行修饰上方行）
  const result: string[] = [];
  const queue: string[] = [];
  for (const l of lines) {
    if (lyricLine.test(l)) {
      queue.push(l);
      continue;
    }
    result.push(l);
    result.push(...queue.splice(0));
  }
  result.push(...queue);
  applyDsl(result.join("\n"));
});

document.getElementById("export-dsl")?.addEventListener("click", () => {
  dslArea.value = toDsl(state.score);
});

document.getElementById("save")?.addEventListener("click", () => {
  downloadScore(state.score);
});

/** 打印/导出 PNG：SVG 序列化 → 离屏 canvas → 下载 */
// MIDI 导出：单轨 format 0，速度取当前乐谱，可导入 DAW / 打谱软件
document.getElementById("export-midi")?.addEventListener("click", () => {
  const events = compileEvents(state.score);
  const data = toMidi(events, state.score.speed);
  downloadBinary(data, `${sanitizeFilename(state.score.title)}.mid`);
});

document.getElementById("export-png")?.addEventListener("click", () => {  const svg = renderScoreSvg(state.score, null);
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2; // 2x 高清
    const cv = document.createElement("canvas");
    cv.width = 860 * scale;
    cv.height = (svg.viewBox.baseVal.height || 400) * scale;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    const a = document.createElement("a");
    a.href = cv.toDataURL("image/png");
    a.download = `${sanitizeFilename(state.score.title || "简谱")}.png`;
    a.click();
  };
  img.src = url;
});

// SVG 矢量导出：原汁原味可缩放矢量文件，支持插图与排版排版软件
document.getElementById("export-svg")?.addEventListener("click", () => {
  const svg = renderScoreSvg(state.score, null);
  const xml = new XMLSerializer().serializeToString(svg);
  downloadText(xml, `${sanitizeFilename(state.score.title || "简谱")}.svg`);
});

/** 打印：新窗口只含乐谱 SVG，触发打印对话框 */
document.getElementById("print")?.addEventListener("click", () => {
  const svg = renderScoreSvg(state.score, null);
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head><title>简谱</title>
    <style>body{margin:24px;font-family:"Songti SC",serif}svg{max-width:100%}@media print{body{margin:0}}</style>
    </head><body></body></html>`);
  w.document.title = state.score.title;
  w.document.body.appendChild(w.document.importNode(svg, true));
  w.document.close();
  w.focus();
  w.print();
});

/** 打开 .jianpu.json */
document.getElementById("open")?.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const score = deserializeScore(String(reader.result));
    if (score) {
      state.replaceScore(score);
    } else {
      statusEl.textContent = "文件格式不对：需要 .jianpu.json（本编辑器导出的）";
    }
    input.value = "";
  };
  reader.readAsText(file);
});

document.getElementById("play")?.addEventListener("click", (ev) => {
  if (player.playing) {
    player.stop();
    clearHighlight();
    return;
  }
  const from = (ev as MouseEvent).shiftKey ? timeBefore(state.score, state.paragraphIndex, state.itemIndex) : 0;
  const events = compileEvents(state.score).filter(e => e.start >= from - 1e-9)
    .map(e => ({ ...e, start: e.start - from }));
  player.play(
    events,
    { onNote: (i, p) => highlightIndex(i, p), onEnd: clearHighlight },
    { metronome: metronomeEnabled, beat: state.score.beat, speed: state.score.speed }
  );
  updatePlayButton();
});

const exampleSelect = document.getElementById("examples") as HTMLSelectElement | null;
if (exampleSelect) {
  EXAMPLES.forEach((ex) => {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.name;
    exampleSelect.appendChild(opt);
  });
  exampleSelect.addEventListener("change", () => {
    const target = EXAMPLES.find((ex) => ex.id === exampleSelect.value);
    if (target) {
      state.replaceScore(JSON.parse(JSON.stringify(target.score)));
      exampleSelect.value = "";
    }
  });
}

refresh();
