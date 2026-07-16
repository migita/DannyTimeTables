import { describe, expect, it } from 'vitest';
import { factKey, factsForTables } from '../src/core/facts';
import { newFactProgress } from '../src/core/memory';
import { choosePracticeFact, pickWarmUpFacts, scheduleRetry } from '../src/core/scheduler';
import type { FactProgress } from '../src/core/types';

const NOW = 1_784_000_000_000;
const HOUR = 60 * 60 * 1000;

function progress(factorA: number, factorB: number, overrides: Partial<FactProgress>): FactProgress {
  return { ...newFactProgress(factKey(factorA, factorB), factorA, factorB), ...overrides };
}

function solidFact(factorA: number, factorB: number, lastCorrectAgoHours: number, stabilityHours = 24 * 14): FactProgress {
  return progress(factorA, factorB, {
    attempts: 8,
    independentCorrect: 8,
    currentStreak: 8,
    stabilityHours,
    lastReviewedAt: NOW - lastCorrectAgoHours * HOUR,
    lastCorrectAt: NOW - lastCorrectAgoHours * HOUR,
    nextReviewAt: NOW - lastCorrectAgoHours * HOUR + stabilityHours * HOUR * 0.25,
  });
}

function factMap(...items: FactProgress[]): Record<string, FactProgress> {
  return Object.fromEntries(items.map((item) => [item.key, item]));
}

describe('practice scheduler', () => {
  it('returns a missed fact only after intervening questions', () => {
    const key = factKey(7, 5);
    const retries = scheduleRetry([], key, 2, () => 0);

    expect(choosePracticeFact({
      tables: [5],
      facts: {},
      recent: [],
      retries,
      answered: 4,
      now: NOW,
      random: () => 0.5,
    }).reason).not.toBe('retry');

    const selected = choosePracticeFact({
      tables: [5],
      facts: {},
      recent: [factKey(2, 5), factKey(3, 5)],
      retries,
      answered: 5,
      now: NOW,
      random: () => 0.5,
    });
    expect(selected.key).toBe(key);
    expect(selected.reason).toBe('retry');
  });

  it('does not immediately repeat the same prompt', () => {
    const recent = factKey(4, 5);
    const selected = choosePracticeFact({
      tables: [5],
      facts: {},
      recent: [recent],
      retries: [],
      answered: 1,
      now: NOW,
      random: () => 0.4,
    });
    expect(selected.key).not.toBe(recent);
  });

  it('prefers a fading fact over facts answered moments ago', () => {
    const fading = solidFact(8, 5, 40, 24);
    const justAnswered = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12].map((multiplier) => solidFact(multiplier, 5, 0.02));
    const chosen = choosePracticeFact({
      tables: [5],
      facts: factMap(fading, ...justAnswered),
      recent: [],
      retries: [],
      answered: 0,
      now: NOW,
      random: () => 0.3,
    });
    expect(chosen.key).toBe(fading.key);
  });

  it('introduces an unseen fact on the drip tick, easiest first', () => {
    const facts = factMap(...factsForTables([2]).map((fact) => solidFact(fact.factorA, fact.factorB, 20)));
    const chosen = choosePracticeFact({
      tables: [2, 4],
      facts,
      recent: [],
      retries: [],
      answered: 3,
      now: NOW,
      random: () => 0.5,
    });
    expect(chosen.reason).toBe('new');
    expect(chosen.key).toBe(factKey(1, 4));
  });

  it('introduces into the least-covered table first', () => {
    const facts = factMap(
      ...[1, 2, 3, 4, 5].map((multiplier) => solidFact(multiplier, 4, 20)),
      ...[1, 2].map((multiplier) => solidFact(multiplier, 3, 20)),
    );
    const chosen = choosePracticeFact({
      tables: [3, 4],
      facts,
      recent: [],
      retries: [],
      answered: 7,
      now: NOW,
      random: () => 0.5,
    });
    expect(chosen.reason).toBe('new');
    expect(chosen.factorB).toBe(3);
    expect(chosen.factorA).toBe(3);
  });

  it('never repeats a fact asked within the last eight questions', () => {
    const all = factsForTables([2, 3]);
    const facts = factMap(...all.map((fact) => solidFact(fact.factorA, fact.factorB, 30, 48)));
    const recent = all.slice(0, 8).map((fact) => fact.key);
    for (let run = 0; run < 60; run += 1) {
      const chosen = choosePracticeFact({
        tables: [2, 3],
        facts,
        recent,
        retries: [],
        answered: recent.length + run,
        now: NOW,
      });
      expect(recent).not.toContain(chosen.key);
    }
  });

  it('warm-up mixes unseen facts with shaky ones and skips secure ones', () => {
    const weak = progress(7, 2, {
      attempts: 6,
      independentCorrect: 3,
      mistakes: 3,
      stabilityHours: 4,
      lastReviewedAt: NOW - 20 * HOUR,
      lastCorrectAt: NOW - 20 * HOUR,
      lastWrongAt: NOW - 20 * HOUR,
      nextReviewAt: NOW - 12 * HOUR,
    });
    const facts = factMap(
      weak,
      ...[1, 2, 3, 4, 5].map((multiplier) => solidFact(multiplier, 2, 2)),
    );
    const picks = pickWarmUpFacts([2], facts, 3, NOW);
    expect(picks).toHaveLength(3);
    expect(picks.map((fact) => fact.key)).toContain(weak.key);
    expect(picks.some((fact) => !facts[fact.key])).toBe(true);
    expect(picks.filter((fact) => facts[fact.key] && fact.key !== weak.key)).toHaveLength(0);
  });

  it('warm-up returns nothing when every fact is secure', () => {
    const facts = factMap(...factsForTables([2]).map((fact) => solidFact(fact.factorA, fact.factorB, 2)));
    expect(pickWarmUpFacts([2], facts, 3, NOW)).toHaveLength(0);
  });
});
