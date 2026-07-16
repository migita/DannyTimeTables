export type FactKey = `${number}x${number}`;

export type MemoryLabel = 'New' | 'Learning' | 'Remembering' | 'Fast' | 'Secure';

export type AttemptSource = 'learn' | 'practice' | 'test';

export interface FactAttempt {
  at: number;
  correct: boolean;
  independent: boolean;
  responseMs: number;
  sessionId: string;
  source: AttemptSource;
}

export interface FactProgress {
  key: FactKey;
  factorA: number;
  factorB: number;
  attempts: number;
  independentCorrect: number;
  mistakes: number;
  currentStreak: number;
  stabilityHours: number;
  difficulty: number;
  lastReviewedAt: number | null;
  lastCorrectAt: number | null;
  lastWrongAt: number | null;
  nextReviewAt: number | null;
  averageResponseMs: number | null;
  correctSessionIds: string[];
  recentAttempts: FactAttempt[];
}

/** Legacy summaries from the separate practice mode; kept for old backups and older devices on the same family code. */
export interface PracticeSessionSummary {
  id: string;
  mode: 'learn' | 'practice';
  startedAt: number;
  finishedAt: number;
  answered: number;
  independentCorrect: number;
  target: number | null;
  factKeys: FactKey[];
}

export type QuestionKind = 'multiplication' | 'division';

export interface TestConfig {
  tables: number[];
  questionCount: number;
  passMode: 'count' | 'percent';
  passValue: number;
  includeDivision: boolean;
}

/** Legacy named test configs; kept in stored data so older devices on the same family code keep working. */
export interface TestPreset {
  id: string;
  name: string;
  config: TestConfig;
}

export interface TestQuestion {
  id: string;
  kind: QuestionKind;
  left: number;
  right: number;
  operator: '×' | '÷';
  answer: number;
  factKey: FactKey;
  table: number;
}

export interface TestAnswer {
  questionId: string;
  answer: number;
  correct: boolean;
  responseMs: number;
}

export interface TestResult {
  id: string;
  presetName: string | null;
  config: TestConfig;
  startedAt: number;
  finishedAt: number;
  status: 'passed' | 'failed' | 'abandoned';
  correct: number;
  answered: number;
  answers: TestAnswer[];
  questions: TestQuestion[];
}

/** How each session runs: an optional warm-up, then the scored questions. */
export interface SessionConfig {
  questionCount: number;
  passMode: 'count' | 'percent';
  passValue: number;
  includeDivision: boolean;
  warmUpCount: number;
}

export interface Settings {
  activeTables: number[];
  session: SessionConfig;
  soundEnabled: boolean;
}

/** One asked-and-answered question inside a session. */
export interface SessionRecord {
  id: string;
  factKey: FactKey;
  kind: QuestionKind;
  left: number;
  right: number;
  operator: '×' | '÷';
  answer: number;
  given: number;
  correct: boolean;
  responseMs: number;
}

/**
 * A session in progress, persisted after every answer so a closed tab can be
 * resumed (or recorded honestly as abandoned).
 */
export interface ActiveSession {
  id: string;
  startedAt: number;
  config: TestConfig;
  warmUpQueue: FactKey[];
  answered: number;
  correct: number;
  introduced: number;
  recent: FactKey[];
  retries: RetryItem[];
  records: SessionRecord[];
  /** Non-null when fixing test misses: remaining facts, re-queued until answered independently. */
  fixQueue: FactKey[] | null;
}

export interface SyncSettings {
  familyCode: string;
  lastSyncedAt: number | null;
}

export interface AppData {
  version: 5;
  settings: Settings;
  settingsUpdatedAt: number;
  sync: SyncSettings | null;
  facts: Record<string, FactProgress>;
  practiceHistory: PracticeSessionSummary[];
  testHistory: TestResult[];
  presets: TestPreset[];
  activeSession: ActiveSession | null;
}

export interface RetryItem {
  factKey: FactKey;
  dueAfter: number;
}
