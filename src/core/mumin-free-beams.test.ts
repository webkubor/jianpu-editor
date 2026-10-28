/** 主图散板双通线回归：限定连音组、隔离相邻旧组，并保持音符及拍数校验。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLine } from "./dsl.ts";
import { createMuminDraft } from "./mumin-draft.ts";
import { page1Rows } from "./mumin-page1.ts";
import { annotateMuminSpans } from "./mumin-spans.ts";
import { serializeScore, deserializeScore } from "./serialize.ts";
import { measureBeats, validateScore } from "./validate.ts";

for (const [sourceRow, start, end] of [[2, 0, 6], [3, 16, 23]]) {
  test(`page 1 row ${sourceRow} has one fresh double beam with isolated outside segments`, () => {
    const row = page1Rows.find(row => row.sourceRow === sourceRow)!;
    const original = compileLine(row.dsl);
    const { score, review } = createMuminDraft();
    const index = review.findIndex(row => row.page === 1 && row.row === sourceRow);
    const para = score.paragraphs[index];
    const target = para.notations.slice(start, end);
    const group = target[0].beamGroup;
    const oldGroups = new Set(original.notations.slice(start, end).map(n => n.beamGroup));
    const maxOld = Math.max(...original.notations.map(n => n.beamGroup ?? 0));
    assert.ok(group !== undefined && group > maxOld, "override uses a fresh group id");
    assert.ok(target.every(n => n.beamGroup === group && n.underline === 2));
    para.notations.forEach((n, i) => {
      if (i >= start && i < end) return;
      assert.notEqual(n.beamGroup, group, `outside index ${i} cannot join the target`);
      const old = original.notations[i].beamGroup;
      if (old !== undefined && oldGroups.has(old)) {
        assert.ok(n.beamGroup !== undefined && n.beamGroup > maxOld);
        assert.notEqual(n.beamGroup, old, "outside remnant gets its own fresh id");
      } else assert.equal(n.beamGroup, old, "unrelated beams stay unchanged");
      if (i > end && old !== undefined && old === original.notations[i - 1].beamGroup) {
        assert.equal(n.beamGroup, para.notations[i - 1].beamGroup, "outside segment stays connected");
      }
    });
    const musicalValues = (notes: typeof para.notations) => notes.map(n => ({
      note: n.note, octave: n.octave, dotted: n.dotted, underline: n.underline,
      beatFrac: n.beatFrac, breakUnderline: n.breakUnderline, graceNotes: n.graceNotes,
      prefixAccidentals: n.prefixAccidentals,
    }));
    assert.deepEqual(musicalValues(para.notations), musicalValues(original.notations));
    assert.deepEqual(measureBeats(para), measureBeats(original));
    const localSpans = annotateMuminSpans(1, sourceRow, para);
    assert.deepEqual(para.spans?.slice(0, localSpans.length), localSpans);
    const saved = JSON.parse(serializeScore(score));
    assert.deepEqual(saved.paragraphs[index].notations.map((n: { beamGroup?: number }) => n.beamGroup),
      para.notations.map(n => n.beamGroup));
    const loaded = deserializeScore(serializeScore(score));
    assert.deepEqual(loaded?.paragraphs[index].notations.map(n => n.beamGroup),
      para.notations.map(n => n.beamGroup), "JSON roundtrip preserves visual beam groups");
    const automatic = { ...score, paragraphs: score.paragraphs.map((p, i) => i !== index ? p : {
      ...p, notations: p.notations.map((n, j) => ({ ...n, beamGroup: original.notations[j].beamGroup })),
    }) };
    assert.deepEqual(validateScore(score), validateScore(automatic));
  });

  test(`page 1 row ${sourceRow} skips the override if pitch, octave, or underline guards fail`, () => {
    const row = page1Rows.find(row => row.sourceRow === sourceRow)!;
    const dsl = row.dsl;
    const tokens = dsl.split(" ");
    const token = tokens[start];
    const variants = [token.replace(/^[1-7]/, "4"), token.replace("^", ""), token.replace("/2", "/1")];
    try {
      for (const variant of variants) {
        row.dsl = tokens.map((value, i) => i === start ? variant : value).join(" ");
        const { score, review } = createMuminDraft();
        const para = score.paragraphs[review.findIndex(r => r.page === 1 && r.row === sourceRow)];
        assert.deepEqual(para.notations.map(n => n.beamGroup), compileLine(row.dsl).notations.map(n => n.beamGroup));
      }
    } finally {
      row.dsl = dsl;
    }
  });
}
