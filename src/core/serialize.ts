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
    if (!d || d.schema !== SCHEMA || !Array.isArray(d.paragraphs)) return null;
    if (d.version !== undefined && d.version !== VERSION) return null;
    if (d.speed !== undefined && !(typeof d.speed === "number" && Number.isFinite(d.speed) && d.speed > 0)) return null;
    if (d.beat !== undefined && (!Array.isArray(d.beat) || d.beat.length !== 2 ||
      !d.beat.every((value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0))) return null;
    const keys = new Set<string>();
    for (const paragraph of d.paragraphs) {
      if (!paragraph || !Array.isArray(paragraph.notations)) return null;
      for (const n of paragraph.notations) {
        if (!n || !["0", "1", "2", "3", "4", "5", "6", "7", "─", "│", "‖"].includes(n.note)) return null;
        if (n.key !== undefined) {
          if (typeof n.key !== "string" || !n.key || keys.has(n.key)) return null;
          keys.add(n.key);
        }
        if (n.octave !== undefined && !Number.isSafeInteger(n.octave)) return null;
        if (n.underline !== undefined && (!Number.isSafeInteger(n.underline) || n.underline < 0)) return null;
        if (n.beatFrac !== undefined && !(typeof n.beatFrac === "number" && Number.isFinite(n.beatFrac) && n.beatFrac > 0)) return null;
        if (n.prefixAccidentals !== undefined && (!Array.isArray(n.prefixAccidentals) ||
          !n.prefixAccidentals.every((value: unknown) => value === "♯" || value === "♭"))) return null;
      }
    }
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

/** 文件名净化：去掉路径分隔符与系统保留字符，收尾点空格（Windows 目录陷阱），空名回退无标题 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").replace(/[. ]+$/g, "").trim() || "无标题";
}

/** 下载为 .jianpu.json 文件 */
export function downloadScore(score: Score): void {
  const blob = new Blob([serializeScore(score)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sanitizeFilename(score.title)}.jianpu.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 下载文本/矢量文件（SVG 等导出用） */
export function downloadText(content: string, filename: string, mimeType = "image/svg+xml;charset=utf-8"): void {
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 下载二进制文件（MIDI 导出用） */
export function downloadBinary(data: Uint8Array, filename: string): void {
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: "audio/midi" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
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
