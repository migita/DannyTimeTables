import { describe, expect, it } from 'vitest';
import { factKey } from '../src/core/facts';
import { memoryLabel, newFactProgress, recallProbability, recordAnswer } from '../src/core/memory';

const start = Date.UTC(2026, 0, 1, 9);

describe('memory model', () => {
  it('does not turn guided corrections into mastery evidence', () => {
    const initial = newFactProgress(factKey(7, 5), 7, 5);
    const corrected = recordAnswer(initial, {
      correct: true,
      independent: false,
      responseMs: 5000,
      sessionId: 'learn-1',
      source: 'learn',
      now: start,
    });

    expect(corrected.attempts).toBe(1);
    expect(corrected.independentCorrect).toBe(0);
    expect(corrected.stabilityHours).toBe(0);
    expect(memoryLabel(corrected, start)).toBe('Learning');
  });

  it('requires evidence across sessions before a fact can become secure', () => {
    let progress = newFactProgress(factKey(6, 2), 6, 2);
    progress = recordAnswer(progress, {
      correct: true,
      independent: true,
      responseMs: 2200,
      sessionId: 'session-1',
      source: 'practice',
      now: start,
    });

    for (let index = 1; index <= 8; index += 1) {
      progress = recordAnswer(progress, {
        correct: true,
        independent: true,
        responseMs: 1900,
        sessionId: 'session-1',
        source: 'practice',
        now: start + index * 60_000,
      });
    }

    expect(progress.correctSessionIds).toEqual(['session-1']);
    expect(memoryLabel(progress, start + 9 * 60_000)).not.toBe('Secure');

    progress = recordAnswer(progress, {
      correct: true,
      independent: true,
      responseMs: 2100,
      sessionId: 'session-2',
      source: 'practice',
      now: start + 24 * 60 * 60 * 1000,
    });
    progress = recordAnswer(progress, {
      correct: true,
      independent: true,
      responseMs: 2000,
      sessionId: 'session-3',
      source: 'practice',
      now: start + 4 * 24 * 60 * 60 * 1000,
    });

    expect(progress.correctSessionIds).toHaveLength(3);
    expect(memoryLabel(progress, start + 4 * 24 * 60 * 60 * 1000)).not.toBe('Secure');
  });

  it('models decay and reduces stability after a lapse', () => {
    let progress = newFactProgress(factKey(8, 3), 8, 3);
    progress = recordAnswer(progress, {
      correct: true,
      independent: true,
      responseMs: 3000,
      sessionId: 'one',
      source: 'practice',
      now: start,
    });
    const immediateRecall = recallProbability(progress, start);
    const laterRecall = recallProbability(progress, start + 12 * 60 * 60 * 1000);
    const stabilityBefore = progress.stabilityHours;

    progress = recordAnswer(progress, {
      correct: false,
      independent: true,
      responseMs: 8000,
      sessionId: 'two',
      source: 'practice',
      now: start + 12 * 60 * 60 * 1000,
    });

    expect(immediateRecall).toBeCloseTo(1);
    expect(laterRecall).toBeLessThan(immediateRecall);
    expect(progress.stabilityHours).toBeLessThan(stabilityBefore);
    expect(progress.mistakes).toBe(1);
  });
});


it('does not mistake repeated same-day sessions for long-term retention', () => {
  let progress = newFactProgress('7x4', 7, 4);
  for (let index = 0; index < 30; index++) {
    progress = recordAnswer(progress, { correct: true, independent: true, responseMs: 2000,
      sessionId: `session-${index}`, source: 'practice', now: start + index * 60_000 });
  }
  expect(memoryLabel(progress, start + 30 * 60_000)).toBe('Learning');
  expect(progress.retentionChecks).toEqual([]);
  expect(progress.stabilityHours).toBeLessThan(24);
});

it('requires later-day recalls and a multi-day gap, and does not label stale facts fast', () => {
  let progress = newFactProgress('7x4', 7, 4);
  for (const day of [0, 1, 3, 7]) {
    progress = recordAnswer(progress, { correct: true, independent: true, responseMs: 2000,
      sessionId: `day-${day}`, source: 'test', now: start + day * 86400000 });
  }
  expect(memoryLabel(progress, start + 7 * 86400000)).toBe('Secure');
  expect(progress.retentionChecks).toHaveLength(3);
  expect(memoryLabel(progress, start + 365 * 86400000)).toBe('Learning');
});

it('does not count a correct answer after a warm-up as a delayed recall', () => {
  let progress = newFactProgress('7x4', 7, 4);
  progress = recordAnswer(progress, { correct: true, independent: true, responseMs: 2000,
    sessionId: 'first', source: 'practice', now: start });
  progress = recordAnswer(progress, { correct: true, independent: false, responseMs: 2000,
    sessionId: 'second', source: 'learn', now: start + 86400000 });
  progress = recordAnswer(progress, { correct: true, independent: true, responseMs: 2000,
    sessionId: 'second', source: 'practice', now: start + 86460000 });
  expect(progress.retentionChecks).toEqual([]);
});

it('records timeout separately without reducing accuracy or inferred stability', () => {
  let progress = newFactProgress('7x4', 7, 4);
  progress = recordAnswer(progress, { correct: true, independent: true, responseMs: 2000,
    sessionId: 'one', source: 'practice', now: start });
  const timed = recordAnswer(progress, { correct: false, timedOut: true, independent: true,
    responseMs: 3000, sessionId: 'two', source: 'test', now: start + 86400000 });
  expect(timed.mistakes).toBe(0);
  expect(timed.timeouts).toBe(1);
  expect(timed.stabilityHours).toBe(progress.stabilityHours);
  expect(timed.averageResponseMs).toBe(2000);
});
