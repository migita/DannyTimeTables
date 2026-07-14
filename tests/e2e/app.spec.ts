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

async function openParentTests(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Just Test' }).click();
  const hold = page.getByRole('button', { name: 'Press and hold' });
  await hold.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Just Test' })).toBeVisible();
}

test('home and child controls fit an iPhone viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ready, Daniel?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Learn' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Practice' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Just Test' })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Practice' }).click();
  await expect(page.locator('.keypad')).toBeVisible();
  const keypadBox = await page.locator('.keypad').boundingBox();
  expect(keypadBox).not.toBeNull();
  expect(keypadBox!.y + keypadBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});

test('learn separates guided help from the independent attempt', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Learn' }).click();
  await expect(page.locator('.fact-visual-wrap')).toBeVisible();
  await page.getByRole('button', { name: /Try it/ }).click();

  const answer = await currentAnswer(page);
  await enterNumber(page, answer);
  await expect(page.getByText('Your turn')).toBeVisible();
  await enterNumber(page, 0);
  await expect(page.getByText(`Type ${answer}`)).toBeVisible();
  await enterNumber(page, answer);

  await expect(page.getByRole('heading', { name: 'We’ll bring it back' })).toBeVisible();
  const factProgress = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('danny-times-tables:data')!);
    return Object.values(data.facts)[0] as { independentCorrect: number; mistakes: number };
  });
  expect(factProgress.independentCorrect).toBe(0);
  expect(factProgress.mistakes).toBe(1);
});

test('practice requires a correction and saves the mistake immediately', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practice' }).click();
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
  await page.waitForTimeout(750);
  await expect(page.getByText('That’s it')).not.toBeVisible();
});

test('a grown-up can configure core, beyond-core, or all tables in one tap', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.active-table-row')).toContainText('1–12');
  await page.getByRole('button', { name: 'Grown-up area' }).click();
  await page.getByRole('button', { name: 'Press and hold' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Settings' }).click();

  await page.getByRole('button', { name: /Beyond core/ }).click();
  await expect(page.locator('.table-selector button.active')).toHaveCount(8);
  let activeTables = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).settings.activeTables);
  expect(activeTables).toEqual([1, 4, 6, 7, 8, 9, 11, 12]);

  await page.getByRole('button', { name: /Core/ }).click();
  await expect(page.locator('.table-selector button.active')).toHaveCount(4);

  await page.getByRole('button', { name: /All 1–12/ }).click();
  await expect(page.locator('.table-selector button.active')).toHaveCount(12);
  activeTables = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!).settings.activeTables);
  expect(activeTables).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('an in-progress strict test resumes after reload and can only be abandoned explicitly', async ({ page }) => {
  await page.goto('/');
  await openParentTests(page);
  await page.getByRole('button', { name: 'Start Restaurant test' }).click();
  await enterNumber(page, await currentAnswer(page));
  await page.reload();

  await expect(page.getByRole('heading', { name: '1 of 50 answered' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('2 / 50')).toBeVisible();
  await page.getByRole('button', { name: 'Leave test' }).click();
  await expect(page.getByRole('heading', { name: 'End this test?' })).toBeVisible();
  await page.getByRole('button', { name: 'End test' }).click();
  await expect(page.getByRole('heading', { name: 'Ready, Daniel?' })).toBeVisible();

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('danny-times-tables:data')!));
  expect(state.activeTest).toBeNull();
  expect(state.testHistory.at(-1).status).toBe('abandoned');
});

test('strict test gives an unambiguous pass without revealing answers during the run', async ({ page }) => {
  await page.goto('/');
  await openParentTests(page);
  await page.getByRole('button', { name: '20', exact: true }).click();
  await page.getByRole('button', { name: 'Start test' }).click();

  for (let index = 0; index < 20; index += 1) {
    await expect(page.getByText('Yes', { exact: true })).toHaveCount(0);
    await enterNumber(page, await currentAnswer(page));
  }

  await expect(page.getByText('PASS', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '20 / 20 correct' })).toBeVisible();
  await expect(page.getByText('Pass mark 20')).toBeVisible();
});
