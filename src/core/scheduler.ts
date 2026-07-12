import { factsForTables, parseFactKey, sameFamily } from './facts';
import { recallProbability } from './memory';
import type { FactKey, FactProgress, RetryItem } from './types';

export interface SchedulerInput {
  tables: number[];
  facts: Record<string, FactProgress>;
  recent: FactKey[];
  retries: RetryItem[];
  answered: number;
  now?: number;
  random?: () => number;
}

export interface ScheduledFact {
  key: FactKey;
  factorA: number;
  factorB: number;
  reason: 'retry' | 'new' | 'fading' | 'weak' | 'check';
}

export function choosePracticeFact(input: SchedulerInput): ScheduledFact {
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const candidates = factsForTables(input.tables);
  const recent = input.recent.slice(-3);
  const retry = input.retries
    .filter((item) => item.dueAfter <= input.answered && !recent.slice(-2).includes(item.factKey))
    .sort((a, b) => a.dueAfter - b.dueAfter)[0];

  if (retry) {
    const fact = parseFactKey(retry.factKey);
    return { ...fact, reason: 'retry' };
  }

  const scored = candidates.map((candidate) => {
    const progress = input.facts[candidate.key];
    const recall = recallProbability(progress, now);
    const isNew = !progress || progress.independentCorrect === 0;
    const lapseRate = progress && progress.attempts > 0 ? progress.mistakes / progress.attempts : 0;
    const overdue = progress?.nextReviewAt ? Math.max(0, (now - progress.nextReviewAt) / (24 * 60 * 60 * 1000)) : 0;
    const usefulDifficulty = 1 - Math.min(1, Math.abs(recall - 0.72) / 0.72);
    let score = 0.7 + usefulDifficulty * 2.4 + lapseRate * 2.2 + Math.min(2, overdue) + random() * 0.45;

    if (isNew) score += input.answered % 5 === 0 ? 2.4 : 0.35;
    if (progress?.lastWrongAt && now - progress.lastWrongAt < 7 * 24 * 60 * 60 * 1000) score += 1.3;
    if (recent.includes(candidate.key)) score *= 0.02;
    if (recent.at(-1) && sameFamily(candidate.key, recent.at(-1)!)) score *= 0.2;
    if (recent.at(-1) && parseFactKey(recent.at(-1)!).factorB === candidate.factorB) score *= 0.68;

    return { candidate, progress, recall, lapseRate, isNew, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const shortlist = scored.slice(0, Math.min(6, scored.length));
  const total = shortlist.reduce((sum, item) => sum + item.score, 0);
  let draw = random() * total;
  const chosen = shortlist.find((item) => {
    draw -= item.score;
    return draw <= 0;
  }) ?? shortlist[0];

  let reason: ScheduledFact['reason'] = 'check';
  if (chosen.isNew) reason = 'new';
  else if (chosen.lapseRate >= 0.25) reason = 'weak';
  else if (chosen.recall < 0.78) reason = 'fading';

  return { ...chosen.candidate, reason };
}

export function scheduleRetry(retries: RetryItem[], factKey: FactKey, answered: number, random = Math.random): RetryItem[] {
  const withoutExisting = retries.filter((item) => item.factKey !== factKey);
  return [
    ...withoutExisting,
    { factKey, dueAfter: answered + 3 + Math.floor(random() * 3) },
  ];
}
