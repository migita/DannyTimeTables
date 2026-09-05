import { describe, expect, it } from 'vitest';
import { applicationQuestions, makeCheck, strategyLesson } from '../src/core/learning';
import { newFactProgress, recordAnswer } from '../src/core/memory';
import { choosePracticeFact, scheduleRetry } from '../src/core/scheduler';
import { createDefaultData, exportData, importData } from '../src/core/storage';
import { mergePayloads, toPayload } from '../src/core/sync';

const now = 1_784_000_000_000;
function taught(a: number, b: number) {
  return recordAnswer(newFactProgress(`${a}x${b}`, a, b), { correct: true, independent: true,
    responseMs: 2500, sessionId: 'earlier', source: 'practice', now });
}

describe('learning and assessment', () => {
  it('uses an unscored, untimed starting check for a new learner', () => {
    const result = makeCheck([2, 5, 10], {}, 20, true, 3, () => .4);
    expect(result.assessment).toBe('placement');
    expect(result.questions.length).toBeLessThanOrEqual(12);
    expect(result.questions.every(q => q.timeLimitSeconds === 0)).toBe(true);
  });

  it('freezes a balanced check of taught material without introducing unknown division', () => {
    const facts = Object.fromEntries([2, 5].flatMap(b => [1, 2, 3, 4, 6, 7].map(a => [`${a}x${b}`, taught(a, b)])));
    const check = makeCheck([2, 5, 9], facts, 20, true, 3, () => .4);
    expect(check.assessment).toBe('check');
    expect(check.questions).toHaveLength(20);
    expect(check.questions.filter(q => q.table === 2)).toHaveLength(10);
    expect(check.questions.filter(q => q.table === 5)).toHaveLength(10);
    expect(check.questions.every(q => q.kind === 'multiplication' && q.timeLimitSeconds === 0)).toBe(true);
    const snapshot = structuredClone(check);
    facts['7x2'].mistakes += 9;
    expect(check).toEqual(snapshot);
  });

  it('keeps division and multiplication retries distinct', () => {
    let retries = scheduleRetry([], '4x5', 0, () => 0, 'division');
    retries = scheduleRetry(retries, '4x5', 1, () => 0, 'multiplication');
    expect(retries).toHaveLength(2);
    const chosen = choosePracticeFact({ tables: [5], facts: {}, recent: [], retries, answered: 3, now });
    expect(chosen.kind).toBe('division');
  });

  it('teaches four-times facts through an available double and otherwise builds groups', () => {
    const lesson = strategyLesson('7x4', { '7x2': taught(7, 2) });
    expect(lesson.steps.map(s => s.answer)).toEqual([14, 28, 28]);
    expect(lesson.splitAfter).toBe(2);
    expect(strategyLesson('7x4', {}).title).toBe('Build equal groups');
    expect(strategyLesson('7x6', { '7x5': taught(7, 5) }).steps.map(s => s.answer)).toEqual([35, 42, 42]);
  });

  it('asks for a missing factor and a contextual quantity, not only products', () => {
    const puzzles = applicationQuestions(['4x5']);
    expect(puzzles[0].answer).toBe(4);
    expect(puzzles[0].expression).toBe('□ × 5 = 20');
    expect(puzzles[1].answer).toBe(20);
  });

  it('preserves operation-specific progress through backup and independent device merges', () => {
    const a = createDefaultData();
    const b = createDefaultData();
    a.settings.activeTables = [2, 4, 5, 7, 10];
    a.settings.session.warmUpCount = 3;
    a.facts['4x5'] = { ...taught(4, 5), lastReviewedAt: now + 2000 };
    b.facts['4x5'] = { ...taught(4, 5), division: { ...taught(4, 5), lastReviewedAt: now + 1000 } };
    const merged = mergePayloads(toPayload(a), toPayload(b));
    expect(merged.facts['4x5'].lastReviewedAt).toBe(now + 2000);
    expect(merged.facts['4x5'].division?.lastReviewedAt).toBe(now + 1000);
    a.facts = merged.facts;
    const restored = importData(exportData(a));
    expect(restored.settings.activeTables).toEqual([2, 4, 5, 7, 10]);
    expect(restored.settings.session.warmUpCount).toBe(3);
    expect(restored.facts).toEqual(a.facts);
  });
});
