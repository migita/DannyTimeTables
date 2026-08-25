import { describe, expect, it } from 'vitest';
import { parseFactKey } from '../src/core/facts';
import {
  presentQuestion,
  requiredCorrect,
  sessionResult,
  timeLimitMs,
  warmUpRetries,
} from '../src/core/session';
import type { ActiveSession, FactKey, SessionRecord } from '../src/core/types';

function record(index: number, factKey: FactKey, given: number | null, responseMs: number): SessionRecord {
  const fact = parseFactKey(factKey);
  return {
    id: `s-${index}`,
    factKey,
    kind: 'multiplication',
    left: fact.factorA,
    right: fact.factorB,
    operator: '×',
    answer: fact.answer,
    given,
    correct: given === fact.answer,
    responseMs,
  };
}

function session(records: SessionRecord[]): ActiveSession {
  return {
    id: 's',
    startedAt: 1_000,
    config: { tables: [2, 5], questionCount: 3, passMode: 'count', passValue: 2, includeDivision: false, timeLimitSeconds: 3 },
    warmUpQueue: [],
    answered: records.length,
    correct: records.filter((item) => item.correct).length,
    introduced: 0,
    recent: [],
    retries: [],
    records,
    fixQueue: null,
  };
}

describe('session rules', () => {
  it('computes the pass bar for counts and percentages', () => {
    expect(requiredCorrect({ questionCount: 20, passMode: 'count', passValue: 18 })).toBe(18);
    expect(requiredCorrect({ questionCount: 20, passMode: 'count', passValue: 25 })).toBe(20);
    expect(requiredCorrect({ questionCount: 30, passMode: 'percent', passValue: 90 })).toBe(27);
    expect(requiredCorrect({ questionCount: 10, passMode: 'percent', passValue: 85 })).toBe(9);
  });

  it('presents a fact as multiplication or as the related division', () => {
    expect(presentQuestion(7, 5, false)).toEqual({ kind: 'multiplication', left: 7, right: 5, operator: '×', answer: 35 });
    expect(presentQuestion(7, 5, true)).toEqual({ kind: 'division', left: 35, right: 5, operator: '÷', answer: 7 });
  });

  it('brings warm-up facts back as the first retries, spaced apart', () => {
    expect(warmUpRetries(['2x5', '3x5'])).toEqual([
      { factKey: '2x5', dueAfter: 1 },
      { factKey: '3x5', dueAfter: 3 },
    ]);
  });

  it('reads the time limit in milliseconds and treats missing or zero as untimed', () => {
    expect(timeLimitMs({ timeLimitSeconds: 3 })).toBe(3000);
    expect(timeLimitMs({ timeLimitSeconds: 0 })).toBe(0);
    expect(timeLimitMs({})).toBe(0);
    expect(timeLimitMs({ timeLimitSeconds: Number.NaN })).toBe(0);
  });

  it('records a timed-out question as a miss with no answer', () => {
    const active = session([
      record(0, '2x5', 10, 1800),
      record(1, '7x5', null, 3000),
      record(2, '3x5', 15, 2100),
    ]);

    const result = sessionResult(active, null, 5_000);
    expect(result.status).toBe('passed');
    expect(result.correct).toBe(2);
    expect(result.answers[1]).toEqual({ questionId: 's-1', answer: null, correct: false, responseMs: 3000 });
    expect(result.questions[1]).toMatchObject({ factKey: '7x5', table: 5, answer: 35 });
    expect(result.config.timeLimitSeconds).toBe(3);
    expect(result.finishedAt).toBe(5_000);
  });

  it('marks a session as failed below the pass bar and as abandoned when stopped early', () => {
    const short = session([record(0, '2x5', 9, 1800), record(1, '3x5', 15, 2100)]);
    expect(sessionResult(short, null).status).toBe('failed');
    expect(sessionResult(short, 'abandoned').status).toBe('abandoned');
  });
});
