import { describe, expect, it } from 'vitest';
import { newFactProgress } from '../src/core/memory';
import { createDefaultData } from '../src/core/storage';
import {
  applyPayload,
  mergePayloads,
  parseRemoteBody,
  toPayload,
  type SyncPayload,
} from '../src/core/sync';
import type {
  ActiveTest,
  AppData,
  FactProgress,
  PracticeSessionSummary,
  TestResult,
} from '../src/core/types';

function makeData(overrides: Partial<AppData> = {}): AppData {
  return { ...createDefaultData(), ...overrides };
}

function makeResult(id: string, finishedAt: number, status: TestResult['status'] = 'passed'): TestResult {
  return {
    id,
    presetName: null,
    config: { tables: [2], questionCount: 1, passMode: 'count', passValue: 1, includeDivision: false },
    startedAt: finishedAt - 60_000,
    finishedAt,
    status,
    correct: 1,
    answered: 1,
    answers: [],
    questions: [],
  };
}

function makeSession(id: string, finishedAt: number): PracticeSessionSummary {
  return {
    id,
    mode: 'practice',
    startedAt: finishedAt - 120_000,
    finishedAt,
    answered: 5,
    independentCorrect: 4,
    target: 20,
    factKeys: ['2x2'],
  };
}

function makeFact(key: string, overrides: Partial<FactProgress>): FactProgress {
  const [factorA, factorB] = key.split('x').map(Number);
  return { ...newFactProgress(`${factorA}x${factorB}`, factorA, factorB), ...overrides };
}

describe('sync payload', () => {
  it('never uploads device-local state', () => {
    const activeTest = { id: 'test-1' } as unknown as ActiveTest;
    const data = makeData({ sync: { familyCode: 'a-long-family-code', lastSyncedAt: 5 }, activeTest });
    const payload = toPayload(data) as unknown as Record<string, unknown>;

    expect(payload.activeTest).toBeUndefined();
    expect(payload.sync).toBeUndefined();
  });

  it('keeps local credentials and an in-progress test when applying a merged payload', () => {
    const activeTest = { id: 'test-1' } as unknown as ActiveTest;
    const data = makeData({ sync: { familyCode: 'a-long-family-code', lastSyncedAt: 5 }, activeTest });
    const incoming = toPayload(makeData({ testHistory: [makeResult('r1', 1000)] }));

    const applied = applyPayload(data, incoming);
    expect(applied.sync).toEqual({ familyCode: 'a-long-family-code', lastSyncedAt: 5 });
    expect(applied.activeTest).toBe(activeTest);
    expect(applied.testHistory.map((result) => result.id)).toEqual(['r1']);
  });
});

describe('mergePayloads', () => {
  it('a pass recorded offline survives whichever device syncs last', () => {
    const offlinePass = makeResult('ipad-pass', 3000);
    const phoneSession = makeSession('phone-session', 2000);
    const local = toPayload(makeData({ testHistory: [offlinePass] }));
    const remote = toPayload(makeData({ practiceHistory: [phoneSession], testHistory: [makeResult('old', 1000)] }));

    const merged = mergePayloads(local, remote);
    expect(merged.testHistory.map((result) => result.id)).toEqual(['old', 'ipad-pass']);
    expect(merged.practiceHistory.map((session) => session.id)).toEqual(['phone-session']);

    const mergedOtherWay = mergePayloads(remote, local);
    expect(mergedOtherWay.testHistory.map((result) => result.id)).toEqual(['old', 'ipad-pass']);
  });

  it('caps merged history at 100 keeping the newest entries', () => {
    const local = toPayload(makeData({
      testHistory: Array.from({ length: 80 }, (_, index) => makeResult(`local-${index}`, index * 10)),
    }));
    const remote = toPayload(makeData({
      testHistory: Array.from({ length: 80 }, (_, index) => makeResult(`remote-${index}`, 5 + index * 10)),
    }));

    const merged = mergePayloads(local, remote);
    expect(merged.testHistory).toHaveLength(100);
    expect(merged.testHistory.at(-1)!.id).toBe('remote-79');
  });

  it('keeps the fact record that was reviewed more recently', () => {
    const local = toPayload(makeData({
      facts: { '3x5': makeFact('3x5', { lastReviewedAt: 1000, attempts: 4, mistakes: 2 }) },
    }));
    const remote = toPayload(makeData({
      facts: {
        '3x5': makeFact('3x5', { lastReviewedAt: 9000, attempts: 6, mistakes: 1 }),
        '2x5': makeFact('2x5', { lastReviewedAt: 500, attempts: 1 }),
      },
    }));

    const merged = mergePayloads(local, remote);
    expect(merged.facts['3x5'].attempts).toBe(6);
    expect(merged.facts['2x5'].attempts).toBe(1);
  });

  it('breaks fact timestamp ties with the higher attempt count', () => {
    const local = toPayload(makeData({ facts: { '3x5': makeFact('3x5', { lastReviewedAt: 1000, attempts: 9 }) } }));
    const remote = toPayload(makeData({ facts: { '3x5': makeFact('3x5', { lastReviewedAt: 1000, attempts: 4 }) } }));

    expect(mergePayloads(local, remote).facts['3x5'].attempts).toBe(9);
    expect(mergePayloads(remote, local).facts['3x5'].attempts).toBe(9);
  });

  it('follows the most recent explicit settings change in either direction', () => {
    const older = makeData({ settingsUpdatedAt: 100 });
    older.settings.activeTables = [2, 5];
    const newer = makeData({ settingsUpdatedAt: 200 });
    newer.settings.activeTables = [2, 3, 5, 10];

    expect(mergePayloads(toPayload(older), toPayload(newer)).settings.activeTables).toEqual([2, 3, 5, 10]);
    expect(mergePayloads(toPayload(newer), toPayload(older)).settings.activeTables).toEqual([2, 3, 5, 10]);
    expect(mergePayloads(toPayload(older), toPayload(newer)).settingsUpdatedAt).toBe(200);
  });

  it('unions presets and lets the newer side win duplicate ids', () => {
    const local = makeData({ settingsUpdatedAt: 200 });
    local.presets = [
      { id: 'restaurant-test', name: 'Restaurant test renamed', config: local.presets[0].config },
      { id: 'gate', name: 'Screen time', config: local.presets[0].config },
    ];
    const remote = makeData({ settingsUpdatedAt: 100 });
    remote.presets = [
      { id: 'restaurant-test', name: 'Restaurant test', config: remote.presets[0].config },
      { id: 'weekend', name: 'Weekend big one', config: remote.presets[0].config },
    ];

    const merged = mergePayloads(toPayload(local), toPayload(remote));
    const names = new Map(merged.presets.map((preset) => [preset.id, preset.name]));
    expect(names.get('restaurant-test')).toBe('Restaurant test renamed');
    expect(names.get('gate')).toBe('Screen time');
    expect(names.get('weekend')).toBe('Weekend big one');
  });
});

describe('parseRemoteBody', () => {
  it('treats an empty store as no payload', () => {
    expect(parseRemoteBody({ version: 0, data: null })).toEqual({ version: 0, payload: null, fromNewerApp: false });
  });

  it('accepts a valid payload', () => {
    const payload: SyncPayload = toPayload(makeData());
    const parsed = parseRemoteBody({ version: 4, data: payload });
    expect(parsed.version).toBe(4);
    expect(parsed.payload).not.toBeNull();
    expect(parsed.fromNewerApp).toBe(false);
  });

  it('flags payloads written by a newer app instead of merging them', () => {
    const parsed = parseRemoteBody({ version: 4, data: { payloadVersion: 2 } });
    expect(parsed.payload).toBeNull();
    expect(parsed.fromNewerApp).toBe(true);
  });

  it('ignores malformed payloads', () => {
    const parsed = parseRemoteBody({ version: 4, data: { hello: 'danny' } });
    expect(parsed.payload).toBeNull();
    expect(parsed.fromNewerApp).toBe(false);
  });
});
