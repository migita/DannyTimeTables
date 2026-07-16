import { describe, expect, it } from 'vitest';
import { ALL_TABLES, CORE_TABLES } from '../src/core/facts';
import { createDefaultData, ensureSettings, exportData, importData } from '../src/core/storage';

describe('versioned storage', () => {
  it('starts new learners with every table available', () => {
    expect(createDefaultData().settings.activeTables).toEqual(ALL_TABLES);
  });

  it('round-trips all settings and progress', () => {
    const data = createDefaultData();
    data.settings.activeTables = [3, 7];
    data.settings.session = { questionCount: 30, passMode: 'percent', passValue: 90, includeDivision: true, warmUpCount: 5 };

    const imported = importData(exportData(data));
    expect(imported.version).toBe(5);
    expect(imported.settings.activeTables).toEqual([3, 7]);
    expect(imported.settings.session).toEqual({ questionCount: 30, passMode: 'percent', passValue: 90, includeDivision: true, warmUpCount: 5 });
    expect(imported.presets.map((preset) => preset.name)).toEqual(['Screen time', 'Restaurant test']);
  });

  it('migrates version 2 data without sync configuration', () => {
    const oldData = { ...createDefaultData(), version: 2 } as Record<string, unknown>;
    delete oldData.sync;
    delete oldData.settingsUpdatedAt;

    const imported = importData(JSON.stringify(oldData));
    expect(imported.version).toBe(5);
    expect(imported.sync).toBeNull();
    expect(imported.settingsUpdatedAt).toBe(0);
  });

  it('seeds the session config from the screen-time gate when migrating', () => {
    const oldData = { ...createDefaultData(), version: 4 } as Record<string, unknown>;
    oldData.settings = { activeTables: [2, 3, 4, 5, 10], practiceTarget: 20, soundEnabled: false };
    (oldData.presets as Array<{ id: string; config: Record<string, unknown> }>)[0].config.passValue = 17;

    const imported = importData(JSON.stringify(oldData));
    expect(imported.settings.session).toEqual({
      questionCount: 20,
      passMode: 'count',
      passValue: 17,
      includeDivision: false,
      warmUpCount: 3,
    });
    expect(imported.settings.activeTables).toEqual([2, 3, 4, 5, 10]);
  });

  it('drops an in-flight strict test from older versions', () => {
    const oldData = { ...createDefaultData(), version: 4 } as Record<string, unknown>;
    oldData.activeTest = { id: 'test-1', config: {}, questions: [], answers: [] };

    const imported = importData(JSON.stringify(oldData));
    expect(imported.activeSession).toBeNull();
    expect('activeTest' in imported).toBe(false);
  });

  it('round-trips an active session so it can resume', () => {
    const data = createDefaultData();
    data.activeSession = {
      id: 'session-1',
      startedAt: 100,
      config: { tables: [2, 4], questionCount: 20, passMode: 'count', passValue: 18, includeDivision: false },
      warmUpQueue: ['1x4'],
      answered: 2,
      correct: 2,
      introduced: 1,
      recent: ['2x2', '3x4'],
      retries: [],
      records: [],
      fixQueue: null,
    };

    const imported = importData(exportData(data));
    expect(imported.activeSession?.id).toBe('session-1');
    expect(imported.activeSession?.warmUpQueue).toEqual(['1x4']);
  });

  it('clamps a malformed session config to supported values', () => {
    const data = createDefaultData() as unknown as Record<string, unknown>;
    (data.settings as Record<string, unknown>).session = { questionCount: 23, passMode: 'weird', passValue: 900, warmUpCount: 9 };

    const imported = importData(JSON.stringify(data));
    expect(imported.settings.session.questionCount).toBe(20);
    expect(imported.settings.session.passMode).toBe('count');
    expect(imported.settings.session.passValue).toBe(20);
    expect(imported.settings.session.warmUpCount).toBe(5);
  });

  it('fills a settings object from an older device with session defaults', () => {
    const settings = ensureSettings({ activeTables: [2, 5], soundEnabled: true });
    expect(settings.activeTables).toEqual([2, 5]);
    expect(settings.soundEnabled).toBe(true);
    expect(settings.session.questionCount).toBe(20);
    expect(settings.session.warmUpCount).toBe(3);
  });

  it('respects a deliberate Screen time deletion in version 4 data', () => {
    const data = { ...createDefaultData(), version: 4 } as Record<string, unknown>;
    data.presets = (data.presets as Array<{ id: string }>).filter((preset) => preset.id !== 'screen-time-test');

    const imported = importData(JSON.stringify(data));
    expect(imported.presets.map((preset) => preset.id)).toEqual(['restaurant-test']);
  });

  it('round-trips sync settings and drops codes that are too short', () => {
    const data = createDefaultData();
    data.sync = { familyCode: '5481', lastSyncedAt: 123 };
    expect(importData(exportData(data)).sync).toEqual({ familyCode: '5481', lastSyncedAt: 123 });

    data.sync = { familyCode: '54', lastSyncedAt: null };
    expect(importData(exportData(data)).sync).toBeNull();
  });

  it('rejects backups from a newer schema', () => {
    expect(() => importData('{"version":99}')).toThrow(/newer version/i);
  });

  it('enables all tables when migrating the original untouched table set', () => {
    const oldData = {
      ...createDefaultData(),
      version: 1,
      settings: {
        activeTables: [...CORE_TABLES],
      },
    };

    expect(importData(JSON.stringify(oldData)).settings.activeTables).toEqual(ALL_TABLES);
  });

  it('preserves a custom table selection from an older backup', () => {
    const oldData = {
      ...createDefaultData(),
      version: 1,
      settings: {
        activeTables: [4, 6, 8],
      },
    };

    expect(importData(JSON.stringify(oldData)).settings.activeTables).toEqual([4, 6, 8]);
  });
});
