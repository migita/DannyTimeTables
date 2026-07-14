import type {
  AppData,
  FactProgress,
  PracticeSessionSummary,
  Settings,
  TestPreset,
  TestResult,
} from './types';

export const SYNC_ENDPOINT = 'https://danny-times-sync.migita.workers.dev/v1/data';
export const MIN_FAMILY_CODE_LENGTH = 4;
const HISTORY_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The slice of AppData shared between devices. Device-local state (the sync
 * credentials themselves and any half-finished strict test) never travels.
 */
export interface SyncPayload {
  payloadVersion: 1;
  settings: Settings;
  settingsUpdatedAt: number;
  facts: Record<string, FactProgress>;
  practiceHistory: PracticeSessionSummary[];
  testHistory: TestResult[];
  presets: TestPreset[];
}

export interface RemoteState {
  version: number;
  payload: SyncPayload | null;
  fromNewerApp: boolean;
}

export type PushResult =
  | { ok: true; version: number }
  | { ok: false; conflict: boolean; status: number };

export function toPayload(data: AppData): SyncPayload {
  return {
    payloadVersion: 1,
    settings: { ...data.settings, activeTables: [...data.settings.activeTables] },
    settingsUpdatedAt: data.settingsUpdatedAt,
    facts: data.facts,
    practiceHistory: data.practiceHistory,
    testHistory: data.testHistory,
    presets: data.presets,
  };
}

/**
 * Union-style merge so nothing a child earned can be lost by a slow device:
 * histories merge by id, facts keep whichever side saw the fact last, and
 * whole-object settings follow the most recent explicit change.
 */
export function mergePayloads(local: SyncPayload, remote: SyncPayload): SyncPayload {
  const newer = remote.settingsUpdatedAt > local.settingsUpdatedAt ? remote : local;
  return {
    payloadVersion: 1,
    settings: { ...newer.settings, activeTables: [...newer.settings.activeTables] },
    settingsUpdatedAt: Math.max(local.settingsUpdatedAt, remote.settingsUpdatedAt),
    facts: mergeFacts(local.facts, remote.facts),
    practiceHistory: mergeById(local.practiceHistory, remote.practiceHistory),
    testHistory: mergeById(local.testHistory, remote.testHistory),
    presets: mergePresets(local.presets, remote.presets, newer === remote),
  };
}

export function applyPayload(data: AppData, payload: SyncPayload): AppData {
  return {
    ...data,
    settings: payload.settings,
    settingsUpdatedAt: payload.settingsUpdatedAt,
    facts: payload.facts,
    practiceHistory: payload.practiceHistory,
    testHistory: payload.testHistory,
    presets: payload.presets,
  };
}

export function samePayload(first: SyncPayload, second: SyncPayload): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function mergeFacts(
  local: Record<string, FactProgress>,
  remote: Record<string, FactProgress>,
): Record<string, FactProgress> {
  const merged: Record<string, FactProgress> = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    merged[key] = pickFact(local[key], remote[key])!;
  }
  return merged;
}

function pickFact(local?: FactProgress, remote?: FactProgress): FactProgress | undefined {
  if (!local) return remote;
  if (!remote) return local;
  const localSeen = local.lastReviewedAt ?? 0;
  const remoteSeen = remote.lastReviewedAt ?? 0;
  if (localSeen !== remoteSeen) return localSeen > remoteSeen ? local : remote;
  return remote.attempts > local.attempts ? remote : local;
}

function mergeById<T extends { id: string; finishedAt: number }>(local: T[], remote: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of remote) byId.set(item.id, item);
  for (const item of local) byId.set(item.id, item);
  return [...byId.values()]
    .sort((first, second) => first.finishedAt - second.finishedAt)
    .slice(-HISTORY_LIMIT);
}

function mergePresets(local: TestPreset[], remote: TestPreset[], remoteIsNewer: boolean): TestPreset[] {
  const primary = remoteIsNewer ? remote : local;
  const secondary = remoteIsNewer ? local : remote;
  const byId = new Map<string, TestPreset>();
  for (const preset of secondary) byId.set(preset.id, preset);
  for (const preset of primary) byId.set(preset.id, preset);
  return [...byId.values()];
}

export function parseRemoteBody(body: unknown): RemoteState {
  if (typeof body !== 'object' || body === null) {
    return { version: 0, payload: null, fromNewerApp: false };
  }
  const record = body as Record<string, unknown>;
  const version = Number.isInteger(record.version) && (record.version as number) >= 0
    ? record.version as number
    : 0;
  if (record.data === null || record.data === undefined) {
    return { version, payload: null, fromNewerApp: false };
  }
  if (isSyncPayload(record.data)) {
    return { version, payload: record.data, fromNewerApp: false };
  }
  const claimed = (record.data as Record<string, unknown> | null)?.payloadVersion;
  return { version, payload: null, fromNewerApp: typeof claimed === 'number' && claimed > 1 };
}

function isSyncPayload(value: unknown): value is SyncPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const settings = record.settings as Record<string, unknown> | undefined;
  return (
    record.payloadVersion === 1 &&
    typeof record.settingsUpdatedAt === 'number' &&
    typeof settings === 'object' && settings !== null && Array.isArray(settings.activeTables) &&
    typeof record.facts === 'object' && record.facts !== null &&
    Array.isArray(record.practiceHistory) &&
    Array.isArray(record.testHistory) &&
    Array.isArray(record.presets)
  );
}

export class SyncError extends Error {}

export class SyncClient {
  constructor(
    private readonly familyCode: string,
    private readonly endpoint: string = SYNC_ENDPOINT,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async pull(): Promise<RemoteState> {
    const response = await this.request('GET');
    if (response.status === 401) throw new SyncError('Wrong family code.');
    if (!response.ok) throw new SyncError('The family cloud is not answering.');
    return parseRemoteBody(await response.json());
  }

  async push(payload: SyncPayload, version: number): Promise<PushResult> {
    const response = await this.request('PUT', {
      body: JSON.stringify(payload),
      headers: { 'If-Match': `"${version}"`, 'Content-Type': 'application/json' },
    });
    if (response.status === 401) throw new SyncError('Wrong family code.');
    if (response.status === 412) return { ok: false, conflict: true, status: 412 };
    if (!response.ok) return { ok: false, conflict: false, status: response.status };
    const body = await response.json() as { version?: number };
    return { ok: true, version: Number(body.version) || version + 1 };
  }

  async wipe(): Promise<void> {
    const response = await this.request('DELETE');
    if (!response.ok) throw new SyncError('Could not clear the family cloud copy.');
  }

  private async request(method: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(this.endpoint, {
        method,
        body: init.body,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.familyCode}`,
          ...init.headers,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
