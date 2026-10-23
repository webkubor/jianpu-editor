/**
 * 乐谱序列化：JSON 保存/加载
 * 路由：编辑器「保存/打开」入口
 */

import type { Notation, Paragraph, Score } from "./model.ts";

const SCHEMA = "jianpu-editor.score";
const VERSION = 1;

/** 序列化为 JSON 字符串 */
export function serializeScore(score: Score): string {
  return JSON.stringify({ ...score, schema: SCHEMA, version: VERSION });
}

/** 从 JSON 反序列化；带最小结构校验，非法返回 null */
export function deserializeScore(json: string): Score | null {
  try {
    const d = JSON.parse(json);
    if (d.schema !== SCHEMA || !Array.isArray(d.paragraphs)) return null;
    const score: Score = {
      version: VERSION,
      title: String(d.title ?? "无标题"),
      tone: String(d.tone ?? "C"),
      beat: Array.isArray(d.beat) && d.beat.length === 2 ? [Number(d.beat[0]), Number(d.beat[1])] : [4, 4],
      speed: Number(d.speed) || 75,
      authors: Array.isArray(d.authors) ? d.authors.map(String) : [],
      paragraphs: d.paragraphs.map((p: Partial<Paragraph>) => ({
        key: String(p.key ?? `p_${Math.random()}`),
        alignJustify: Boolean(p.alignJustify ?? true),
        lyrics: Array.isArray(p.lyrics) ? p.lyrics.map(String) : [],
        notations: (p.notations ?? []).map((n: Partial<Notation>) => ({
          key: String(n.key ?? `n_${Math.random()}`),
          note: String(n.note ?? "1"),
          octave: Number(n.octave) || 0,
          dotted: Boolean(n.dotted),
          underline: Number(n.underline) || 0,
          breakUnderline: Boolean(n.breakUnderline),
          prefixAccidentals: Array.isArray(n.prefixAccidentals) ? n.prefixAccidentals : [],
          topDecorators: Array.isArray(n.topDecorators) ? n.topDecorators : [],
          tieTo: n.tieTo ? String(n.tieTo) : null,
          beatFrac: typeof n.beatFrac === "number" && n.beatFrac > 0 ? n.beatFrac : undefined,
        })),
      })),
    };
    return score;
  } catch {
    return null;
  }
}

/** 下载为 .jianpu.json 文件 */
export function downloadScore(score: Score): void {
  const blob = new Blob([serializeScore(score)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${score.title || "无标题"}.jianpu.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** localStorage 自动保存键 */
const LS_KEY = "jianpu-editor:autosave";

/** 写入 localStorage */
export function autosave(score: Score): void {
  try {
    localStorage.setItem(LS_KEY, serializeScore(score));
  } catch {
    // 存储满/隐私模式：静默忽略，保存走显式下载
  }
}

/** 读取 localStorage 自动保存；没有或损坏返回 null */
export function loadAutosave(): Score | null {
  const raw = localStorage.getItem(LS_KEY);
  return raw ? deserializeScore(raw) : null;
}
