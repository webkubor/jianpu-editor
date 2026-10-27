/** 逐图转录工作稿；未加入正式曲库。疑点未清零前不得标为已校对全谱。 */
import { compileLine } from "./dsl.ts";
import { createScore } from "./model.ts";
import { page1Rows } from "./mumin-page1.ts";
import { page2Rows } from "./mumin-page2.ts";
import { page3Rows } from "./mumin-page3.ts";
import { page4Rows } from "./mumin-page4.ts";
import { annotateMuminSpans } from "./mumin-spans.ts";
import { attachMuminCues } from "./mumin-cues.ts";

export function createMuminDraft() {
  const pages = [page1Rows, page2Rows, page3Rows, page4Rows];
  const review: { page: number; row: number; uncertainties: string[] }[] = [];
  const score = createScore({
    title: "牧民新歌 · 逐页校对工作稿（未定稿）",
    tone: "A", beat: [4, 4], speed: 76,
    authors: ["简广易 曲", "E调笛·全按作低音2", "速度仅供校对试听"],
  });
  let activeMeter: [number, number] = [4, 4];
  score.paragraphs = pages.flatMap((rows, pageIndex) => rows.map(row => {
    const para = compileLine(row.dsl);
    const heading = `对照图${pageIndex + 1}·第${row.sourceRow}行${row.heading ? ` · ${row.heading}` : ""}`;
    para.heading = heading;
    if ("freeTime" in row) para.freeTime = row.freeTime;
    if (row.meter) {
      activeMeter = typeof row.meter === "string"
        ? row.meter.split("/").map(Number) as [number, number]
        : row.meter;
    }
    para.meter = [...activeMeter];
    para.spans = annotateMuminSpans(pageIndex + 1, row.sourceRow, para);
    attachMuminCues(pageIndex + 1, row.sourceRow, para);
    // 原图明确的段首力度；局部力度在逐音记录中继续核对。
    const dynamic = pageIndex === 0 && row.sourceRow === 1 ? "pp" :
      pageIndex === 0 && row.sourceRow === 5 && !para.freeTime ? "mf" :
      pageIndex === 1 && row.sourceRow === 5 ? "mf" :
      pageIndex === 2 && row.sourceRow === 1 ? "f" :
      pageIndex === 2 && (row.sourceRow === 2 || row.sourceRow === 3) ? "mp" : undefined;
    if (dynamic && para.notations[0]) para.notations[0].dynamic = dynamic;
    review.push({ page: pageIndex + 1, row: row.sourceRow, uncertainties: row.uncertainties });
    return para;
  }));
  return { score, review };
}
