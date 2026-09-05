import { descriptor, factsForTables, parseFactKey } from './facts';
import { operationProgress, readyForSpeed } from './memory';
import { presentQuestion } from './session';
import type { ApplicationQuestion, FactKey, FactProgress, QuestionKind, StrategyLesson, TestQuestion } from './types';

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function wasTaught(progress: FactProgress | undefined): boolean {
  return !!progress && (progress.independentCorrect > 0 || progress.lastTaughtAt !== undefined ||
    progress.recentAttempts.some(attempt => attempt.correct && !attempt.independent));
}

/** Freeze content before any teaching. The scheduler cannot change a check's difficulty mid-session. */
export function makeCheck(
  tables: number[], facts: Record<string, FactProgress>, count: number,
  includeDivision: boolean, seconds: number, random = Math.random,
): { assessment: 'check' | 'placement'; questions: TestQuestion[] } {
  const all = factsForTables(tables);
  const eligible = all.filter(fact => wasTaught(facts[fact.key]));
  // A small unscored starting check provides placement without declaring unseen material a failure.
  const placement = eligible.length < Math.min(6, count);
  const candidates = placement
    ? all.filter(fact => [2, 3, 5, 10].includes(fact.factorA))
    : eligible;
  const families = new Set<string>();
  const bank: TestQuestion[] = [];
  for (const fact of candidates) {
    const family = [fact.factorA, fact.factorB].sort((a, b) => a - b).join('x');
    if (!families.has(family)) {
      families.add(family);
      bank.push(question(fact.key, 'multiplication', random() < 0.5));
    }
    if (!placement && includeDivision && wasTaught(facts[fact.key]?.division)) {
      bank.push(question(fact.key, 'division'));
    }
  }
  const target = placement ? Math.min(12, count, bank.length) : count;
  const questions: TestQuestion[] = [];
  const byTable = new Map<number, TestQuestion[]>();
  for (const item of bank) byTable.set(item.table, [...(byTable.get(item.table) ?? []), item]);
  const queues = new Map([...byTable].map(([table, items]) => [table, shuffled(items, random)]));
  while (questions.length < target && byTable.size) {
    for (const table of shuffled([...byTable.keys()], random)) {
      if (questions.length >= target) break;
      let queue = queues.get(table)!;
      if (!queue.length) {
        queue = shuffled(byTable.get(table)!, random);
        queues.set(table, queue);
      }
      const next = queue.shift()!;
      const progress = operationProgress(facts[next.factKey], next.kind);
      questions.push({ ...next, id: `check-${questions.length}`,
        timeLimitSeconds: !placement && readyForSpeed(progress) ? seconds : 0 });
    }
  }
  return { assessment: placement ? 'placement' : 'check', questions };
}

export function question(key: FactKey, kind: QuestionKind, flipped = false): TestQuestion {
  const fact = parseFactKey(key);
  return { ...presentQuestion(fact.factorA, fact.factorB, kind === 'division', flipped),
    id: `${key}-${kind}`, factKey: key, table: fact.factorB };
}

function known(a: number, b: number, facts: Record<string, FactProgress>): boolean {
  return (facts[`${a}x${b}`]?.independentCorrect ?? 0) > 0 || (facts[`${b}x${a}`]?.independentCorrect ?? 0) > 0;
}

/** Pick one useful derivation, grounded in a fact the child has already answered. */
export function strategyLesson(key: FactKey, facts: Record<string, FactProgress>): StrategyLesson {
  const { factorA: a, factorB: b, answer } = parseFactKey(key);
  const common = { rows: a, columns: b };
  const finish = { prompt: 'Now use that idea on your own.', expression: `${a} × ${b}`, answer };
  if (b === 1 || a === 1) {
    const n = b === 1 ? a : b;
    return { ...common, title: 'One of each', explanation: `One group of ${n} has ${n}. Multiplying by one keeps the amount the same.`,
      equation: `1 × ${n} = ${n}`, steps: [finish] };
  }
  if (b === 2) {
    return { ...common, splitAfter: 1, title: `Double ${a}`,
      explanation: `There are ${a} in each colour. Put the two equal parts together.`, equation: `${a} + ${a} = ${answer}`,
      steps: [{ prompt: `What is double ${a}?`, expression: `${a} + ${a}`, answer }, finish] };
  }
  if ((b === 4 || b === 8) && known(a, b / 2, facts)) {
    const half = b / 2;
    const subtotal = a * half;
    return { ...common, splitAfter: half, title: 'Double a fact you know',
      explanation: `Each colour is ${a} × ${half}. Double ${subtotal} to make ${a} × ${b}.`,
      equation: `${subtotal} + ${subtotal} = ${answer}`,
      steps: [{ prompt: 'Work out one half first.', expression: `${a} × ${half}`, answer: subtotal },
        { prompt: `Now double ${subtotal}.`, expression: `${subtotal} + ${subtotal}`, answer }, finish] };
  }
  const anchor = b === 3 ? 2 : b === 6 || b === 7 ? 5 : b === 11 || b === 12 ? 10 : 0;
  if (anchor && known(a, anchor, facts)) {
    const extra = b - anchor;
    return { ...common, splitAfter: anchor, title: 'Split it into easier parts',
      explanation: `${a} × ${b} is ${a} × ${anchor}, plus ${a} × ${extra}. Join the two colours.`,
      equation: `${a * anchor} + ${a * extra} = ${answer}`,
      steps: [{ prompt: 'Start with the part you know.', expression: `${a} × ${anchor}`, answer: a * anchor },
        { prompt: `Add the other ${a * extra}.`, expression: `${a * anchor} + ${a * extra}`, answer }, finish] };
  }
  if (b === 9 && known(a, 10, facts)) {
    return { ...common, title: 'Ten groups, then one less',
      explanation: `Start with ${a} × 10 = ${a * 10}. Take away one ${a} to find ${a} × 9.`,
      equation: `${a * 10} − ${a} = ${answer}`,
      steps: [{ prompt: 'Use the tens fact first.', expression: `${a} × 10`, answer: a * 10 },
        { prompt: `Take away ${a}.`, expression: `${a * 10} − ${a}`, answer }, finish] };
  }
  if (b === 5 && known(a, 10, facts)) {
    return { ...common, title: 'Half of the tens fact',
      explanation: `${a} × 10 is ${a * 10}. Five is half of ten, so take half of ${a * 10}.`,
      equation: `${a * 10} ÷ 2 = ${answer}`,
      steps: [{ prompt: 'Start with the tens fact.', expression: `${a} × 10`, answer: a * 10 },
        { prompt: `What is half of ${a * 10}?`, expression: `${a * 10} ÷ 2`, answer }, finish] };
  }
  const previous = (a - 1) * b;
  return { ...common, title: 'Build equal groups',
    explanation: `There are ${a} rows with ${b} in each. Count in ${b}s, adding one equal group at a time.`,
    equation: `${previous} + ${b} = ${answer}`,
    steps: [{ prompt: `The first ${a - 1} rows make ${previous}. Add the last row of ${b}.`, expression: `${previous} + ${b}`, answer }, finish] };
}

export function applicationQuestions(keys: FactKey[]): ApplicationQuestion[] {
  const key = keys.find(k => { const f = parseFactKey(k); return f.factorA > 1 && f.factorB > 1; }) ?? keys[0];
  if (!key) return [];
  const { factorA: a, factorB: b, answer } = parseFactKey(key);
  const second = keys.find(k => k !== key && parseFactKey(k).factorA > 1) ?? key;
  const f = parseFactKey(second);
  return [
    { factKey: key, kind: 'missing-factor', prompt: `How many groups of ${b} make ${answer}?`,
      expression: `□ × ${b} = ${answer}`, answer: a,
      help: `${a} groups of ${b} make ${answer}. The missing number is ${a}.` },
    { factKey: second, kind: 'story', prompt: `There are ${f.factorA} packets. Each packet has ${f.factorB} stickers. How many stickers altogether?`,
      expression: 'Total stickers', answer: f.answer,
      help: `${f.factorA} equal groups of ${f.factorB}: ${f.factorA} × ${f.factorB} = ${f.answer}.` },
  ];
}

export function practicePool(tables: number[], facts: Record<string, FactProgress>): Record<string, FactProgress> {
  return Object.fromEntries(factsForTables(tables).filter(f => wasTaught(facts[f.key])).map(f => [f.key, facts[f.key]]));
}

export function factFromQuestion(item: TestQuestion) {
  return { ...descriptor(parseFactKey(item.factKey).factorA, parseFactKey(item.factKey).factorB),
    reason: 'check' as const, kind: item.kind, presented: item };
}
