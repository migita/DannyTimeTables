import { parseFactKey } from './facts';
import type {
  ActiveSession,
  FactKey,
  QuestionKind,
  RetryItem,
  TestConfig,
  TestResult,
} from './types';

export function requiredCorrect(config: Pick<TestConfig, 'questionCount' | 'passMode' | 'passValue'>): number {
  if (config.passMode === 'percent') {
    return Math.ceil(config.questionCount * config.passValue / 100);
  }
  return Math.min(config.questionCount, Math.max(0, Math.round(config.passValue)));
}

export interface PresentedQuestion {
  kind: QuestionKind;
  left: number;
  right: number;
  operator: '×' | '÷';
  answer: number;
}

export function presentQuestion(factorA: number, factorB: number, asDivision: boolean): PresentedQuestion {
  if (asDivision) {
    return { kind: 'division', left: factorA * factorB, right: factorB, operator: '÷', answer: factorA };
  }
  return { kind: 'multiplication', left: factorA, right: factorB, operator: '×', answer: factorA * factorB };
}

/**
 * Warm-up facts come straight back as the session's first retries, so what
 * was just taught is answered independently while it is fresh.
 */
export function warmUpRetries(warmUp: FactKey[]): RetryItem[] {
  return warmUp.map((factKey, index) => ({ factKey, dueAfter: 1 + index * 2 }));
}

export function sessionResult(
  session: ActiveSession,
  status: 'abandoned' | null,
  now = Date.now(),
): TestResult {
  return {
    id: session.id,
    presetName: null,
    config: session.config,
    startedAt: session.startedAt,
    finishedAt: now,
    status: status ?? (session.correct >= requiredCorrect(session.config) ? 'passed' : 'failed'),
    correct: session.correct,
    answered: session.answered,
    answers: session.records.map((record) => ({
      questionId: record.id,
      answer: record.given,
      correct: record.correct,
      responseMs: record.responseMs,
    })),
    questions: session.records.map((record) => ({
      id: record.id,
      kind: record.kind,
      left: record.left,
      right: record.right,
      operator: record.operator,
      answer: record.answer,
      factKey: record.factKey,
      table: parseFactKey(record.factKey).factorB,
    })),
  };
}
