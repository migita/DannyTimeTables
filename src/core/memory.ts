import type { AttemptSource, FactKey, FactProgress, MemoryLabel } from './types';

const HOUR_MS = 60 * 60 * 1000;
const TARGET_RECALL = 0.78;

export interface RecordAnswerInput {
  correct: boolean;
  independent: boolean;
  responseMs: number;
  sessionId: string;
  source: AttemptSource;
  now?: number;
}

export function newFactProgress(key: FactKey, factorA: number, factorB: number): FactProgress {
  return {
    key,
    factorA,
    factorB,
    attempts: 0,
    independentCorrect: 0,
    mistakes: 0,
    currentStreak: 0,
    stabilityHours: 0,
    difficulty: 0.45,
    lastReviewedAt: null,
    lastCorrectAt: null,
    lastWrongAt: null,
    nextReviewAt: null,
    averageResponseMs: null,
    correctSessionIds: [],
    recentAttempts: [],
  };
}

export function recallProbability(progress: FactProgress | undefined, now = Date.now()): number {
  if (!progress || progress.lastCorrectAt === null || progress.stabilityHours <= 0) return 0;
  const elapsedHours = Math.max(0, now - progress.lastCorrectAt) / HOUR_MS;
  return Math.exp(-elapsedHours / progress.stabilityHours);
}

export function recordAnswer(progress: FactProgress, input: RecordAnswerInput): FactProgress {
  const now = input.now ?? Date.now();
  const beforeRecall = recallProbability(progress, now);
  const attempts = progress.attempts + 1;
  const recentAttempts = [
    ...progress.recentAttempts,
    {
      at: now,
      correct: input.correct,
      independent: input.independent,
      responseMs: input.responseMs,
      sessionId: input.sessionId,
      source: input.source,
    },
  ].slice(-24);

  if (!input.independent) {
    return {
      ...progress,
      attempts,
      lastReviewedAt: now,
      recentAttempts,
    };
  }

  const averageResponseMs = progress.averageResponseMs === null
    ? input.responseMs
    : Math.round(progress.averageResponseMs * 0.72 + input.responseMs * 0.28);

  if (!input.correct) {
    const stabilityHours = progress.stabilityHours > 0
      ? Math.max(0.25, progress.stabilityHours * 0.35)
      : 0.25;
    return {
      ...progress,
      attempts,
      mistakes: progress.mistakes + 1,
      currentStreak: 0,
      stabilityHours,
      difficulty: Math.min(1, progress.difficulty + 0.12),
      lastReviewedAt: now,
      lastWrongAt: now,
      nextReviewAt: now + reviewDelayMs(stabilityHours),
      averageResponseMs,
      recentAttempts,
    };
  }

  const firstIndependentSuccess = progress.independentCorrect === 0;
  const growth = 1.45 + (1 - beforeRecall) * 2.8 + (1 - progress.difficulty) * 0.45;
  const stabilityHours = firstIndependentSuccess
    ? 6
    : Math.min(24 * 365, Math.max(progress.stabilityHours + 0.5, progress.stabilityHours * growth));
  const correctSessionIds = progress.correctSessionIds.includes(input.sessionId)
    ? progress.correctSessionIds
    : [...progress.correctSessionIds, input.sessionId].slice(-12);
  const slowAdjustment = input.responseMs > 7000 ? 0.025 : 0;

  return {
    ...progress,
    attempts,
    independentCorrect: progress.independentCorrect + 1,
    currentStreak: progress.currentStreak + 1,
    stabilityHours,
    difficulty: Math.max(0, progress.difficulty - 0.04 + slowAdjustment),
    lastReviewedAt: now,
    lastCorrectAt: now,
    nextReviewAt: now + reviewDelayMs(stabilityHours),
    averageResponseMs,
    correctSessionIds,
    recentAttempts,
  };
}

export function memoryLabel(progress: FactProgress | undefined, now = Date.now()): MemoryLabel {
  if (!progress || progress.attempts === 0) return 'New';
  if (progress.independentCorrect === 0) return 'Learning';

  const sessions = progress.correctSessionIds.length;
  const recall = recallProbability(progress, now);
  if (progress.stabilityHours >= 24 * 7 && sessions >= 3 && recall >= 0.72) return 'Secure';
  if (
    progress.averageResponseMs !== null &&
    progress.averageResponseMs <= 3500 &&
    progress.currentStreak >= 3 &&
    sessions >= 2
  ) return 'Fast';
  if (progress.stabilityHours >= 24 && sessions >= 2) return 'Remembering';
  return 'Learning';
}

export function reviewDelayMs(stabilityHours: number): number {
  return Math.max(15 * 60 * 1000, -Math.log(TARGET_RECALL) * stabilityHours * HOUR_MS);
}

export function weaknessScore(progress: FactProgress | undefined, now = Date.now()): number {
  if (!progress) return 1;
  const recall = recallProbability(progress, now);
  const lapseRate = progress.attempts === 0 ? 0 : progress.mistakes / progress.attempts;
  const slow = progress.averageResponseMs === null ? 0 : Math.min(1, progress.averageResponseMs / 9000);
  return (1 - recall) * 0.55 + lapseRate * 0.3 + slow * 0.15;
}
