import { describe, expect, it } from 'vitest';
import { factKey } from '../src/core/facts';
import { choosePracticeFact, scheduleRetry } from '../src/core/scheduler';

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
      random: () => 0.5,
    }).reason).not.toBe('retry');

    const selected = choosePracticeFact({
      tables: [5],
      facts: {},
      recent: [factKey(2, 5), factKey(3, 5)],
      retries,
      answered: 5,
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
      random: () => 0.4,
    });
    expect(selected.key).not.toBe(recent);
  });
});
