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
import { autosave, deserializeScore, downloadScore, loadAutosave } from "../core/serialize.ts";

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
    case "l":
    case "L": {
      // 歌词：弹出行内输入，回车写入当前符号
      const word = window.prompt("歌词（写入光标左边发声符号；留空清除）", state.currentLyric);
      if (word !== null) state.setLyric(word.trim());
      e.preventDefault();
      break;
    }
    case "Enter": {
      // 播放/停止
      if (player.playing) {
        player.stop();
        clearHighlight();
      } else {
        const score = state.score;
        player.play(compileEvents(score), { onNote: (i, p) => highlightIndex(i, p), onEnd: clearHighlight });
      }
      e.preventDefault();
      break;
    }
    default:
      break;
  }
});

/** 播放高亮：给段落 p 的第 index 个符号加 class */
function highlightIndex(index: number, paragraph: number): void {
  clearHighlight();
  const row = canvas.querySelectorAll(".paragraph")[paragraph];
  row?.querySelectorAll(".glyph")[index]?.classList.add("playing");
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

/** 乐谱 → DSL 反投影：升降号/连音线/歌词全量保留，按 4 单元重排拍分组 */
function toDsl(score: Score): string {
  const lines: string[] = [];
  for (const para of score.paragraphs) {
    let line = "";
    const words: string[] = [];
    let beatCount = 0;
    const tieDone = new Set<string>();
    for (const n of para.notations) {
      if (n.note >= "1" && n.note <= "7") {
        let token = n.prefixAccidentals.join("").replace("♯", "#").replace("♭", "b");
        token += n.note;
        token += "^".repeat(Math.max(0, n.octave));
        token += ",".repeat(Math.max(0, -n.octave));
        token += n.dotted ? "." : "";
        // 连音线（只输出一次，两向 key 去重）
        if (n.tieTo && !tieDone.has(n.key)) {
          token += "~";
          tieDone.add(n.tieTo);
        }
        line += (line ? " " : "") + token;
        beatCount += 1;
        words.push(para.lyrics[words.length] ?? "");
      } else if (n.note === "─") {
        line += (line ? " " : "") + "-";
        beatCount += 1;
        words.push(para.lyrics[words.length] ?? "");
      } else if (n.note === "│" || n.note === "‖") {
        line += (line ? " " : "") + n.note;
        beatCount = 0;
      }
      // 每 4 个时值单元插双空格（拍分组重排）
      if (beatCount === 4) {
        line += "  ";
        beatCount = 0;
      }
    }
    lines.push(line.trim());
    if (words.some((w) => w !== "")) {
      lines.push(`[词:${words.map((w) => (w === "" ? "-" : w)).join(" ")}]`);
    }
  }
  return lines.join("\n");
}

document.getElementById("save")?.addEventListener("click", () => {
  downloadScore(state.score);
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

document.getElementById("play")?.addEventListener("click", () => {
  if (player.playing) {
    player.stop();
    clearHighlight();
  } else {
    player.play(compileEvents(state.score), { onNote: (i, p) => highlightIndex(i, p), onEnd: clearHighlight });
  }
});

refresh();
