/** 按谱图保存印刷形状；术语参照网络符号表，未据此推演演奏音高。 */
import type { Paragraph } from "./model.ts";
export function attachMuminWindMarks(page: number, row: number, para: Paragraph): void {
  const mark = (index: number, note: string, octave: number, kind: "appoggiatura" | "harmonic" | "fingerStrike") => {
    const n = para.notations[index];
    if (n?.note === note && n.octave === octave) n.technique = { ...n.technique, [kind]: true };
  };
  if (page === 1 && row === 1) mark(10, "3", 0, "appoggiatura");
  if (page === 1 && row === 2) mark(7, "5", 0, "appoggiatura");
  if (page === 1 && row === 3) mark(6, "2", 1, "harmonic");
  if (page === 1 && row === 6) mark(19, "3", 0, "appoggiatura");
  if (page === 1 && row === 8) {
    mark(16, "5", -1, "fingerStrike");
    mark(17, "6", -1, "appoggiatura");
  }
  if (page === 3 && row === 3) mark(9, "3", 0, "appoggiatura");
}
