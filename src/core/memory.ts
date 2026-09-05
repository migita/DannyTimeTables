import type { AttemptSource, FactKey, FactProgress, MemoryLabel, QuestionKind } from './types';

const HOUR_MS = 60 * 60 * 1000;
const TARGET_RECALL = 0.78;
export const RETENTION_GAP_HOURS = 20;

export interface RecordAnswerInput {
  correct: boolean;
  independent: boolean;
  responseMs: number;
  sessionId: string;
  source: AttemptSource;
  timedOut?: boolean;
  now?: number;
}

export function newFactProgress(key: FactKey, factorA: number, factorB: number): FactProgress {
  return {
    key, factorA, factorB, attempts: 0, independentCorrect: 0, mistakes: 0,
    currentStreak: 0, stabilityHours: 0, difficulty: 0.45,
    lastReviewedAt: null, lastCorrectAt: null, lastWrongAt: null, nextReviewAt: null,
    averageResponseMs: null, correctSessionIds: [], recentAttempts: [],
    independentAttempts: 0, timeouts: 0, retentionChecks: [],
  };
}

export function operationProgress(progress: FactProgress | undefined, kind: QuestionKind): FactProgress | undefined {
  return kind === 'division' ? progress?.division : progress;
}

/** A scheduling heuristic, not a calibrated probability of a child's answer. */
export function recallProbability(progress: FactProgress | undefined, now = Date.now()): number {
  if (!progress || progress.lastCorrectAt === null || progress.stabilityHours <= 0) return 0;
  return Math.exp(-Math.max(0, now - progress.lastCorrectAt) / HOUR_MS / progress.stabilityHours);
}

export function independentAttemptCount(progress: FactProgress): number {
  return progress.independentAttempts ?? progress.independentCorrect + progress.mistakes + (progress.timeouts ?? 0);
}

export function recordAnswer(progress: FactProgress, input: RecordAnswerInput): FactProgress {
  const now = input.now ?? Date.now();
  // Any exposure, including a guided correction, restarts the retention gap.
  const previousExposure = progress.lastExposedAt === undefined ? progress.lastReviewedAt
    : Math.max(progress.lastReviewedAt ?? 0, progress.lastExposedAt);
  const gapHours = previousExposure === null ? 0 : Math.max(0, now - previousExposure) / HOUR_MS;
  const delayed = input.independent && input.correct && !input.timedOut && gapHours >= RETENTION_GAP_HOURS;
  const recentAttempts = [...progress.recentAttempts, {
    at: now, correct: input.correct, independent: input.independent,
    responseMs: input.responseMs, sessionId: input.sessionId, source: input.source,
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(delayed ? { delayedHours: gapHours } : {}),
  }].slice(-24);
  const base = { ...progress, attempts: progress.attempts + 1, lastReviewedAt: now, recentAttempts };
  if (!input.independent) return { ...base, ...(input.correct ? { lastTaughtAt: now } : {}) };

  const independentAttempts = independentAttemptCount(progress) + 1;
  if (input.timedOut) {
    // A deadline measures speed and input as well as recall. Do not label it a wrong fact.
    return { ...base, independentAttempts, timeouts: (progress.timeouts ?? 0) + 1,
      currentStreak: 0, nextReviewAt: now + 15 * 60 * 1000 };
  }
  if (!input.correct) {
    const stabilityHours = Math.max(0.25, progress.stabilityHours * 0.35);
    return { ...base, independentAttempts, mistakes: progress.mistakes + 1,
      currentStreak: 0, stabilityHours, difficulty: Math.min(1, progress.difficulty + 0.12),
      lastWrongAt: now, nextReviewAt: now + reviewDelayMs(stabilityHours) };
  }

  const beforeRecall = recallProbability(progress, now);
  // Same-day repeats help acquisition but cannot compound into weeks of inferred retention.
  const growth = 1.45 + (1 - beforeRecall) * 2.8 + (1 - progress.difficulty) * 0.45;
  const stabilityHours = progress.independentCorrect === 0 ? 6
    : delayed ? Math.min(24 * 365, Math.max(6, progress.stabilityHours * growth))
      : Math.max(6, progress.stabilityHours);
  const retentionChecks = delayed
    ? [...(progress.retentionChecks ?? []), { at: now, gapHours }].slice(-24)
    : progress.retentionChecks ?? [];
  const correctSessionIds = progress.correctSessionIds.includes(input.sessionId)
    ? progress.correctSessionIds : [...progress.correctSessionIds, input.sessionId].slice(-12);
  const averageResponseMs = progress.averageResponseMs === null ? input.responseMs
    : Math.round(progress.averageResponseMs * 0.72 + input.responseMs * 0.28);
  return {
    ...base, independentAttempts, independentCorrect: progress.independentCorrect + 1,
    currentStreak: progress.currentStreak + 1, stabilityHours,
    difficulty: Math.max(0, progress.difficulty - 0.04 + (input.responseMs > 7000 ? 0.025 : 0)),
    lastCorrectAt: now, nextReviewAt: now + reviewDelayMs(stabilityHours),
    averageResponseMs, correctSessionIds, retentionChecks,
  };
}

export function validRetentionChecks(progress: FactProgress): Array<{ at: number; gapHours: number }> {
  return (progress.retentionChecks ?? []).filter(check => check.at > (progress.lastWrongAt ?? 0));
}

export function memoryLabel(progress: FactProgress | undefined, now = Date.now()): MemoryLabel {
  if (!progress || progress.attempts === 0) return 'New';
  if (progress.independentCorrect === 0) return 'Learning';
  const checks = validRetentionChecks(progress);
  const fresh = progress.lastCorrectAt !== null && now - progress.lastCorrectAt <= 14 * 24 * HOUR_MS;
  if (!fresh || checks.length === 0) return 'Learning';
  const first = checks[0];
  const last = checks.at(-1)!;
  if (checks.length >= 3 && last.at - first.at >= 5 * 24 * HOUR_MS && checks.some(c => c.gapHours >= 72)) return 'Secure';
  if (progress.averageResponseMs !== null && progress.averageResponseMs <= 3500 && progress.currentStreak >= 3) return 'Fast';
  return 'Remembering';
}

export function retentionDescription(progress: FactProgress | undefined): string {
  if (!progress?.independentCorrect) return 'Still learning';
  const checks = validRetentionChecks(progress);
  if (!checks.length) return 'Needs a check on a later day';
  const longest = Math.max(...checks.map(check => check.gapHours));
  const days = Math.max(1, Math.floor(longest / 24));
  return `Remembered after ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function readyForSpeed(progress: FactProgress | undefined): boolean {
  return !!progress && progress.independentCorrect >= 3 && progress.currentStreak >= 3;
}

export function reviewDelayMs(stabilityHours: number): number {
  return Math.max(15 * 60 * 1000, -Math.log(TARGET_RECALL) * stabilityHours * HOUR_MS);
}

export function weaknessScore(progress: FactProgress | undefined, now = Date.now()): number {
  if (!progress) return 1;
  const count = independentAttemptCount(progress);
  const lapseRate = count === 0 ? 0 : progress.mistakes / count;
  const slow = progress.averageResponseMs === null ? 0 : Math.min(1, progress.averageResponseMs / 9000);
  return (1 - recallProbability(progress, now)) * 0.55 + lapseRate * 0.3 + slow * 0.15;
}
