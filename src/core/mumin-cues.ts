/** 原图括号提示单独保留，与主音在共同时间线对齐，不补造主音休止。 */
import { compileLine } from "./dsl.ts";
import type { Paragraph } from "./model.ts";

export function attachMuminCues(page: number, row: number, para: Paragraph): void {
  const add = (label: string, startBeat: number, dsl: string, timelineBeats: number, resumeIndex?: number) => {
    para.cueLayers = [{ label, startBeat, notations: compileLine(dsl).notations, timelineBeats,
      ...(resumeIndex !== undefined ? { resumeKey: para.notations[resumeIndex]?.key } : {}) }];
  };
  if (page === 2 && row === 2) {
    // 首个主音6是八分；括号从同小节第半拍起，随后三小节继续。
    para.notations[0].beatFrac = 0.5;
    para.notations[0].underline = 1;
    add("括号提示·起于首小节半拍；声部角色待核", 0.5,
      "6,:0.25/2 6,:0.25/2 6,:0.5/1 6,:0.5/1 | 3:0.5/1 6,:0.5/1 1:0.5/1 6,:0.5/1 | 6,:0.5/1 6,:0.25/2 6,:0.25/2 6,:0.5/1 6,:0.5/1 | 3:0.5/1 6,:0.5/1 1:0.5/1 6,:0.5/1 |", 8, para.notations.findIndex((n, i) => i > 0 && /^[1-7]$/.test(n.note)));
  }
  if (page === 2 && row === 9) {
    add("括号提示·低5低6与前段长音重叠，后续六小节", 3,
      "5,:0.5/1 6,:0.5/1 | 1.:1/0 2:0.5/1 | 3:1/0 5:1/0 | 6:1/0 5:0.5/1 1^:0.5/1 | 6:0.5/1 5:0.5/1 3:1/0 | 5.:1/0 3:0.5/1 | 2:1/0 1:0.5/1 2:0.5/1 |", 16);
  }
  if (page === 3 && row === 5) {
    add("更热烈地·括号提示35与前段长音重叠，后续四小节", 3,
      "3,:0.5/1 5,:0.5/1 | 6,:0.5/1 6,:0.25/2 6,:0.25/2 6,:0.5/1 6,:0.5/1 | 3:0.5/1 6,:0.5/1 1:0.5/1 6,:0.5/1 | 6,:0.5/1 6,:0.25/2 6,:0.25/2 6,:0.5/1 6,:0.5/1 | 3:0.5/1 6,:0.5/1 1:0.5/1 6,:0.5/1 |", 12, para.notations.findIndex(n => n.note === "3"));
  }
  if (page === 3 && row === 9) {
    add("模仿马叫·上方四小节提示与下方长音并行", 0,
      "5,:0.25/2 5,:0.25/2 6,:0.25/2 6,:0.25/2 1:0.25/2 1:0.25/2 2:0.25/2 2:0.25/2 | 3:0.25/2 3:0.25/2 2:0.25/2 2:0.25/2 3:0.25/2 3:0.25/2 5:0.25/2 5:0.25/2 | 6:0.25/2 6:0.25/2 5:0.25/2 5:0.25/2 3:0.25/2 3:0.25/2 5:0.25/2 5:0.25/2 | 6:0.25/2 6:0.25/2 5:0.25/2 5:0.25/2 6:0.25/2 6:0.25/2 1^:0.25/2 1^:0.25/2 |", 8);
  }
}
