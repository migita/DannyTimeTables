import { describe, expect, it } from 'vitest';
import { ALL_TABLES, CORE_TABLES } from '../src/core/facts';
import { createDefaultData, exportData, importData } from '../src/core/storage';

describe('versioned storage', () => {
  it('starts new learners with every table available', () => {
    expect(createDefaultData().settings.activeTables).toEqual(ALL_TABLES);
  });

  it('round-trips all settings and progress', () => {
    const data = createDefaultData();
    data.settings.activeTables = [3, 7];

    const imported = importData(exportData(data));
    expect(imported.version).toBe(4);
    expect(imported.settings.activeTables).toEqual([3, 7]);
    expect(imported.presets.map((preset) => preset.name)).toEqual(['Screen time', 'Restaurant test']);
  });

  it('migrates version 2 data without sync configuration', () => {
    const oldData = { ...createDefaultData(), version: 2 } as Record<string, unknown>;
    delete oldData.sync;
    delete oldData.settingsUpdatedAt;

    const imported = importData(JSON.stringify(oldData));
    expect(imported.version).toBe(4);
    expect(imported.sync).toBeNull();
    expect(imported.settingsUpdatedAt).toBe(0);
  });

  it('adds the Screen time preset when migrating pre-version-4 data', () => {
    const oldData = { ...createDefaultData(), version: 3 } as Record<string, unknown>;
    oldData.presets = [{ id: 'restaurant-test', name: 'Restaurant test', config: createDefaultData().presets[1].config }];

    const imported = importData(JSON.stringify(oldData));
    expect(imported.presets.map((preset) => preset.id)).toEqual(['screen-time-test', 'restaurant-test']);
    expect(imported.presets[0].config.questionCount).toBe(20);
    expect(imported.presets[0].config.passValue).toBe(18);
  });

  it('respects a deliberate Screen time deletion in version 4 data', () => {
    const data = createDefaultData();
    data.presets = data.presets.filter((preset) => preset.id !== 'screen-time-test');

    const imported = importData(exportData(data));
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
        ...createDefaultData().settings,
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
        ...createDefaultData().settings,
        activeTables: [4, 6, 8],
      },
    };

    expect(importData(JSON.stringify(oldData)).settings.activeTables).toEqual([4, 6, 8]);
  });
});
