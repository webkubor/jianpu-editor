/**
 * 简谱编辑器入口：单页应用壳
 * 职责：挂载 SVG 画布、键盘事件路由（数字=音符，空格=延音线，|，Backspace，方向键），
 *       工具栏（转调/速度/DSL/保存/播放），把 core+render+state 三层粘起来。
 */

import { EditorState } from "./editor-state.ts";
import { renderScore } from "../render/svg-render.ts";
import { Player, compileEvents } from "../core/player.ts";
import { compileScore } from "../core/dsl.ts";
import { Score, createScore } from "../core/model.ts";
import { autosave, downloadScore, loadAutosave } from "../core/serialize.ts";

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
const toneSelect = document.getElementById("tone") as HTMLSelectElement;
const speedInput = document.getElementById("speed") as HTMLInputElement;
const dslArea = document.getElementById("dsl") as HTMLTextAreaElement;
const statusEl = document.getElementById("status")!;

/** 当前光标符号 key（渲染高亮用） */
function selectedKey(): string | null {
  return state.currentItem?.key ?? null;
}

/** 渲染 + 自动保存 */
function refresh(): void {
  renderScore(canvas, state.score, selectedKey());
  autosave(state.score);
  toneSelect.value = state.score.tone;
  speedInput.value = String(state.score.speed);
  statusEl.textContent = `${state.score.title} · ${state.score.paragraphs.length} 段 · 光标 段${state.paragraphIndex + 1}/位${state.itemIndex}`;
}
state.subscribe(refresh);

/** 键盘主路由 */
window.addEventListener("keydown", (e) => {
  // 输入框聚焦时不劫持
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;

  if (/^[1-7]$/.test(e.key)) {
    state.insertNote(e.key);
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case " ":
      state.insertExtend();
      e.preventDefault();
      break;
    case "|":
      state.insertBar();
      e.preventDefault();
      break;
    case "Backspace":
      state.backspace();
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
      state.moveParagraph(-1);
      e.preventDefault();
      break;
    case "ArrowDown":
      state.moveParagraph(1);
      e.preventDefault();
      break;
    case "z":
      if (e.metaKey || e.ctrlKey) {
        state.undo();
        e.preventDefault();
      }
      break;
    case "=":
    case "+":
      state.tweakOctave(1);
      e.preventDefault();
      break;
    case "-":
      state.tweakOctave(-1);
      e.preventDefault();
      break;
    case ".":
      state.toggleDotted();
      e.preventDefault();
      break;
    case "Enter": {
      // 播放/停止
      if (player.playing) {
        player.stop();
      } else {
        const score = state.score;
        player.play(compileEvents(score), { onNote: (i) => highlightIndex(i), onEnd: clearHighlight });
      }
      e.preventDefault();
      break;
    }
    default:
      break;
  }
});

/** 播放高亮：给第 index 个发声符号加 class */
function highlightIndex(index: number): void {
  clearHighlight();
  const glyphs = canvas.querySelectorAll(".glyph");
  // 发声符号（音符+延音线）与 glyph 的对应：全部符号都在 glyph 里，需要按发声过滤
  let sounding = -1;
  for (let i = 0; i < state.paragraph.notations.length && state.paragraphIndex < state.score.paragraphs.length; i += 1) {
    const n = state.paragraph.notations[i];
    if (n.note >= "1" && n.note <= "7") sounding += 1;
    if (i === index) break;
  }
  // 简化：直接用 index 找发声音符（V1 只按音符计数）
  const target = glyphs[sounding >= 0 ? sounding : index];
  target?.classList.add("playing");
}

function clearHighlight(): void {
  canvas.querySelectorAll(".playing").forEach((g) => g.classList.remove("playing"));
}

/** 工具栏事件 */
document.getElementById("transpose-up")?.addEventListener("click", () => state.transpose(1));
document.getElementById("transpose-down")?.addEventListener("click", () => state.transpose(-1));

toneSelect.addEventListener("change", () => {
  state.transposeTo(toneSelect.value);
});

speedInput.addEventListener("change", () => {
  const speed = Math.max(20, Math.min(240, Number(speedInput.value) || 72));
  state.replaceScore({ ...state.score, speed });
});

document.getElementById("apply-dsl")?.addEventListener("click", () => {
  try {
    const score = compileScore(dslArea.value, { ...state.score, paragraphs: [] });
    state.replaceScore(score);
  } catch (err) {
    statusEl.textContent = `DSL 错误：${(err as Error).message}`;
  }
});

document.getElementById("export-dsl")?.addEventListener("click", () => {
  dslArea.value = toDsl(state.score);
});

/** 乐谱 → DSL 反投影（V1：按双空格拍推断重排） */
function toDsl(score: Score): string {
  const lines: string[] = [];
  for (const para of score.paragraphs) {
    let line = "";
    let beatCount = 0;
    for (const n of para.notations) {
      if (n.note >= "1" && n.note <= "7") {
        let token = n.note;
        token += "^".repeat(Math.max(0, n.octave));
        token += ",".repeat(Math.max(0, -n.octave));
        token += n.dotted ? "." : "";
        line += (line ? " " : "") + token;
        beatCount += 1;
      } else if (n.note === "─") {
        line += (line ? " " : "") + "-";
        beatCount += 1;
      } else if (n.note === "│" || n.note === "‖") {
        line += n.note;
        beatCount = 0;
      }
      // 每 4 个时值单元插双空格（V1 简化拍分组）
      if (beatCount === 4) {
        line += "  ";
        beatCount = 0;
      }
    }
    lines.push(line.trim());
  }
  return lines.join("\n\n");
}

document.getElementById("save")?.addEventListener("click", () => {
  downloadScore(state.score);
});

document.getElementById("play")?.addEventListener("click", () => {
  if (player.playing) {
    player.stop();
  } else {
    player.play(compileEvents(state.score), { onNote: (i) => highlightIndex(i), onEnd: clearHighlight });
  }
});

refresh();
