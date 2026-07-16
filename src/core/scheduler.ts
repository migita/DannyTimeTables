import { factsForTables, parseFactKey, sameFamily, type FactDescriptor } from './facts';
import { recallProbability, weaknessScore } from './memory';
import type { FactKey, FactProgress, RetryItem } from './types';

const TARGET_RECALL = 0.72;
const INTRODUCE_EVERY = 4;
const NO_REPEAT_WINDOW = 8;
const MIN_SEEN_POOL = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface SchedulerInput {
  tables: number[];
  facts: Record<string, FactProgress>;
  recent: FactKey[];
  retries: RetryItem[];
  answered: number;
  /** New facts already introduced this session (warm-up included). */
  introduced?: number;
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
  const pool = factsForTables(input.tables);
  if (!pool.length) throw new Error('Choose at least one table.');
  const lastKey = input.recent.at(-1);

  const retry = input.retries
    .filter((item) => item.dueAfter <= input.answered && !input.recent.slice(-3).includes(item.factKey))
    .sort((a, b) => a.dueAfter - b.dueAfter)[0];
  if (retry) return { ...parseFactKey(retry.factKey), reason: 'retry' };

  const avoidNow = new Set(input.recent.slice(-2));
  const unseen = pool.filter((fact) => !input.facts[fact.key] && !avoidNow.has(fact.key));
  const seen = pool.filter((fact) => input.facts[fact.key]);

  // Unseen facts enter only through this steady drip, easiest facts of the
  // least-covered table first, so a newly enabled table catches up quickly
  // without flooding a session. The introduced counter lets the drip catch
  // up after a question the retry queue claimed, and a near-empty pool keeps
  // introducing regardless of pace so early sessions have enough variety.
  const introductionDue = (input.introduced ?? 0) < Math.floor((input.answered + 1) / INTRODUCE_EVERY);
  if (unseen.length && (introductionDue || seen.length < MIN_SEEN_POOL)) {
    return { ...introductionOrder(unseen, seen)[0], reason: 'new' };
  }

  const windowSize = Math.max(0, Math.min(NO_REPEAT_WINDOW, Math.floor(pool.length / 2), seen.length - 4));
  const recentWindow = new Set(input.recent.slice(-windowSize));
  const available = seen.filter((fact) => !recentWindow.has(fact.key));
  const candidates = available.length ? available : seen.filter((fact) => fact.key !== lastKey);
  const scoringPool = candidates.length ? candidates : seen;

  const scored = scoringPool.map((candidate) => {
    const progress = input.facts[candidate.key];
    const recall = recallProbability(progress, now);
    const unproven = progress.independentCorrect === 0;
    const lapseRate = progress.attempts > 0 ? progress.mistakes / progress.attempts : 0;
    const overdue = progress.nextReviewAt ? Math.max(0, (now - progress.nextReviewAt) / DAY_MS) : 0;
    // Asymmetric around the target: a fact practised moments ago (recall near
    // 1) is worth almost nothing right now, while a forgotten fact keeps most
    // of its value. The old symmetric distance made freshly answered facts
    // outrank everything, which is what caused the repetitive sessions.
    const usefulDifficulty = recall > TARGET_RECALL
      ? Math.max(0, (1 - recall) / (1 - TARGET_RECALL))
      : 1 - ((TARGET_RECALL - recall) / TARGET_RECALL) * 0.35;
    let score = 0.7 + usefulDifficulty * 2.4 + lapseRate * 2.2 + Math.min(2, overdue) + random() * 0.45;

    if (progress.lastWrongAt && now - progress.lastWrongAt < WEEK_MS) score += 1.3;
    if (unproven) score += 0.8;
    if (lastKey && sameFamily(candidate.key, lastKey)) score *= 0.2;
    if (lastKey && parseFactKey(lastKey).factorB === candidate.factorB) score *= 0.68;

    return { candidate, recall, lapseRate, unproven, score };
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
  if (chosen.unproven) reason = 'new';
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

/**
 * Facts worth a warm-up before the questions start: alternates the next facts
 * due for introduction with the shakiest known facts. Returns fewer than
 * `count` (possibly none) when nothing needs attention.
 */
export function pickWarmUpFacts(
  tables: number[],
  facts: Record<string, FactProgress>,
  count: number,
  now = Date.now(),
): FactDescriptor[] {
  if (count <= 0) return [];
  const pool = factsForTables(tables);
  const seen = pool.filter((fact) => facts[fact.key]);
  const unseen = introductionOrder(pool.filter((fact) => !facts[fact.key]), seen);
  const needsWork = seen
    .filter((fact) => {
      const progress = facts[fact.key];
      const recentWrong = progress.lastWrongAt !== null && now - progress.lastWrongAt < WEEK_MS;
      return progress.independentCorrect === 0 || recentWrong || weaknessScore(progress, now) >= 0.45;
    })
    .sort((a, b) => weaknessScore(facts[b.key], now) - weaknessScore(facts[a.key], now));

  const picks: FactDescriptor[] = [];
  let newIndex = 0;
  let weakIndex = 0;
  while (picks.length < count && (newIndex < unseen.length || weakIndex < needsWork.length)) {
    const preferNew = picks.length % 2 === 0;
    if (newIndex < unseen.length && (preferNew || weakIndex >= needsWork.length)) {
      picks.push(unseen[newIndex++]);
    } else {
      picks.push(needsWork[weakIndex++]);
    }
  }
  return picks;
}

function introductionOrder(unseen: FactDescriptor[], seen: FactDescriptor[]): FactDescriptor[] {
  const seenPerTable = new Map<number, number>();
  for (const fact of seen) {
    seenPerTable.set(fact.factorB, (seenPerTable.get(fact.factorB) ?? 0) + 1);
  }
  const coverage = (table: number) => seenPerTable.get(table) ?? 0;
  return [...unseen].sort((a, b) => (
    coverage(a.factorB) - coverage(b.factorB) || a.factorB - b.factorB || a.factorA - b.factorA
  ));
}
