import { MULTIPLIERS, factKey } from './facts';
import type { ActiveTest, TestAnswer, TestConfig, TestQuestion, TestResult } from './types';

export function requiredCorrect(config: TestConfig): number {
  if (config.passMode === 'percent') {
    return Math.ceil(config.questionCount * config.passValue / 100);
  }
  return Math.min(config.questionCount, Math.max(0, Math.round(config.passValue)));
}

export function generateTestQuestions(config: TestConfig, seed: number): TestQuestion[] {
  const tables = [...new Set(config.tables)].sort((a, b) => a - b);
  if (tables.length === 0) throw new Error('Choose at least one table.');
  const random = seededRandom(seed);
  const baseQuota = Math.floor(config.questionCount / tables.length);
  let remainder = config.questionCount % tables.length;
  const tableOrder = shuffle([...tables], random);
  const questions: TestQuestion[] = [];

  for (const table of tableOrder) {
    const quota = baseQuota + (remainder-- > 0 ? 1 : 0);
    const multiplierStream: number[] = [];
    while (multiplierStream.length < quota) {
      multiplierStream.push(...shuffle([...MULTIPLIERS], random));
    }

    multiplierStream.slice(0, quota).forEach((multiplier, index) => {
      const useDivision = config.includeDivision && (index + table + Math.floor(random() * 2)) % 2 === 0;
      const base = {
        id: `${seed}-${table}-${index}-${questions.length}`,
        factKey: factKey(multiplier, table),
        table,
      };
      questions.push(useDivision
        ? {
            ...base,
            kind: 'division',
            left: multiplier * table,
            right: table,
            operator: '÷',
            answer: multiplier,
          }
        : {
            ...base,
            kind: 'multiplication',
            left: multiplier,
            right: table,
            operator: '×',
            answer: multiplier * table,
          });
    });
  }

  return reduceAdjacentFamilies(shuffle(questions, random));
}

export function answerTest(active: ActiveTest, answer: number, responseMs: number): ActiveTest {
  const question = active.questions[active.answers.length];
  if (!question) return active;
  const response: TestAnswer = {
    questionId: question.id,
    answer,
    correct: answer === question.answer,
    responseMs,
  };
  return { ...active, answers: [...active.answers, response] };
}

export function finishTest(active: ActiveTest, now = Date.now()): TestResult {
  if (active.answers.length !== active.questions.length) {
    throw new Error('The test is not complete.');
  }
  const correct = active.answers.filter((answer) => answer.correct).length;
  return {
    id: active.id,
    presetName: active.presetName,
    config: active.config,
    startedAt: active.startedAt,
    finishedAt: now,
    status: correct >= requiredCorrect(active.config) ? 'passed' : 'failed',
    correct,
    answered: active.answers.length,
    answers: active.answers,
    questions: active.questions,
  };
}

export function abandonTest(active: ActiveTest, now = Date.now()): TestResult {
  return {
    id: active.id,
    presetName: active.presetName,
    config: active.config,
    startedAt: active.startedAt,
    finishedAt: now,
    status: 'abandoned',
    correct: active.answers.filter((answer) => answer.correct).length,
    answered: active.answers.length,
    answers: active.answers,
    questions: active.questions,
  };
}

export function createSeed(): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] || Date.now();
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

function reduceAdjacentFamilies(questions: TestQuestion[]): TestQuestion[] {
  for (let index = 1; index < questions.length; index += 1) {
    const previous = questions[index - 1];
    const current = questions[index];
    if (previous.table !== current.table && previous.factKey !== current.factKey) continue;

    const swapIndex = questions.findIndex((candidate, candidateIndex) => (
      candidateIndex > index && candidate.table !== previous.table && candidate.factKey !== previous.factKey
    ));
    if (swapIndex > index) {
      [questions[index], questions[swapIndex]] = [questions[swapIndex], questions[index]];
    }
  }
  return questions;
}
