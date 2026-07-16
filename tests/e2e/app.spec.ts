import { expect, test, type Page } from '@playwright/test';

async function enterNumber(page: Page, value: number): Promise<void> {
  for (const digit of String(value)) {
    await page.locator(`[data-action="key"][data-key="${digit}"]`).click();
  }
  await page.locator('[data-action="submit-answer"]').click();
}

async function currentAnswer(page: Page): Promise<number> {
  const expression = (await page.locator('.equation > span').first().innerText()).replaceAll(' ', '');
  if (expression.includes('×')) {
    const [left, right] = expression.split('×').map(Number);
    return left * right;
  }
  const [left, right] = expression.split('÷').map(Number);
  return left / right;
}

async function waitForQuestionReady(page: Page): Promise<void> {
  await page.locator('[data-action="key"][data-key="1"]:not([disabled])').waitFor();
}

async function completeWarmUp(page: Page): Promise<void> {
  while (await page.locator('.lesson-stage').count()) {
    await page.getByRole('button', { name: /Try it/ }).click();
    await enterNumber(page, await currentAnswer(page));
  }
  await expect(page.locator('.practice-shell')).toBeVisible();
}

async function openParentSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Grown-up area' }).click();
  const hold = page.getByRole('button', { name: 'Press and hold' });
  await hold.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

async function disableWarmUp(page: Page): Promise<void> {
  await openParentSettings(page);
  await page.locator('[data-action="set-warmup"][data-value="0"]').click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Ready, Daniel?' })).toBeVisible();
}

test('home and session controls fit an iPhone viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ready, Daniel?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start/ })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: /Start/ }).click();
  await expect(page.locator('.lesson-stage')).toBeVisible();
  await page.getByRole('button', { name: /Try it/ }).click();
  await expect(page.locator('.keypad')).toBeVisible();
  const keypadBox = await page.locator('.keypad').boundingBox();
  expect(keypadBox).not.toBeNull();
  expect(keypadBox!.y + keypadBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});

test('a session starts with a warm-up whose answers stay guided', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();

  await expect(page.locator('.fact-visual-wrap')).toBeVisible();
  await page.getByRole('button', { name: /Try it/ }).click();
  const answer = await currentAnswer(page);
  await enterNumber(page, 0);
  await expect(page.getByText(`Type ${answer}`)).toBeVisible();
  await enterNumber(page, answer);

  const factProgress = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('danny-times-tables:data')!);
    return Object.values(data.facts)[0] as { independentCorrect: number; attempts: number };
  });
  expect(factProgress.attempts).toBe(1);
  expect(factProgress.independentCorrect).toBe(0);
});

test('warmed-up facts come back as real questions early in the session', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).click();
  await completeWarmUp(page);

  const warmedUp = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('danny-times-tables:data')!);
    return Object.keys(data.facts);
  });

  const askedKeys: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    await waitForQuestionReady(page);
    const expression = (await page.locator('.equation > span').first().innerText()).replaceAll(' ', '');
    const [left, right] = expression.split('×').map(Number);
    askedKeys.push(`${left}x${right}`);
    await enterNumber(page, left * right);
  }
  const warmHits = warmedUp.filter((key) => askedKeys.includes(key));
  expect(warmHits.length).toBeGreaterThanOrEqual(2);
});

test('a mistake requires a correction, is saved, and the fact returns later', async ({ page }) => {
  await page.goto('/');
  await disableWarmUp(page);
  await page.getByRole('button', { name: /Start/ }).click();

  await waitForQuestionReady(page);
  const answer = await currentAnswer(page);
  await enterNumber(page, 0);
  await expect(page.getByText('Type the correct answer')).toBeVisible();

  const savedMistakes = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('danny-times-tables:data')!);
    return Object.values(data.facts)[0] as { mistakes: number; independentCorrect: number };
  });
  expect(savedMistakes.mistakes).toBe(1);
  expect(savedMistakes.independentCorrect).toBe(0);

  await enterNumber(page, answer);
  await expect(page.getByText('That’s it')).toBeVisible();
});

test('a grown-up can configure tables and the session in settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.active-table-row')).toContainText('1–12');
  await openParentSettings(page);

  await page.getByRole('button', { name: /Beyond core/ }).click();
  await expect(page.locator('.table-selector button.active')).toHaveCount(8);
  let activeTables = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).settings.activeTables);
  expect(activeTables).toEqual([1, 4, 6, 7, 8, 9, 11, 12]);

  await page.getByRole('button', { name: /All 1–12/ }).click();
  await expect(page.locator('.table-selector button.active')).toHaveCount(12);
  activeTables = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).settings.activeTables);
  expect(activeTables).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  await expect(page.getByText('18 of 20')).toBeVisible();
  await page.locator('[data-action="set-session-count"][data-value="10"]').click();
  await expect(page.getByText('9 of 10')).toBeVisible();
  await page.locator('[data-action="set-session-count"][data-value="50"]').click();
  await expect(page.getByText('45 of 50')).toBeVisible();
});

test('an in-progress session resumes after reload and abandoning is recorded honestly', async ({ page }) => {
  await page.goto('/');
  await disableWarmUp(page);
  await page.getByRole('button', { name: /Start/ }).click();
  await waitForQuestionReady(page);
  await enterNumber(page, await currentAnswer(page));
  await page.reload();

  await expect(page.getByRole('heading', { name: '1 of 20 answered' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await waitForQuestionReady(page);
  await expect(page.getByText('2 / 20')).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByRole('heading', { name: 'End this session?' })).toBeVisible();
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('heading', { name: 'Ready, Daniel?' })).toBeVisible();

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!));
  expect(state.activeSession).toBeNull();
  expect(state.testHistory.at(-1).status).toBe('abandoned');
});

test('a finished session gives a pass verdict and misses can be fixed', async ({ page }) => {
  await page.goto('/');
  await disableWarmUp(page);
  await page.getByRole('button', { name: /Start/ }).click();

  await waitForQuestionReady(page);
  const missedAnswer = await currentAnswer(page);
  await enterNumber(page, missedAnswer === 1 ? 2 : missedAnswer - 1);
  await expect(page.getByText('Type the correct answer')).toBeVisible();
  await enterNumber(page, missedAnswer);

  for (let index = 1; index < 20; index += 1) {
    await waitForQuestionReady(page);
    await enterNumber(page, await currentAnswer(page));
  }

  await expect(page.getByText('PASS', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '19 / 20 correct' })).toBeVisible();
  await expect(page.getByText('Pass mark 18')).toBeVisible();

  await page.getByRole('button', { name: 'Fix the miss' }).click();
  await expect(page.getByText('Fix the misses')).toBeVisible();
  await expect(page.getByText('1 to fix')).toBeVisible();
  await waitForQuestionReady(page);
  await enterNumber(page, await currentAnswer(page));
  await expect(page.getByText('Misses fixed')).toBeVisible();
});
