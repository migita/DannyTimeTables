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
    expect(progress.stabilityHours).toBeGreaterThan(24 * 7);
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
