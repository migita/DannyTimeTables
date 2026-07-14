export type FactKey = `${number}x${number}`;

export type MemoryLabel = 'New' | 'Learning' | 'Remembering' | 'Fast' | 'Secure';

export type AttemptSource = 'learn' | 'practice';

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

export interface ActiveTest {
  id: string;
  presetName: string | null;
  config: TestConfig;
  seed: number;
  startedAt: number;
  questions: TestQuestion[];
  answers: TestAnswer[];
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

export interface Settings {
  activeTables: number[];
  practiceTarget: 10 | 20 | 30 | null;
  soundEnabled: boolean;
}

export interface SyncSettings {
  familyCode: string;
  lastSyncedAt: number | null;
}

export interface AppData {
  version: 3;
  settings: Settings;
  settingsUpdatedAt: number;
  sync: SyncSettings | null;
  facts: Record<string, FactProgress>;
  practiceHistory: PracticeSessionSummary[];
  testHistory: TestResult[];
  presets: TestPreset[];
  activeTest: ActiveTest | null;
}

export interface RetryItem {
  factKey: FactKey;
  dueAfter: number;
}
