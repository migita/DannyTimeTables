import { describe, expect, it } from 'vitest';
import { answerTest, finishTest, generateTestQuestions, requiredCorrect } from '../src/core/test-engine';
import type { ActiveTest, TestConfig } from '../src/core/types';

const config: TestConfig = {
  tables: [2, 3, 5, 10],
  questionCount: 50,
  passMode: 'count',
  passValue: 48,
  includeDivision: false,
};

describe('strict test engine', () => {
  it('balances questions across configured tables', () => {
    const questions = generateTestQuestions(config, 12345);
    const counts = config.tables.map((table) => questions.filter((question) => question.table === table).length);

    expect(questions).toHaveLength(50);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(new Set(questions.map((question) => question.table))).toEqual(new Set(config.tables));
  });

  it('is deterministic by seed and changes with a new seed', () => {
    const first = generateTestQuestions(config, 55).map(({ left, right, operator }) => `${left}${operator}${right}`);
    const same = generateTestQuestions(config, 55).map(({ left, right, operator }) => `${left}${operator}${right}`);
    const different = generateTestQuestions(config, 56).map(({ left, right, operator }) => `${left}${operator}${right}`);

    expect(first).toEqual(same);
    expect(first).not.toEqual(different);
  });

  it('supports a percentage threshold and division questions', () => {
    const mixedConfig: TestConfig = {
      ...config,
      questionCount: 20,
      passMode: 'percent',
      passValue: 95,
      includeDivision: true,
    };
    const questions = generateTestQuestions(mixedConfig, 9876);

    expect(requiredCorrect(mixedConfig)).toBe(19);
    expect(questions.some((question) => question.kind === 'division')).toBe(true);
    expect(questions.some((question) => question.kind === 'multiplication')).toBe(true);
  });

  it('produces an exact pass or fail from hidden answers', () => {
    const questions = generateTestQuestions({ ...config, questionCount: 3, passValue: 2 }, 1);
    let active: ActiveTest = {
      id: 'test',
      presetName: null,
      config: { ...config, questionCount: 3, passValue: 2 },
      seed: 1,
      startedAt: 100,
      questions,
      answers: [],
    };

    active = answerTest(active, questions[0].answer, 1000);
    active = answerTest(active, -1, 1000);
    active = answerTest(active, questions[2].answer, 1000);

    const result = finishTest(active, 200);
    expect(result.status).toBe('passed');
    expect(result.correct).toBe(2);
  });
});
