import { ALL_TABLES, CORE_TABLES } from './facts';
import { MIN_FAMILY_CODE_LENGTH } from './sync';
import type { ActiveSession, AppData, FactProgress, SessionConfig, Settings, SyncSettings, TestConfig } from './types';

export const STORAGE_KEY = 'danny-times-tables:data';
export const DATA_VERSION = 5;
export const BUILTIN_PRESET_IDS = ['screen-time-test', 'restaurant-test'];

export const QUESTION_COUNTS = [10, 20, 30, 50];
export const WARM_UP_COUNTS = [0, 2, 3, 5];

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function defaultSessionConfig(): SessionConfig {
  return {
    questionCount: 20,
    passMode: 'count',
    passValue: 18,
    includeDivision: false,
    warmUpCount: 3,
  };
}

function defaultTestConfig(): TestConfig {
  return {
    tables: [...CORE_TABLES],
    questionCount: 50,
    passMode: 'count',
    passValue: 48,
    includeDivision: false,
  };
}

function screenTimePreset(): AppData['presets'][number] {
  return {
    id: 'screen-time-test',
    name: 'Screen time',
    config: {
      tables: [...CORE_TABLES],
      questionCount: 20,
      passMode: 'count',
      passValue: 18,
      includeDivision: false,
    },
  };
}

export function createDefaultData(): AppData {
  return {
    version: DATA_VERSION,
    settings: {
      activeTables: [...ALL_TABLES],
      session: defaultSessionConfig(),
      soundEnabled: false,
    },
    settingsUpdatedAt: 0,
    sync: null,
    facts: {},
    practiceHistory: [],
    testHistory: [],
    presets: [
      screenTimePreset(),
      {
        id: 'restaurant-test',
        name: 'Restaurant test',
        config: defaultTestConfig(),
      },
    ],
    activeSession: null,
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

/**
 * Fill and clamp the settings object. Also used after applying a sync payload
 * from an older device, whose settings will not carry a session block.
 */
export function ensureSettings(value: unknown): Settings {
  const defaults = createDefaultData().settings;
  const settings = isRecord(value) ? value : {};
  const activeTables = numberArray(settings.activeTables).filter(validTable);
  return {
    activeTables: activeTables.length
      ? [...new Set(activeTables)].sort((a, b) => a - b)
      : defaults.activeTables,
    session: normaliseSessionConfig(settings.session),
    soundEnabled: typeof settings.soundEnabled === 'boolean' ? settings.soundEnabled : defaults.soundEnabled,
  };
}

function normaliseSessionConfig(value: unknown, fallback: SessionConfig = defaultSessionConfig()): SessionConfig {
  if (!isRecord(value)) return { ...fallback };
  const questionCount = closestOf(Number(value.questionCount), QUESTION_COUNTS, fallback.questionCount);
  const passMode: SessionConfig['passMode'] = value.passMode === 'percent' ? 'percent' : 'count';
  const rawPass = Number(value.passValue);
  const passValue = Number.isFinite(rawPass)
    ? Math.min(passMode === 'count' ? questionCount : 100, Math.max(1, Math.round(rawPass)))
    : fallback.passValue;
  return {
    questionCount,
    passMode,
    passValue,
    includeDivision: typeof value.includeDivision === 'boolean' ? value.includeDivision : fallback.includeDivision,
    warmUpCount: closestOf(Number(value.warmUpCount), WARM_UP_COUNTS, fallback.warmUpCount),
  };
}

function closestOf(value: number, options: number[], fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return options.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best));
}

function normaliseData(value: unknown): AppData {
  if (!isRecord(value)) throw new Error('The backup does not contain app data.');
  const version = Number(value.version);
  if (!Number.isInteger(version) || version < 1) throw new Error('The backup version is missing.');
  if (version > DATA_VERSION) throw new Error('This backup was made by a newer version of the app.');

  const defaults = createDefaultData();
  const rawSettings = isRecord(value.settings) ? value.settings : {};
  const settings = ensureSettings(rawSettings);
  if (version === 1 && sameTables(settings.activeTables, CORE_TABLES)) {
    settings.activeTables = [...ALL_TABLES];
  }
  const presets = normalisePresets(value.presets, version, defaults.presets);
  if (version < 5 && !isRecord(rawSettings.session)) {
    // The session replaces the separate test presets; seed it from the family's
    // screen-time gate so the pass bar carries over.
    const gate = presets.find((preset) => preset.id === 'screen-time-test') ?? presets[0];
    if (gate) {
      settings.session = normaliseSessionConfig({ ...gate.config, warmUpCount: defaults.settings.session.warmUpCount });
    }
  }
  const facts = isRecord(value.facts)
    ? Object.fromEntries(Object.entries(value.facts).filter((entry): entry is [string, FactProgress] => validFact(entry[1])))
    : {};

  return {
    version: DATA_VERSION,
    settings,
    settingsUpdatedAt: Number.isFinite(Number(value.settingsUpdatedAt)) && Number(value.settingsUpdatedAt) > 0
      ? Number(value.settingsUpdatedAt)
      : 0,
    sync: normaliseSync(value.sync),
    facts,
    practiceHistory: Array.isArray(value.practiceHistory) ? value.practiceHistory.slice(-100) as AppData['practiceHistory'] : [],
    testHistory: Array.isArray(value.testHistory) ? value.testHistory.slice(-100) as AppData['testHistory'] : [],
    presets,
    activeSession: validActiveSession(value.activeSession) ? value.activeSession : null,
  };
}

function normalisePresets(value: unknown, version: number, defaults: AppData['presets']): AppData['presets'] {
  if (!Array.isArray(value) || !value.length) return defaults;
  const presets = value as AppData['presets'];
  // The Screen time preset arrived with version 4; add it once during
  // migration, so deleting it later sticks.
  if (version < 4 && !presets.some((preset) => preset.id === 'screen-time-test')) {
    return [screenTimePreset(), ...presets];
  }
  return presets;
}

function normaliseSync(value: unknown): SyncSettings | null {
  if (!isRecord(value)) return null;
  if (typeof value.familyCode !== 'string' || value.familyCode.trim().length < MIN_FAMILY_CODE_LENGTH) return null;
  const lastSyncedAt = Number(value.lastSyncedAt);
  return {
    familyCode: value.familyCode.trim(),
    lastSyncedAt: Number.isFinite(lastSyncedAt) && lastSyncedAt > 0 ? lastSyncedAt : null,
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

function validActiveSession(value: unknown): value is ActiveSession {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isRecord(value.config) &&
    Array.isArray((value.config as Record<string, unknown>).tables) &&
    Array.isArray(value.warmUpQueue) &&
    Array.isArray(value.recent) &&
    Array.isArray(value.retries) &&
    Array.isArray(value.records) &&
    Number.isFinite(value.answered) &&
    Number.isFinite(value.correct)
  );
}
