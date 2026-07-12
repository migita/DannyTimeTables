import { describe, expect, it } from 'vitest';
import { createDefaultData, exportData, importData } from '../src/core/storage';

describe('versioned storage', () => {
  it('round-trips all settings and progress', () => {
    const data = createDefaultData();
    data.settings.activeTables = [3, 7];

    const imported = importData(exportData(data));
    expect(imported.version).toBe(1);
    expect(imported.settings.activeTables).toEqual([3, 7]);
    expect(imported.presets[0].name).toBe('Restaurant test');
  });

  it('rejects backups from a newer schema', () => {
    expect(() => importData('{"version":99}')).toThrow(/newer version/i);
  });
});
