import { describe, expect, it } from 'vitest';
import { factKey } from '../src/core/facts';
import { newFactProgress, reviewDelayMs } from '../src/core/memory';
import type { FactProgress } from '../src/core/types';
import {
  newChoosePracticeFact,
  runDays,
  shareOfTable,
  unseenKeys,
} from './helpers/simulate';

const NOW = 1_784_000_000_000;
const HOUR = 60 * 60 * 1000;

/** Four tables of established-but-varied memory plus one just-added table. */
function dannyLikeState(): { tables: number[]; facts: Record<string, FactProgress> } {
  const facts: Record<string, FactProgress> = {};
  const established = [2, 3, 5, 10];
  established.forEach((table, tableIndex) => {
    for (let multiplier = 1; multiplier <= 12; multiplier += 1) {
      const index = tableIndex * 12 + multiplier;
      const stabilityHours = 24 * (1 + (index % 5) * 2);
      const lastCorrectAt = NOW - (6 + ((index * 7) % 96)) * HOUR;
      const mistakes = index % 6 === 0 ? 2 : index % 4 === 0 ? 1 : 0;
      facts[factKey(multiplier, table)] = {
        ...newFactProgress(factKey(multiplier, table), multiplier, table),
        attempts: 6 + mistakes,
        independentCorrect: 6,
        mistakes,
        currentStreak: mistakes ? 1 : 4,
        stabilityHours,
        lastReviewedAt: lastCorrectAt,
        lastCorrectAt,
        lastWrongAt: mistakes ? lastCorrectAt - 30 * HOUR : null,
        nextReviewAt: lastCorrectAt + reviewDelayMs(stabilityHours),
        averageResponseMs: 3500,
      };
    }
  });
  return { tables: [...established, 4], facts };
}

describe('scheduler simulation', () => {
  const days = 6;
  const seeds = [11, 29, 47];

  it('keeps sessions varied and introduces a newly added table quickly', () => {
    for (const seed of seeds) {
      const { tables, facts } = dannyLikeState();
      const result = runDays(newChoosePracticeFact, tables, facts, NOW, seed, days);

      // Repeats from missed facts are legitimate (spaced retries), so the
      // floor sits below the no-mistake ideal; cleanRepeats below is the
      // actual repetitiveness signal.
      const meanDistinct = result.sessions.reduce((sum, s) => sum + s.distinct, 0) / days;
      expect(meanDistinct).toBeGreaterThanOrEqual(12);

      for (const session of result.sessions) {
        // A stubborn fact missed several times may be retried up to 4 asks;
        // facts answered correctly must not churn.
        expect(session.maxRepeats).toBeLessThanOrEqual(4);
        expect(session.cleanRepeats).toBeLessThanOrEqual(4);
      }

      const afterThree = runDays(newChoosePracticeFact, tables, facts, NOW, seed, 3);
      expect(unseenKeys([4], afterThree.facts)).toHaveLength(0);

      expect(shareOfTable(result.sessions, 4)).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('never repeats a fact within eight questions unless it is a retry', () => {
    for (const seed of seeds) {
      const { tables, facts } = dannyLikeState();
      const result = runDays(newChoosePracticeFact, tables, facts, NOW, seed, days);
      for (const session of result.sessions) {
        session.asked.forEach((item, index) => {
          if (item.reason === 'retry') return;
          const windowKeys = session.asked.slice(Math.max(0, index - 8), index).map((entry) => entry.key);
          expect(windowKeys).not.toContain(item.key);
        });
      }
    }
  });

  it('covers every selected fact from a fresh start within nine sessions', () => {
    for (const seed of seeds) {
      const tables = [2, 5, 10];
      const afterSeven = runDays(newChoosePracticeFact, tables, {}, NOW, seed, 7);
      expect(unseenKeys(tables, afterSeven.facts).length).toBeLessThanOrEqual(6);
      const result = runDays(newChoosePracticeFact, tables, {}, NOW, seed, 9);
      expect(unseenKeys(tables, result.facts)).toHaveLength(0);
    }
  });
});
