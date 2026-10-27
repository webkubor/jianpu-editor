/**
 * 《牧民新歌》逐图确认的视觉跨度；在 compileLine 后以主音索引绑定稳定 key。
 * 证据：mumin1.png / mumin4.png 为主，mumin-edition2-page1.png / page2.png 对照。
 * 两版均为转载制谱，非认证原稿；仅补弧线、发夹、tr 延续线及连音组标签，不改音符或时值。
 */
import type { MusicSpan, Paragraph } from "./model.ts";

/** 按原图页码、主谱系统号添加可定位的跨音标注。 */
export function annotateMuminSpans(page: number, sourceRow: number, para: Paragraph): MusicSpan[] {
  const spans: MusicSpan[] = [];
  const add = (kind: MusicSpan["kind"], start: number, end: number, label?: string) => {
    if (!para.notations[start] || !para.notations[end]) return;
    spans.push({ kind, startKey: para.notations[start].key, endKey: para.notations[end].key, ...(label ? { label } : {}) });
  };
  const tuplet = (start: number, notes: string, label: string) => {
    // notes 只核对编译后的主音；graceNotes 内的小字不占索引，也不计入组数。
    // 顺序不符时不把旧位置的括号错误地套到后来改写的旋律上。
    const end = start + notes.length - 1;
    if (para.notations.slice(start, end + 1).map(n => n.note).join("") === notes) {
      add("tuplet", start, end, label);
    }
  };
  if (page === 1 && sourceRow === 1) {
    // 两版开头长弧终点均为第一个中音3；下方渐强楔形与该长弧同区间。
    const end = para.notations.findIndex(n => n.note === "3" && n.octave === 0);
    if (end > 0) { add("slur", 0, end); add("crescendo", 0, end); }
    const sixth = para.notations.findIndex((n, i) => i > end && n.note === "6" && n.octave === 0);
    if (sixth >= 0) add("slur", sixth, sixth + 2);
    // 主图右端低6至末尾附点低6的长弧、渐强；对照版在下一系统前换行。
    add("slur", 20, 24);
    add("crescendo", 20, 24);
    // 两版均可辨 6.56 上方短弧；不将不同音高连成音值 tie。
    add("slur", 15, 17);
  }
  if (page === 1 && sourceRow === 2) {
    // 主图本系统从左到右标6、3、9、5；对照版把首个6移到第一系统末。
    tuplet(0, "165665", "6");
    tuplet(6, "353", "3");
    tuplet(23, "356165653", "9");
    tuplet(32, "33333", "5");
    // 主图首个高1至第二组倚音3的末音3，长弧在换气号前明确结束。
    add("slur", 0, 22);
    // 右半长弧跨到下一系统的21222；段落内不能表达跨行终点，暂不截短代替。
  }
  if (page === 1 && sourceRow === 3) {
    // 中段七个带前倚音的高2中，仅第4至第6个主音上有3括号；小字1不计数。
    tuplet(11, "222", "3");
    tuplet(16, "3232727", "7");
    tuplet(23, "676567656", "9");
    // 两版均见开头后两个2的短弧与tr；主图渐弱从带波音的2至延音线。
    add("slur", 3, 4);
    add("trill", 3, 4);
    add("diminuendo", 2, 5);
    // 高2倚音群的长弧覆盖七个主音；渐强从第2个主音延至末尾延音线。
    add("slur", 8, 14);
    add("crescendo", 9, 15);
    // 末段7/9组上方另一条长弧跨入第四系统；不推定段落内替代终点。
  }
  if (page === 1 && sourceRow === 4) {
    // 首个6括号只覆盖主音♭757575，排除前一个5的微型倚音♭757。
    tuplet(4, "757575", "6");
    // 主图5括号在主音5至6之间，3是第2个5的前倚音，不另占主音位置。
    // 既有转录将6.后的♭7列为主音，其身份仍待核；此处只绑定现有锚点，不改节奏。
    tuplet(15, "55676", "5");
    tuplet(20, "5356765", "7");
    tuplet(29, "62365", "5");
    // 主图左部长弧从第3个5至六连音后单独的5；中部长弧从带倚音3的5至低6。
    // 对照版同样可见；小字6567属于终点低6的倚音，不作为独立锚点。
    add("slur", 2, 10);
    add("slur", 11, 27);
    // 最右长弧延续第五系统，不能在此把它误标为只覆盖末尾五连音。
  }
  if (page === 1 && sourceRow === 5 && para.freeTime) {
    // 主图引子尾声的楔形由主音1下方收向低5；慢板同号系统不能套用。
    add("diminuendo", 2, 3);
  }
  if (page === 2 && [5, 6, 7, 8, 9].includes(sourceRow)) {
    const bars: number[][] = [[]];
    para.notations.forEach((note, index) => {
      if (["│", "‖", "||:", ":||"].includes(note.note)) bars.push([]);
      else bars[bars.length - 1].push(index);
    });
    const link = (fromBar: number, fromNote: number, toBar: number, toNote: number) => {
      const from = bars[fromBar]?.[fromNote], to = bars[toBar]?.[toNote];
      if (from !== undefined && to !== undefined) add("slur", from, to);
    };
    // 原四页版第二页：自豪地3、6、7、9行中明确的跨小节长音弧。
    if (sourceRow === 5) { link(2, 0, 3, 0); link(4, 0, 4, 1); }
    if (sourceRow === 6 || sourceRow === 7 || sourceRow === 9) link(0, 0, 1, 0);
    if (sourceRow === 8) link(0, 0, 1, 1);
  }
  if (page === 4 && sourceRow === 2) {
    // 主图第四页第2系统、对照版第2页倒数第2系统：23→5、35→6、5→6、6→高2。
    add("slur", 12, 15);
    add("slur", 17, 20);
    add("slur", 21, 22);
    add("slur", 26, 28);
  }
  if (page === 4 && sourceRow === 3) {
    const starts = [0];
    para.notations.forEach((n, index) => { if (["│", "‖", "||:", ":||"].includes(n.note)) starts.push(index + 1); });
    // 两版末系统均见第2小节高2至高1短弧。
    add("slur", 4, 5);
    // 两版原速tr波浪线均从第4小节首6延至第6小节首6附近；弧线分别覆盖长音组。
    if (starts.length >= 6) {
      add("trill", starts[3], starts[5]);
      add("slur", starts[3], starts[4] - 2);
      add("slur", starts[4], starts[5]);
    }
  }
  return spans;
}
