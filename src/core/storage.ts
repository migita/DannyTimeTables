import { ALL_TABLES, CORE_TABLES } from './facts';
import type { AppData, FactProgress, TestConfig } from './types';

export const STORAGE_KEY = 'danny-times-tables:data';
export const DATA_VERSION = 2;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function defaultTestConfig(): TestConfig {
  return {
    tables: [...CORE_TABLES],
    questionCount: 50,
    passMode: 'count',
    passValue: 48,
    includeDivision: false,
  };
}

export function createDefaultData(): AppData {
  return {
    version: DATA_VERSION,
    settings: {
      activeTables: [...ALL_TABLES],
      practiceTarget: 20,
      soundEnabled: false,
    },
    facts: {},
    practiceHistory: [],
    testHistory: [],
    presets: [
      {
        id: 'restaurant-test',
        name: 'Restaurant test',
        config: defaultTestConfig(),
      },
    ],
    activeTest: null,
  };
}

export function loadData(storage: StorageLike = localStorage): AppData {
  const stored = storage.getItem(STORAGE_KEY);
  if (!stored) return createDefaultData();
  try {
    return normaliseData(JSON.parse(stored));
  } catch (error) {
    console.warn('Could not load saved Danny Times data.', error);
    return createDefaultData();
  }
}

export function saveData(data: AppData, storage: StorageLike = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function resetData(storage: StorageLike = localStorage): AppData {
  storage.removeItem(STORAGE_KEY);
  return createDefaultData();
}

export function exportData(data: AppData): string {
  return JSON.stringify(data, null, 2);
}

export function importData(text: string): AppData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  return normaliseData(parsed);
}

function normaliseData(value: unknown): AppData {
  if (!isRecord(value)) throw new Error('The backup does not contain app data.');
  const version = Number(value.version);
  if (!Number.isInteger(version) || version < 1) throw new Error('The backup version is missing.');
  if (version > DATA_VERSION) throw new Error('This backup was made by a newer version of the app.');

  const defaults = createDefaultData();
  const settings = isRecord(value.settings) ? value.settings : {};
  const activeTables = numberArray(settings.activeTables).filter(validTable);
  const migratedActiveTables = version === 1 && sameTables(activeTables, CORE_TABLES)
    ? [...ALL_TABLES]
    : activeTables;
  const practiceTarget = settings.practiceTarget === null || [10, 20, 30].includes(Number(settings.practiceTarget))
    ? settings.practiceTarget as 10 | 20 | 30 | null
    : defaults.settings.practiceTarget;
  const facts = isRecord(value.facts)
    ? Object.fromEntries(Object.entries(value.facts).filter((entry): entry is [string, FactProgress] => validFact(entry[1])))
    : {};

  return {
    version: DATA_VERSION,
    settings: {
      activeTables: migratedActiveTables.length
        ? [...new Set(migratedActiveTables)].sort((a, b) => a - b)
        : defaults.settings.activeTables,
      practiceTarget,
      soundEnabled: typeof settings.soundEnabled === 'boolean' ? settings.soundEnabled : defaults.settings.soundEnabled,
    },
    facts,
    practiceHistory: Array.isArray(value.practiceHistory) ? value.practiceHistory.slice(-100) as AppData['practiceHistory'] : [],
    testHistory: Array.isArray(value.testHistory) ? value.testHistory.slice(-100) as AppData['testHistory'] : [],
    presets: Array.isArray(value.presets) && value.presets.length ? value.presets as AppData['presets'] : defaults.presets,
    activeTest: isRecord(value.activeTest) ? value.activeTest as unknown as AppData['activeTest'] : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : [];
}

function validTable(value: number): boolean {
  return value >= 1 && value <= 12;
}

function sameTables(first: number[], second: number[]): boolean {
  return first.length === second.length && second.every((table) => first.includes(table));
}

function validFact(value: unknown): value is FactProgress {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === 'string' &&
    Number.isInteger(value.factorA) &&
    Number.isInteger(value.factorB) &&
    Number.isFinite(value.attempts) &&
    Number.isFinite(value.independentCorrect) &&
    Array.isArray(value.recentAttempts)
  );
}
