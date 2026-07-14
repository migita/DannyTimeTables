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
    expect(imported.version).toBe(2);
    expect(imported.settings.activeTables).toEqual([3, 7]);
    expect(imported.presets[0].name).toBe('Restaurant test');
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
