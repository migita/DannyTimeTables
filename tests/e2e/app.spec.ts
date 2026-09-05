import { expect, test, type Page } from '@playwright/test';
import { factsForTables } from '../../src/core/facts';
import { newFactProgress } from '../../src/core/memory';
import { createDefaultData } from '../../src/core/storage';

async function seed(page: Page, options: { teaching?: number; timing?: number; division?: boolean; count?: number; tables?: number[] } = {}) {
  const data = createDefaultData();
  const now = Date.now();
  data.settings.activeTables = options.tables ?? [2, 4, 5];
  data.settings.session = { questionCount: options.count ?? 10, passMode: 'count', passValue: (options.count ?? 10) - 1,
    includeDivision: options.division ?? false, warmUpCount: options.teaching ?? 2, timeLimitSeconds: options.timing ?? 0 };
  for (const fact of factsForTables(data.settings.activeTables)) {
    const progress = { ...newFactProgress(fact.key, fact.factorA, fact.factorB), attempts: 4, independentAttempts: 4,
      independentCorrect: 4, currentStreak: 4, stabilityHours: 24,
      lastReviewedAt: now - 2 * 86400000, lastCorrectAt: now - 2 * 86400000,
      averageResponseMs: 2500, correctSessionIds: ['previous'] };
    data.facts[fact.key] = options.division ? { ...progress, division: { ...progress } } : progress;
  }
  await page.addInitScript(data => {
    if (!localStorage.getItem('danny-times-tables:data')) localStorage.setItem('danny-times-tables:data', JSON.stringify(data));
  }, data);
}

async function enterNumber(page: Page, answer: number) {
  for (const digit of String(answer)) await page.locator(`[data-action="key"][data-key="${digit}"]`).click();
  await page.getByRole('button', { name: 'Check answer', exact: true }).click();
}

async function ready(page: Page) {
  await page.locator('[data-action="key"][data-key="1"]:not([disabled])').waitFor();
}

async function expression(page: Page) {
  return (await page.locator('.equation > span').first().innerText()).replaceAll(' ', '');
}

async function answerNow(page: Page): Promise<number> {
  const value = await expression(page);
  const missing = value.match(/^□×(\d+)=(\d+)$/);
  if (missing) return Number(missing[2]) / Number(missing[1]);
  const match = value.match(/^(\d+)([×÷+−])(\d+)$/);
  if (match) {
    const a = Number(match[1]), b = Number(match[3]);
    return match[2] === '×' ? a * b : match[2] === '÷' ? a / b : match[2] === '+' ? a + b : a - b;
  }
  const numbers = (await page.locator('.application-prompt').innerText()).match(/\d+/g)!.map(Number);
  return numbers[0] * numbers[1];
}

async function check(page: Page, count: number, missAt = -1) {
  for (let i = 0; i < count; i++) {
    await ready(page);
    await enterNumber(page, i === missAt ? 0 : await answerNow(page));
    await expect(page.getByText('Answer saved', { exact: true })).toBeVisible();
    await expect(page.locator('.practice-correction')).toHaveCount(0);
  }
}

async function completeLearning(page: Page) {
  for (let i = 0; i < 90; i++) {
    await expect.poll(async () => {
      if (await page.locator('.result-shell').count()) return 'done';
      if (await page.locator('.lesson-stage').count()) return 'lesson';
      if (await page.locator('[data-action="key"][data-key="1"]:not([disabled])').count()) return 'answer';
      return 'wait';
    }).not.toBe('wait');
    if (await page.locator('.result-shell').count()) return;
    if (await page.locator('.lesson-stage').count()) {
      await page.getByRole('button', { name: 'Try it', exact: true }).click();
    } else {
      await enterNumber(page, await answerNow(page));
    }
  }
  throw new Error('Learning did not reach its result');
}

test('new learner gets an untimed starting check and no false pass or failure', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.active-table-row')).toHaveText('2510');
  await page.getByRole('button', { name: /Start/ }).click();
  await expect(page.locator('.child-header strong')).toHaveText('Starting check');
  await expect(page.locator('.lesson-stage')).toHaveCount(0);
  await expect(page.locator('.time-track')).toHaveCount(0);
  const total = Number((await page.locator('.child-progress > span').innerText()).split('/')[1]);
  await check(page, total);
  await completeLearning(page);
  await expect(page.getByText('GOOD START', { exact: true })).toBeVisible();
  await expect(page.getByText('Starting checks have no pass mark.')).toBeVisible();
});

test('a fixed check precedes teaching and learning cannot change its pass score', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();
  await expect(page.locator('.child-header strong')).toHaveText('Check');
  await check(page, 10, 0);
  await expect(page.locator('.lesson-stage')).toBeVisible();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).testHistory.at(-1));
  expect(before.correct).toBe(9);
  expect(before.questions).toHaveLength(10);
  await completeLearning(page);
  await expect(page.getByText('PASS', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '9 / 10 correct' })).toBeVisible();
  await expect(page.getByText('2/2 puzzles solved without help')).toBeVisible();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).testHistory.at(-1));
  expect(after.answers).toEqual(before.answers);
  expect(after.correct).toBe(9);
  expect(after.learning.practiceAnswered).toBeGreaterThan(0);
});

test('teaching steps stay guided and fit a phone', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();
  await check(page, 10);
  await expect(page.locator('.lesson-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Try it', exact: true }).click();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!));
  const key = before.activeSession.warmUpQueue[0];
  await enterNumber(page, 0);
  await expect(page.locator('.correction-copy')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const box = await page.locator('.keypad').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await enterNumber(page, await answerNow(page));
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!));
  expect(after.facts[key].independentCorrect).toBe(before.facts[key].independentCorrect);
});

test('division misses are fixed and independently retried as division', async ({ page }) => {
  await seed(page, { teaching: 0, division: true, tables: [5], count: 20 });
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();
  let missed = '';
  for (let i = 0; i < 20; i++) {
    await ready(page);
    const current = await expression(page);
    const wrong = !missed && current.includes('÷');
    if (wrong) missed = current;
    await enterNumber(page, wrong ? 0 : await answerNow(page));
  }
  expect(missed).not.toBe('');
  await expect(page.getByText('PASS', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fix the miss', exact: true }).click();
  await ready(page);
  expect(await expression(page)).toBe(missed);
  const expected = await answerNow(page);
  await enterNumber(page, 0);
  await expect(page.getByText('Type the correct answer')).toBeVisible();
  await enterNumber(page, expected);
  await ready(page);
  expect(await expression(page)).toBe(missed);
  await enterNumber(page, expected);
  await expect(page.getByText('Misses fixed', { exact: true })).toBeVisible();
});

test('a timed-out check answer is saved without a correction or a false wrong-fact record', async ({ page }) => {
  await seed(page, { teaching: 0, timing: 3 });
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();
  await expect(page.locator('.time-track.is-running')).toBeVisible();
  await expect(page.getByText('Answer saved', { exact: true })).toBeVisible({ timeout: 6000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!));
  const record = saved.activeSession.records[0];
  expect(record.given).toBeNull();
  expect(saved.facts[record.factKey].timeouts).toBe(1);
  expect(saved.facts[record.factKey].mistakes).toBe(0);
  await expect(page.locator('.practice-correction')).toHaveCount(0);
});

test('reload retains the current question and entire fixed check', async ({ page }) => {
  await seed(page, { teaching: 0 });
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();
  await enterNumber(page, await answerNow(page));
  await ready(page);
  const next = await expression(page);
  const plan = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).activeSession.flow.checkQuestions);
  await page.reload();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await ready(page);
  expect(await expression(page)).toBe(next);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).activeSession.flow.checkQuestions)).toEqual(plan);
});

test('ending learning after reload preserves the completed check', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();
  await check(page, 10);
  await expect(page.locator('.lesson-stage')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Learning in progress' })).toBeVisible();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.getByText('PASS', { exact: true })).toBeVisible();
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).testHistory);
  expect(history).toHaveLength(1);
  expect(history[0].status).toBe('passed');
});

test('parent settings preserve table choice, pass mark and the just-check option', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Grown-up area', exact: true }).click();
  const now = new Date();
  const pin = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  for (const digit of pin) await page.locator(`[data-action="pin-key"][data-key="${digit}"]`).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('[data-action="set-warmup"][data-value="0"]').click();
  await page.locator('[data-action="set-session-count"][data-value="20"]').click();
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).settings);
  expect(settings.activeTables).toEqual([2, 4, 5]);
  expect(settings.session.warmUpCount).toBe(0);
  expect(settings.session.passValue).toBe(18);
});
