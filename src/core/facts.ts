import type { FactKey } from './types';

export const ALL_TABLES = Array.from({ length: 12 }, (_, index) => index + 1);
export const CORE_TABLES = [2, 3, 5, 10];
export const BEYOND_CORE_TABLES = ALL_TABLES.filter((table) => !CORE_TABLES.includes(table));
export const MULTIPLIERS = Array.from({ length: 12 }, (_, index) => index + 1);

export interface FactDescriptor {
  key: FactKey;
  factorA: number;
  factorB: number;
  answer: number;
}

export interface FactExplanation {
  title: string;
  short: string;
  equation: string;
  visual: 'pairs' | 'groups' | 'fives' | 'tens' | 'array';
}

export function factKey(factorA: number, factorB: number): FactKey {
  return `${factorA}x${factorB}`;
}

export function descriptor(factorA: number, factorB: number): FactDescriptor {
  return {
    key: factKey(factorA, factorB),
    factorA,
    factorB,
    answer: factorA * factorB,
  };
}

export function factsForTables(tables: number[]): FactDescriptor[] {
  return tables.flatMap((table) => MULTIPLIERS.map((multiplier) => descriptor(multiplier, table)));
}

export function parseFactKey(key: FactKey): FactDescriptor {
  const [factorA, factorB] = key.split('x').map(Number);
  return descriptor(factorA, factorB);
}

export function sameFamily(first: FactKey, second: FactKey): boolean {
  const a = parseFactKey(first);
  const b = parseFactKey(second);
  return (
    (a.factorA === b.factorA && a.factorB === b.factorB) ||
    (a.factorA === b.factorB && a.factorB === b.factorA)
  );
}

export function explanationForFact(factorA: number, factorB: number): FactExplanation {
  const answer = factorA * factorB;

  if (factorB === 2) {
    return {
      title: `Double ${factorA}`,
      short: `Two groups of ${factorA} make ${answer}.`,
      equation: `${factorA} + ${factorA} = ${answer}`,
      visual: 'pairs',
    };
  }

  if (factorB === 5) {
    return {
      title: `${factorA} jumps of five`,
      short: `Count in fives ${factorA} times to reach ${answer}.`,
      equation: Array.from({ length: Math.min(factorA, 6) }, (_, index) => (index + 1) * 5).join(', ') + (factorA > 6 ? ` … ${answer}` : ''),
      visual: 'fives',
    };
  }

  if (factorB === 10) {
    return {
      title: `${factorA} groups of ten`,
      short: `${factorA} tens have a value of ${answer}.`,
      equation: `${factorA} tens = ${answer}`,
      visual: 'tens',
    };
  }

  if (factorB === 3) {
    return {
      title: `${factorA} groups of three`,
      short: `Add one group of three at a time to reach ${answer}.`,
      equation: factorA <= 6 ? Array.from({ length: factorA }, () => '3').join(' + ') + ` = ${answer}` : `Count in threes to ${answer}`,
      visual: 'groups',
    };
  }

  return {
    title: `${factorA} groups of ${factorB}`,
    short: `Each group has ${factorB}. Altogether there are ${answer}.`,
    equation: `${factorA} × ${factorB} = ${answer}`,
    visual: 'array',
  };
}
