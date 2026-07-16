/**
 * Practice-session simulator: replays the app's question loop against a
 * modelled child whose accuracy follows the memory model's recall estimate.
 * Used by the simulation regression test and by ad-hoc before/after reports.
 */
import { factKey, factsForTables, parseFactKey, sameFamily } from '../../src/core/facts';
import { newFactProgress, recallProbability, recordAnswer } from '../../src/core/memory';
import { choosePracticeFact, scheduleRetry, type SchedulerInput, type ScheduledFact } from '../../src/core/scheduler';
import type { FactKey, FactProgress } from '../../src/core/types';

export type ChooseFact = (input: SchedulerInput) => ScheduledFact;

export interface AskedQuestion {
  key: FactKey;
  correct: boolean;
  reason: ScheduledFact['reason'];
}

export interface SessionStats {
  asked: AskedQuestion[];
  distinct: number;
  maxRepeats: number;
  /** Repeats of facts that were answered correctly every time they appeared. */
  cleanRepeats: number;
  newIntroduced: number;
}

export interface SimulationResult {
  sessions: SessionStats[];
  facts: Record<string, FactProgress>;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function answerProbability(progress: FactProgress | undefined, now: number): number {
  if (!progress) return 0.6;
  if (progress.independentCorrect === 0) return progress.attempts > 0 ? 0.75 : 0.6;
  return Math.min(0.98, 0.35 + 0.62 * recallProbability(progress, now));
}

export function runSession(
  choose: ChooseFact,
  tables: number[],
  facts: Record<string, FactProgress>,
  startNow: number,
  random: () => number,
  questionCount = 20,
): { stats: SessionStats; facts: Record<string, FactProgress> } {
  const nextFacts = { ...facts };
  const asked: AskedQuestion[] = [];
  let recent: FactKey[] = [];
  let retries: ReturnType<typeof scheduleRetry> = [];
  let answered = 0;
  let introduced = 0;
  let now = startNow;
  const sessionId = `sim-${startNow}`;

  while (answered < questionCount) {
    const current = choose({ tables, facts: nextFacts, recent, retries, answered, introduced, now, random });
    const before = nextFacts[current.key];
    const wasUnseen = !before;
    if (wasUnseen) introduced += 1;
    const correct = random() < answerProbability(before, now);
    const progress = before ?? newFactProgress(current.key, current.factorA, current.factorB);
    nextFacts[current.key] = recordAnswer(progress, {
      correct,
      independent: true,
      responseMs: 3000 + Math.floor(random() * 3000),
      sessionId,
      source: 'practice',
      now,
    });
    answered += 1;
    asked.push({ key: current.key, correct, reason: wasUnseen ? 'new' : current.reason });
    recent = [...recent, current.key].slice(-10);
    if (current.reason === 'retry') {
      retries = retries.filter((item) => item.factKey !== current.key);
    }
    if (!correct) {
      retries = scheduleRetry(retries, current.key, answered, random);
      nextFacts[current.key] = recordAnswer(nextFacts[current.key], {
        correct: true,
        independent: false,
        responseMs: 2500,
        sessionId,
        source: 'practice',
        now: now + 4000,
      });
      now += 4000;
    }
    now += 8000;
  }

  const counts = new Map<FactKey, number>();
  const anyWrong = new Set<FactKey>();
  for (const item of asked) {
    counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
    if (!item.correct) anyWrong.add(item.key);
  }
  const stats: SessionStats = {
    asked,
    distinct: counts.size,
    maxRepeats: Math.max(...counts.values()),
    cleanRepeats: [...counts.entries()]
      .filter(([key, count]) => count > 1 && !anyWrong.has(key))
      .reduce((sum, [, count]) => sum + count - 1, 0),
    newIntroduced: asked.filter((item) => item.reason === 'new').length,
  };
  return { stats, facts: nextFacts };
}

export function runDays(
  choose: ChooseFact,
  tables: number[],
  facts: Record<string, FactProgress>,
  startNow: number,
  seed: number,
  days: number,
  questionCount = 20,
): SimulationResult {
  const random = mulberry32(seed);
  const sessions: SessionStats[] = [];
  let current = facts;
  for (let day = 0; day < days; day += 1) {
    const result = runSession(choose, tables, current, startNow + day * 24 * 60 * 60 * 1000, random, questionCount);
    sessions.push(result.stats);
    current = result.facts;
  }
  return { sessions, facts: current };
}

export function unseenKeys(tables: number[], facts: Record<string, FactProgress>): FactKey[] {
  return factsForTables(tables).filter((fact) => !facts[fact.key]).map((fact) => fact.key);
}

export function shareOfTable(sessions: SessionStats[], table: number): number {
  const asked = sessions.flatMap((session) => session.asked);
  if (!asked.length) return 0;
  const hits = asked.filter((item) => parseFactKey(item.key).factorB === table).length;
  return hits / asked.length;
}

/**
 * The scheduler exactly as shipped before the 2026-07 fix, kept here as the
 * baseline for before/after comparisons.
 */
export const legacyChoosePracticeFact: ChooseFact = (input) => {
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
};

export const newChoosePracticeFact: ChooseFact = choosePracticeFact;

export { factKey, factsForTables };
