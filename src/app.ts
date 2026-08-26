import { playAnswerSound } from './core/audio';
import {
  ALL_TABLES,
  BEYOND_CORE_TABLES,
  CORE_TABLES,
  explanationForFact,
  factsForTables,
  parseFactKey,
  type FactDescriptor,
} from './core/facts';
import {
  memoryLabel,
  newFactProgress,
  recallProbability,
  recordAnswer,
  weaknessScore,
} from './core/memory';
import { choosePracticeFact, pickWarmUpFacts, scheduleRetry, type ScheduledFact } from './core/scheduler';
import {
  presentQuestion,
  randomFlip,
  requiredCorrect,
  sessionResult,
  timeLimitMs,
  warmUpRetries,
  type PresentedQuestion,
} from './core/session';
import {
  QUESTION_COUNTS,
  TIME_LIMITS,
  WARM_UP_COUNTS,
  ensureSettings,
  exportData,
  importData,
  loadData,
  resetData,
  saveData,
} from './core/storage';
import {
  MIN_FAMILY_CODE_LENGTH,
  SyncClient,
  SyncError,
  applyPayload,
  mergePayloads,
  samePayload,
  toPayload,
} from './core/sync';
import type {
  ActiveSession,
  AppData,
  AttemptSource,
  FactKey,
  MemoryLabel,
  SessionConfig,
  TestResult,
} from './core/types';
import {
  clamp,
  escapeHtml,
  formatAgo,
  formatDate,
  icon,
  refreshIcons,
  renderFactVisual,
  renderKeypad,
  renderProgressBar,
} from './ui/components';

type Screen = 'home' | 'session' | 'result' | 'parent';

const PIN_LENGTH = 4;

/** The grown-up code is today's date as MMDD (device clock), so it changes daily and nothing needs storing. */
export function parentPin(now = new Date()): string {
  return `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}
type ParentTab = 'progress' | 'settings';
type SessionPhase = 'look' | 'try' | 'answer' | 'right' | 'correction' | 'corrected' | 'done';

interface SessionView {
  phase: SessionPhase;
  fixing: boolean;
  warmFact: FactDescriptor | null;
  warmMissed: boolean;
  current: (ScheduledFact & { presented: PresentedQuestion }) | null;
  input: string;
  questionStartedAt: number;
  /** Set while the question clock is stopped (tab hidden, or the end-session prompt is open). */
  pausedAt: number | null;
  /** The current question was settled by the time limit rather than an answer. */
  timedOut: boolean;
}

export class App {
  private data: AppData;
  private screen: Screen;
  private parentTab: ParentTab = 'progress';
  private progressTable: number;
  private session: SessionView | null = null;
  private latestResult: TestResult | null = null;
  private gateOpen = false;
  private pinInput = '';
  private pinWrong = false;
  private resumePrompt = false;
  private abandonPrompt = false;
  private resetPrompt = false;
  private factDialogKey: FactKey | null = null;
  private toast = '';
  private transitionTimer: number | null = null;
  private questionTimer: number | null = null;
  private toastTimer: number | null = null;
  private syncStatus: 'idle' | 'syncing' | 'ok' | 'offline' | 'error' = 'idle';
  private syncBusy = false;
  private syncQueued = false;
  private syncDebounce: number | null = null;

  constructor(private readonly root: HTMLElement) {
    this.data = loadData();
    this.progressTable = this.data.settings.activeTables[0] ?? 2;
    this.screen = 'home';
    this.resumePrompt = this.data.activeSession !== null;

    this.root.addEventListener('click', (event) => this.handleClick(event));
    this.root.addEventListener('change', (event) => void this.handleChange(event));
    window.addEventListener('keydown', (event) => this.handleKeydown(event));
    window.addEventListener('online', () => void this.syncNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushPendingSync();
      if (this.screen === 'session' && this.session) {
        this.syncQuestionClock();
        this.render();
      }
    });
    this.render();
    if (this.data.sync) void this.syncNow();
  }

  private render(): void {
    document.body.dataset.screen = this.screen;
    let content: string;
    switch (this.screen) {
      case 'session':
        content = this.renderSession();
        break;
      case 'result':
        content = this.renderResult();
        break;
      case 'parent':
        content = this.renderParent();
        break;
      default:
        content = this.renderHome();
    }

    this.root.innerHTML = `
      ${content}
      ${this.renderOverlays()}
      ${this.toast ? `<div class="toast" role="status">${escapeHtml(this.toast)}</div>` : ''}
    `;
    refreshIcons();
  }

  private handleClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    switch (action) {
      case 'start-session':
        this.startSession();
        break;
      case 'open-parent-gate':
        this.gateOpen = true;
        this.pinInput = '';
        this.pinWrong = false;
        this.render();
        break;
      case 'close-gate':
        this.closeGate();
        break;
      case 'pin-key':
        this.appendPin(target.dataset.key ?? '');
        break;
      case 'pin-backspace':
        this.pinInput = this.pinInput.slice(0, -1);
        this.pinWrong = false;
        this.render();
        break;
      case 'home':
        this.goHome();
        break;
      case 'warmup-try':
        if (this.session?.phase === 'look') {
          this.session.phase = 'try';
          this.session.input = '';
          this.session.questionStartedAt = Date.now();
          this.render();
        }
        break;
      case 'key':
        this.appendAnswer(target.dataset.key ?? '');
        break;
      case 'backspace':
        this.backspaceAnswer();
        break;
      case 'submit-answer':
        this.submitCurrentAnswer();
        break;
      case 'parent-tab':
        this.parentTab = target.dataset.tab as ParentTab;
        this.render();
        break;
      case 'toggle-table':
        this.toggleTable(Number(target.dataset.table));
        break;
      case 'set-table-group':
        this.setTableGroup(target.dataset.group ?? 'all');
        break;
      case 'set-session-count':
        this.setSessionCount(Number(target.dataset.value));
        break;
      case 'set-pass-mode':
        this.setPassMode(target.dataset.value as SessionConfig['passMode']);
        break;
      case 'step-pass':
        this.stepPass(Number(target.dataset.amount));
        break;
      case 'toggle-division':
        this.data.settings.session.includeDivision = !this.data.settings.session.includeDivision;
        this.touchSettings();
        this.persist();
        this.render();
        break;
      case 'set-warmup':
        this.setWarmUpCount(Number(target.dataset.value));
        break;
      case 'set-time-limit':
        this.setTimeLimit(Number(target.dataset.value));
        break;
      case 'toggle-sound':
        this.data.settings.soundEnabled = !this.data.settings.soundEnabled;
        this.touchSettings();
        this.persist();
        this.render();
        if (this.data.settings.soundEnabled) playAnswerSound(true);
        break;
      case 'enable-sync':
        this.enableSync();
        break;
      case 'disable-sync':
        this.data.sync = null;
        this.syncStatus = 'idle';
        this.persist();
        this.render();
        break;
      case 'sync-now':
        void this.syncNow(true);
        break;
      case 'select-progress-table':
        this.progressTable = Number(target.dataset.table);
        this.render();
        break;
      case 'inspect-fact':
        this.factDialogKey = target.dataset.key as FactKey;
        this.render();
        break;
      case 'close-fact':
        this.factDialogKey = null;
        this.render();
        break;
      case 'session-exit':
        this.exitSession();
        break;
      case 'cancel-abandon':
        this.abandonPrompt = false;
        this.syncQuestionClock();
        this.render();
        break;
      case 'confirm-abandon':
        this.confirmAbandon();
        break;
      case 'resume-session':
        this.resumeSession();
        break;
      case 'new-session':
        this.startSession();
        break;
      case 'fix-misses': {
        const result = this.latestResult ?? this.data.testHistory.at(-1);
        if (result) this.startFixSession(result);
        break;
      }
      case 'export-data':
        this.downloadBackup();
        break;
      case 'ask-reset':
        this.resetPrompt = true;
        this.render();
        break;
      case 'cancel-reset':
        this.resetPrompt = false;
        this.render();
        break;
      case 'confirm-reset':
        this.confirmReset();
        break;
    }
  }

  private async handleChange(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    if (target.dataset.action === 'pass-value') {
      const session = this.data.settings.session;
      const max = session.passMode === 'count' ? session.questionCount : 100;
      session.passValue = clamp(Math.round(target.valueAsNumber || 0), 1, max);
      this.touchSettings();
      this.persist();
      this.render();
    }
    if (target.dataset.action === 'import-file' && target.files?.[0]) {
      try {
        this.data = importData(await target.files[0].text());
        this.progressTable = this.data.settings.activeTables[0] ?? 2;
        this.persist();
        this.showToast('Backup imported');
      } catch (error) {
        this.showToast(error instanceof Error ? error.message : 'Could not import that backup');
      }
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (this.gateOpen) {
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        this.appendPin(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        this.pinInput = this.pinInput.slice(0, -1);
        this.pinWrong = false;
        this.render();
      } else if (event.key === 'Escape') {
        this.closeGate();
      }
      return;
    }
    if (this.hasBlockingOverlay()) return;
    const element = event.target as HTMLElement;
    if (element.matches('input, textarea, select')) return;
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      this.appendAnswer(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      this.backspaceAnswer();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.submitCurrentAnswer();
    }
  }

  private renderHome(): string {
    const session = this.data.settings.session;
    const activeFacts = factsForTables(this.data.settings.activeTables);
    const labelCounts = activeFacts.reduce<Record<MemoryLabel, number>>((counts, fact) => {
      counts[memoryLabel(this.data.facts[fact.key])] += 1;
      return counts;
    }, { New: 0, Learning: 0, Remembering: 0, Fast: 0, Secure: 0 });
    const growing = labelCounts.Remembering + labelCounts.Fast + labelCounts.Secure;
    const finishedSessions = this.data.testHistory.filter((result) => result.status !== 'abandoned').length;
    const needed = requiredCorrect(session);

    return `
      <main class="home-shell">
        <header class="home-header">
          <div class="brand" aria-label="Danny Times">
            <span class="brand-mark"><b>2</b><b>×</b><b>5</b></span>
            <span>Danny Times</span>
          </div>
          <button class="icon-button" type="button" data-action="open-parent-gate" aria-label="Grown-up area" title="Grown-up area">
            ${icon('lock-keyhole')}
          </button>
        </header>

        <section class="home-intro">
          <p class="eyebrow">Today</p>
          <h1>Ready, Daniel?</h1>
          <div class="active-table-row" aria-label="Active tables">
            ${this.data.settings.activeTables.length === ALL_TABLES.length
              ? '<span class="wide-table-badge">1–12</span>'
              : this.data.settings.activeTables.map((table) => `<span>${table}</span>`).join('')}
          </div>
        </section>

        <section class="mode-grid single-mode" aria-label="Start">
          <button class="mode-card practice-card" type="button" data-action="start-session">
            <span class="mode-visual target-visual" aria-hidden="true"><b>${session.questionCount}</b></span>
            <span class="mode-copy">
              <small>${session.warmUpCount > 0 ? 'Warm-up, then ' : ''}${session.questionCount} questions · ${needed} to pass${session.timeLimitSeconds ? ` · ${session.timeLimitSeconds} s each` : ''}</small>
              <strong>Start</strong>
            </span>
            ${icon('chevron-right')}
          </button>
        </section>

        <section class="home-tables" aria-label="Your tables">
          ${this.data.settings.activeTables.map((table) => {
            const percent = this.tableProgressPercent(table);
            return `
              <div class="home-table">
                <span>${table}×</span>
                <i aria-label="${table} times table ${percent}% learned"><b style="width:${percent}%"></b></i>
              </div>
            `;
          }).join('')}
        </section>

        <section class="home-progress" aria-label="Learning progress">
          <div><strong>${growing}</strong><span>growing</span></div>
          <div><strong>${labelCounts.Secure}</strong><span>secure</span></div>
          <div><strong>${finishedSessions}</strong><span>sessions</span></div>
        </section>

        <p class="app-version">v${__APP_VERSION__}</p>
      </main>
    `;
  }

  private renderSession(): string {
    const active = this.data.activeSession;
    const view = this.session;
    if (!view || (!active && view.phase !== 'done')) return this.renderHome();

    if (view.phase === 'done') {
      return `
        <main class="child-shell practice-shell complete-shell">
          ${this.renderChildHeader('Fix the misses', 'home')}
          <section class="session-complete complete-right">
            <span class="result-symbol">${icon('check')}</span>
            <p class="eyebrow">Misses fixed</p>
            <h1>All sorted</h1>
            <div class="complete-actions">
              <button class="primary-button practice-button" type="button" data-action="home">${icon('home')} Home</button>
            </div>
          </section>
        </main>
      `;
    }

    if (view.phase === 'look' || view.phase === 'try') {
      return this.renderWarmUp(view);
    }

    return this.renderQuestions(active!, view);
  }

  private renderWarmUp(view: SessionView): string {
    const fact = view.warmFact!;
    const explanation = explanationForFact(fact.factorA, fact.factorB);
    const question = `${fact.factorA} × ${fact.factorB}`;

    if (view.phase === 'look') {
      return `
        <main class="child-shell learn-shell">
          ${this.renderChildHeader('Warm-up', 'session-exit')}
          <section class="lesson-stage">
            <p class="eyebrow">${question}</p>
            <h1>${escapeHtml(explanation.title)}</h1>
            <div class="fact-visual-wrap">${renderFactVisual(fact.factorA, fact.factorB)}</div>
            <p class="lesson-short">${escapeHtml(explanation.short)}</p>
            <p class="lesson-equation">${escapeHtml(explanation.equation)}</p>
          </section>
          <footer class="lesson-footer">
            <button class="primary-button learn-button" type="button" data-action="warmup-try">Try it ${icon('chevron-right')}</button>
          </footer>
        </main>
      `;
    }

    return `
      <main class="child-shell learn-shell question-shell">
        ${this.renderChildHeader('Warm-up', 'session-exit')}
        <section class="question-stage">
          <div class="compact-visual">${renderFactVisual(fact.factorA, fact.factorB)}</div>
          ${view.warmMissed ? `
            <div class="correction-copy" role="status">
              <strong>${fact.factorA} groups of ${fact.factorB} make ${fact.answer}</strong>
              <span>Type ${fact.answer}</span>
            </div>
          ` : ''}
          <div class="equation ${view.warmMissed ? 'equation-small' : ''}">
            <span>${question}</span><span>=</span><output aria-label="Your answer">${view.input || '?'}</output>
          </div>
        </section>
        ${renderKeypad(view.input)}
      </main>
    `;
  }

  private renderQuestions(active: ActiveSession, view: SessionView): string {
    const current = view.current;
    if (!current) return this.renderHome();
    const total = active.config.questionCount;
    const currentNumber = view.phase === 'answer' ? active.answered + 1 : active.answered;
    const remainingFixes = view.fixing
      ? (active.fixQueue?.length ?? 0)
      : 0;
    const progress = view.fixing
      ? `<div class="child-progress open-progress"><span>${remainingFixes} to fix</span></div>`
      : `<div class="child-progress"><span>${Math.min(currentNumber, total)} / ${total}</span>${renderProgressBar(active.answered, total, 'Session progress')}</div>`;
    const correction = view.phase === 'correction' || view.phase === 'corrected';
    const feedback = view.phase === 'right' || view.phase === 'corrected';
    const presented = current.presented;
    const correctionCopy = presented.kind === 'division'
      ? `<p><strong>${presented.left} shared into ${presented.right}s makes ${presented.answer}</strong><span>Type ${presented.answer}</span></p>`
      : `<p><strong>${current.factorA} groups of ${current.factorB} make ${presented.answer}</strong><span>Type the correct answer</span></p>`;
    const limitMs = timeLimitMs(active.config);

    return `
      <main class="child-shell practice-shell question-shell">
        ${this.renderChildHeader(view.fixing ? 'Fix the misses' : 'Questions', 'session-exit')}
        ${progress}
        <section class="question-stage ${feedback ? 'has-feedback' : ''}">
          ${correction ? `
            <div class="practice-correction" role="status">
              <div class="compact-visual">${renderFactVisual(current.factorA, current.factorB)}</div>
              ${correctionCopy}
            </div>
          ` : ''}
          <div class="equation ${correction ? 'equation-small' : ''}">
            <span>${presented.left} ${presented.operator} ${presented.right}</span><span>=</span>
            <output aria-label="Your answer">${view.phase === 'right' ? presented.answer : view.input || '?'}</output>
          </div>
          ${limitMs ? this.renderTimeTrack(limitMs, active, view) : ''}
          ${view.phase === 'right' ? '<p class="answer-feedback right-feedback" role="status">Yes</p>' : ''}
          ${view.phase === 'correction' && view.timedOut ? '<p class="answer-feedback timeout-feedback" role="status">Out of time</p>' : ''}
          ${view.phase === 'corrected' ? '<p class="answer-feedback right-feedback" role="status">That’s it</p>' : ''}
        </section>
        ${renderKeypad(view.input, feedback)}
      </main>
    `;
  }

  /**
   * The countdown is a CSS animation started at a negative delay, so it stays
   * in the right place across the full re-render every keypress causes. Once
   * the question is settled the bar freezes where the answer landed.
   */
  private renderTimeTrack(limitMs: number, active: ActiveSession, view: SessionView): string {
    const answering = view.phase === 'answer';
    const elapsed = answering
      ? (view.pausedAt ?? Date.now()) - view.questionStartedAt
      : active.records.at(-1)?.responseMs ?? 0;
    const offset = clamp(elapsed, 0, limitMs);
    return `
      <div class="time-track ${answering && view.pausedAt === null ? 'is-running' : ''}" aria-hidden="true">
        <span style="animation-duration:${limitMs}ms;animation-delay:-${offset}ms"></span>
      </div>
    `;
  }

  private renderChildHeader(title: string, backAction: string): string {
    return `
      <header class="child-header">
        <button class="icon-button" type="button" data-action="${backAction}" aria-label="Go back">${icon('arrow-left')}</button>
        <strong>${escapeHtml(title)}</strong>
        <span class="header-spacer"></span>
      </header>
    `;
  }

  private renderResult(): string {
    const result = this.latestResult ?? this.data.testHistory.at(-1);
    if (!result || result.status === 'abandoned') return this.renderHome();
    const passed = result.status === 'passed';
    const needed = requiredCorrect(result.config);
    const limit = result.config.timeLimitSeconds ?? 0;
    const missed = result.questions.filter((question) => {
      const answer = result.answers.find((item) => item.questionId === question.id);
      return answer && !answer.correct;
    });

    return `
      <main class="result-shell ${passed ? 'pass-result' : 'fail-result'}">
        <header class="result-header"><span>Danny Times</span><strong>${escapeHtml(result.presetName ?? 'Session')}</strong></header>
        <section class="result-main">
          <span class="result-stamp">${passed ? icon('shield-check') : icon('rotate-ccw')}</span>
          <p class="result-word">${passed ? 'PASS' : 'NOT YET'}</p>
          <h1>${result.correct} / ${result.config.questionCount} correct</h1>
          <p class="pass-line">Pass mark ${needed}${limit ? ` · ${limit} s per question` : ''}</p>
          <p class="result-time">Finished ${formatDate(result.finishedAt)}</p>
        </section>
        <section class="result-details">
          <div class="result-metrics">
            <div><strong>${result.config.questionCount - result.correct}</strong><span>missed</span></div>
            <div><strong>${Math.round(result.correct / result.config.questionCount * 100)}%</strong><span>score</span></div>
            <div><strong>${result.config.tables.join(', ')}</strong><span>tables</span></div>
          </div>
          ${missed.length ? `
            <details class="missed-details">
              <summary>Review ${missed.length} missed ${missed.length === 1 ? 'question' : 'questions'}</summary>
              <div>${missed.map((question) => {
                const answer = result.answers.find((item) => item.questionId === question.id)!;
                const given = answer.answer === null
                  ? `<span class="out-of-time" role="img" aria-label="Out of time">${icon('clock-3')}</span>`
                  : `<s>${answer.answer}</s>`;
                return `<p><span>${question.left} ${question.operator} ${question.right}</span>${given}<strong>${question.answer}</strong></p>`;
              }).join('')}</div>
            </details>
          ` : ''}
          <div class="result-actions">
            ${missed.length ? `<button class="${passed ? 'secondary-button' : 'primary-button test-button'}" type="button" data-action="fix-misses">${icon('brain')} Fix the ${missed.length === 1 ? 'miss' : 'misses'}</button>` : ''}
            ${!passed ? `<button class="secondary-button" type="button" data-action="new-session">${icon('rotate-ccw')} New session</button>` : ''}
            <button class="${passed ? 'primary-button test-button' : 'secondary-button'}" type="button" data-action="home">${icon('home')} Home</button>
          </div>
        </section>
      </main>
    `;
  }

  private renderParent(): string {
    const tabs: Array<{ id: ParentTab; label: string; iconName: string }> = [
      { id: 'progress', label: 'Progress', iconName: 'bar-chart-3' },
      { id: 'settings', label: 'Settings', iconName: 'settings' },
    ];
    const view = this.parentTab === 'progress' ? this.renderProgressView() : this.renderSettingsView();

    return `
      <main class="parent-shell">
        <header class="parent-header">
          <button class="icon-button" type="button" data-action="home" aria-label="Home">${icon('arrow-left')}</button>
          <div><span>Grown-ups</span><strong>Danny Times</strong></div>
          <span class="header-spacer"></span>
        </header>
        <nav class="parent-tabs" aria-label="Grown-up area">
          ${tabs.map((tab) => `
            <button type="button" class="${this.parentTab === tab.id ? 'active' : ''}" data-action="parent-tab" data-tab="${tab.id}">
              ${icon(tab.iconName)}<span>${tab.label}</span>
            </button>
          `).join('')}
        </nav>
        <div class="parent-view">${view}</div>
      </main>
    `;
  }

  private renderProgressView(): string {
    const allFacts = factsForTables(this.data.settings.activeTables);
    const learned = allFacts.filter((fact) => memoryLabel(this.data.facts[fact.key]) !== 'New').length;
    const secure = allFacts.filter((fact) => memoryLabel(this.data.facts[fact.key]) === 'Secure').length;
    const due = allFacts.filter((fact) => {
      const progress = this.data.facts[fact.key];
      return progress?.nextReviewAt !== null && progress?.nextReviewAt !== undefined && progress.nextReviewAt <= Date.now();
    }).length;
    const selectedFacts = factsForTables([this.progressTable]);
    const weakFacts = allFacts
      .filter((fact) => this.data.facts[fact.key]?.attempts)
      .sort((a, b) => weaknessScore(this.data.facts[b.key]) - weaknessScore(this.data.facts[a.key]))
      .slice(0, 5);
    const slowFacts = allFacts
      .filter((fact) => {
        const progress = this.data.facts[fact.key];
        return progress && progress.independentCorrect > 0 && (progress.averageResponseMs ?? 0) >= 6000;
      })
      .sort((a, b) => (this.data.facts[b.key].averageResponseMs ?? 0) - (this.data.facts[a.key].averageResponseMs ?? 0))
      .slice(0, 4);
    const oftenMissed = allFacts
      .filter((fact) => (this.data.facts[fact.key]?.mistakes ?? 0) >= 2)
      .sort((a, b) => this.data.facts[b.key].mistakes - this.data.facts[a.key].mistakes)
      .slice(0, 4);
    const recentlySecure = allFacts
      .filter((fact) => memoryLabel(this.data.facts[fact.key]) === 'Secure')
      .sort((a, b) => (this.data.facts[b.key].lastCorrectAt ?? 0) - (this.data.facts[a.key].lastCorrectAt ?? 0))
      .slice(0, 4);
    const recentSessions = this.data.testHistory.slice(-5).reverse();

    return `
      <section class="parent-section progress-overview">
        <div class="section-heading">
          <div><p class="eyebrow">Overview</p><h1>Progress</h1></div>
        </div>
        <div class="metric-row">
          <div><strong>${learned}</strong><span>started</span></div>
          <div><strong>${secure}</strong><span>secure</span></div>
          <div><strong>${due}</strong><span>ready now</span></div>
        </div>
      </section>

      <section class="parent-section table-progress-section">
        <div class="section-heading"><div><p class="eyebrow">By table</p><h2>Memory map</h2></div></div>
        <div class="table-summary-row">
          ${this.data.settings.activeTables.map((table) => {
            const percent = this.tableProgressPercent(table);
            return `
              <button type="button" class="table-summary ${table === this.progressTable ? 'active' : ''}" data-action="select-progress-table" data-table="${table}">
                <strong>${table}×</strong><span>${percent}%</span><i><b style="width:${percent}%"></b></i>
              </button>
            `;
          }).join('')}
        </div>
        <div class="fact-grid" aria-label="${this.progressTable} times table facts">
          ${selectedFacts.map((fact) => {
            const label = memoryLabel(this.data.facts[fact.key]);
            return `
              <button type="button" class="fact-cell state-${label.toLowerCase()}" data-action="inspect-fact" data-key="${fact.key}" aria-label="${fact.factorA} times ${fact.factorB}: ${label}">
                <span>${fact.factorA}×${fact.factorB}</span><strong>${fact.answer}</strong><i>${label}</i>
              </button>
            `;
          }).join('')}
        </div>
        <div class="memory-legend" aria-label="Memory states">
          ${(['New', 'Learning', 'Remembering', 'Fast', 'Secure'] as MemoryLabel[]).map((label) => `<span class="state-${label.toLowerCase()}"><i></i>${label}</span>`).join('')}
        </div>
      </section>

      <section class="parent-section insight-section">
        <div class="section-heading"><div><p class="eyebrow">Attention</p><h2>Useful next facts</h2></div></div>
        ${weakFacts.length ? `
          <div class="fact-list">
            ${weakFacts.map((fact) => {
              const progress = this.data.facts[fact.key];
              const recall = Math.round(recallProbability(progress) * 100);
              const reason = progress.lastWrongAt && Date.now() - progress.lastWrongAt < 7 * 86_400_000
                ? 'recent mistake'
                : progress.mistakes > 0 ? `${progress.mistakes} mistakes` : `${recall}% recall now`;
              return `<button type="button" data-action="inspect-fact" data-key="${fact.key}"><strong>${fact.factorA} × ${fact.factorB}</strong><span>${reason}</span>${icon('chevron-right')}</button>`;
            }).join('')}
          </div>
        ` : '<p class="empty-copy">Session answers will appear here.</p>'}
        ${slowFacts.length ? `<div class="slow-row"><span>Correct but slow</span>${slowFacts.map((fact) => `<button type="button" data-action="inspect-fact" data-key="${fact.key}">${fact.factorA}×${fact.factorB}</button>`).join('')}</div>` : ''}
        ${oftenMissed.length ? `<div class="slow-row"><span>Often missed</span>${oftenMissed.map((fact) => `<button type="button" data-action="inspect-fact" data-key="${fact.key}">${fact.factorA}×${fact.factorB}</button>`).join('')}</div>` : ''}
        ${recentlySecure.length ? `<div class="slow-row"><span>Recently secure</span>${recentlySecure.map((fact) => `<button type="button" data-action="inspect-fact" data-key="${fact.key}">${fact.factorA}×${fact.factorB}</button>`).join('')}</div>` : ''}
        <details class="how-it-works">
          <summary>${icon('info')} How sessions choose questions</summary>
          <p>Each session warms up the facts most in need, then asks questions aimed near 75% recall. New facts arrive steadily (about one in four questions while any remain), a fact never repeats within eight questions unless it was missed, and a missed fact returns after 3–5 questions. The score counts first answers only; with a time limit on, running out of time counts as a miss.</p>
        </details>
      </section>

      <section class="parent-section activity-section">
        <div class="section-heading"><div><p class="eyebrow">History</p><h2>Recent sessions</h2></div></div>
        ${recentSessions.length ? recentSessions.map((result) => {
          const passed = result.status === 'passed';
          const label = result.status === 'abandoned'
            ? `Stopped at ${result.answered}`
            : `${passed ? 'Pass' : 'Not yet'} · ${result.correct}/${result.config.questionCount}`;
          return `
            <div class="activity-item">
              <span class="activity-icon ${passed ? 'passed-icon' : 'failed-icon'}">${passed ? icon('check') : result.status === 'abandoned' ? icon('pause') : icon('x')}</span>
              <p><strong>${label}</strong><span>${result.config.tables.join(', ')} tables${result.config.timeLimitSeconds ? ` · ${result.config.timeLimitSeconds} s` : ''} · ${formatAgo(result.finishedAt)}</span></p>
            </div>
          `;
        }).join('') : '<p class="empty-copy">No sessions yet.</p>'}
      </section>
    `;
  }

  private renderSettingsView(): string {
    const session = this.data.settings.session;
    const needed = requiredCorrect(session);
    return `
      <section class="parent-section settings-section">
        <div class="section-heading"><div><p class="eyebrow">Learning</p><h1>Settings</h1></div></div>
        <div class="form-group">
          <div class="form-label"><strong>Active tables</strong><span>${this.data.settings.activeTables.length} selected</span></div>
          ${this.renderTableSelector(this.data.settings.activeTables)}
        </div>
      </section>

      <section class="parent-section session-section">
        <div class="section-heading"><div><p class="eyebrow">Each session</p><h2>Warm-up and questions</h2></div></div>
        <div class="form-group">
          <div class="form-label"><strong>Warm-up facts</strong><span>shown before the questions</span></div>
          <div class="segmented-control four-segments">
            ${WARM_UP_COUNTS.map((count) => `<button type="button" class="${session.warmUpCount === count ? 'active' : ''}" data-action="set-warmup" data-value="${count}">${count === 0 ? 'Off' : count}</button>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <div class="form-label"><strong>Questions</strong></div>
          <div class="segmented-control four-segments">
            ${QUESTION_COUNTS.map((count) => `<button type="button" class="${session.questionCount === count ? 'active' : ''}" data-action="set-session-count" data-value="${count}">${count}</button>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <div class="form-label"><strong>Time per question</strong><span>${session.timeLimitSeconds ? 'out of time counts as a miss' : 'no limit'}</span></div>
          <div class="segmented-control four-segments">
            ${TIME_LIMITS.map((seconds) => `<button type="button" class="${session.timeLimitSeconds === seconds ? 'active' : ''}" data-action="set-time-limit" data-value="${seconds}">${seconds === 0 ? 'Off' : `${seconds} s`}</button>`).join('')}
          </div>
        </div>
        <div class="form-split">
          <div class="form-group">
            <div class="form-label"><strong>Pass mark</strong></div>
            <div class="segmented-control two-segments compact-segments">
              <button type="button" class="${session.passMode === 'count' ? 'active' : ''}" data-action="set-pass-mode" data-value="count">Number</button>
              <button type="button" class="${session.passMode === 'percent' ? 'active' : ''}" data-action="set-pass-mode" data-value="percent">Percent</button>
            </div>
          </div>
          <div class="form-group">
            <div class="form-label"><strong>Required</strong><span>${needed} of ${session.questionCount}</span></div>
            <div class="stepper">
              <button type="button" data-action="step-pass" data-amount="-1" aria-label="Decrease pass mark">${icon('minus')}</button>
              <input type="number" data-action="pass-value" min="1" max="${session.passMode === 'count' ? session.questionCount : 100}" value="${session.passValue}" aria-label="Required ${session.passMode === 'count' ? 'correct answers' : 'percentage'}" />
              <span>${session.passMode === 'percent' ? '%' : ''}</span>
              <button type="button" data-action="step-pass" data-amount="1" aria-label="Increase pass mark">${icon('plus')}</button>
            </div>
          </div>
        </div>
        <button class="switch-row" type="button" role="switch" aria-checked="${session.includeDivision}" data-action="toggle-division">
          <span><strong>Related division</strong><small>Mix in questions such as 35 ÷ 5</small></span>
          <i class="switch ${session.includeDivision ? 'on' : ''}"><b></b></i>
        </button>
      </section>

      <section class="parent-section sound-section">
        <button class="switch-row" type="button" role="switch" aria-checked="${this.data.settings.soundEnabled}" data-action="toggle-sound">
          <span class="setting-icon">${this.data.settings.soundEnabled ? icon('volume-2') : icon('volume-x')}</span>
          <span><strong>Sound</strong><small>Quiet by default</small></span>
          <i class="switch ${this.data.settings.soundEnabled ? 'on' : ''}"><b></b></i>
        </button>
      </section>

      ${this.renderSyncSection()}

      <section class="parent-section data-section">
        <div class="section-heading"><div><p class="eyebrow">Local data</p><h2>Backup and reset</h2></div></div>
        <div class="data-actions">
          <button class="secondary-button" type="button" data-action="export-data">${icon('download')} Export backup</button>
          <label class="secondary-button file-button">${icon('upload')} Import backup<input type="file" accept="application/json,.json" data-action="import-file" /></label>
        </div>
        <button class="danger-button" type="button" data-action="ask-reset">${icon('trash-2')} Reset all progress</button>
        <p class="storage-note">App ${__APP_VERSION__} · data v${this.data.version} · saved automatically on this device</p>
      </section>
    `;
  }

  private renderSyncSection(): string {
    if (!this.data.sync) {
      return `
        <section class="parent-section sync-section">
          <div class="section-heading"><div><p class="eyebrow">Family sync</p><h2>Share progress</h2></div></div>
          <p class="sync-copy">Enter the family code once on each device to keep progress, history and settings in step.</p>
          <div class="sync-enable-row">
            <input type="text" id="family-code-input" class="family-code-input" placeholder="Family code" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Family code" />
            <button class="primary-button" type="button" data-action="enable-sync">${icon('refresh-cw')} Turn on</button>
          </div>
        </section>
      `;
    }
    return `
      <section class="parent-section sync-section">
        <div class="section-heading"><div><p class="eyebrow">Family sync</p><h2>Share progress</h2></div></div>
        <p class="sync-status sync-state-${this.syncStatus}" role="status">${icon(this.syncStatus === 'ok' || this.syncStatus === 'idle' ? 'check' : 'refresh-cw')} ${escapeHtml(this.syncStatusLine())}</p>
        <div class="data-actions">
          <button class="secondary-button" type="button" data-action="sync-now">${icon('refresh-cw')} Sync now</button>
          <button class="secondary-button" type="button" data-action="disable-sync">${icon('x')} Turn off</button>
        </div>
      </section>
    `;
  }

  private syncStatusLine(): string {
    if (this.syncStatus === 'syncing') return 'Syncing…';
    if (this.syncStatus === 'offline') return 'Offline — will sync when back online';
    if (this.syncStatus === 'error') return 'Sync problem — will retry';
    const last = this.data.sync?.lastSyncedAt;
    return last ? `Synced ${formatAgo(last)}` : 'Waiting for the first sync';
  }

  private renderTableSelector(selected: number[]): string {
    const groups = [
      { id: 'core', label: 'Core', detail: '2, 3, 5, 10', tables: CORE_TABLES },
      { id: 'beyond', label: 'Beyond core', detail: 'the other 8', tables: BEYOND_CORE_TABLES },
      { id: 'all', label: 'All 1–12', detail: 'every table', tables: ALL_TABLES },
    ];
    return `
      <div class="table-quick-sets" aria-label="Quick table choices">
        ${groups.map((group) => `
          <button type="button" class="${this.sameTableSelection(selected, group.tables) ? 'active' : ''}" data-action="set-table-group" data-group="${group.id}">
            <strong>${group.label}</strong><small>${group.detail}</small>
          </button>
        `).join('')}
      </div>
      <div class="table-selector" aria-label="Times tables">
        ${ALL_TABLES.map((table) => `
          <button type="button" class="${selected.includes(table) ? 'active' : ''}" data-action="toggle-table" data-table="${table}" aria-pressed="${selected.includes(table)}">${table}</button>
        `).join('')}
      </div>
    `;
  }

  private renderOverlays(): string {
    const overlays: string[] = [];
    if (this.gateOpen) {
      overlays.push(`
        <div class="modal-backdrop" role="presentation">
          <section class="modal parent-gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
            <button class="modal-close" type="button" data-action="close-gate" aria-label="Close">${icon('x')}</button>
            <span class="modal-symbol">${icon('lock-keyhole')}</span>
            <p class="eyebrow">Grown-ups</p>
            <h2 id="gate-title">Enter the code</h2>
            <div class="pin-dots ${this.pinWrong ? 'is-wrong' : ''}" role="status" aria-label="${this.pinWrong ? 'Wrong code, try again' : `${this.pinInput.length} of ${PIN_LENGTH} digits entered`}">
              ${Array.from({ length: PIN_LENGTH }, (_, index) => `<i class="${index < this.pinInput.length ? 'filled' : ''}"></i>`).join('')}
            </div>
            <p class="pin-hint">${this.pinWrong ? 'That’s not it — try again.' : 'Hint: MMDD'}</p>
            <div class="keypad pin-keypad" aria-label="Code keypad">
              ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => `<button class="key" type="button" data-action="pin-key" data-key="${number}">${number}</button>`).join('')}
              <span></span>
              <button class="key" type="button" data-action="pin-key" data-key="0">0</button>
              <button class="key key-icon" type="button" data-action="pin-backspace" aria-label="Delete last digit" ${this.pinInput ? '' : 'disabled'}>${icon('delete')}</button>
            </div>
          </section>
        </div>
      `);
    }
    if (this.resumePrompt && this.data.activeSession) {
      const active = this.data.activeSession;
      const headline = active.warmUpQueue.length
        ? 'Warm-up in progress'
        : `${active.answered} of ${active.fixQueue ? active.answered + active.fixQueue.length : active.config.questionCount} answered`;
      overlays.push(`
        <div class="modal-backdrop" role="presentation">
          <section class="modal resume-modal" role="dialog" aria-modal="true" aria-labelledby="resume-title">
            <span class="modal-symbol test-symbol">${icon('pause')}</span>
            <p class="eyebrow">Session in progress</p>
            <h2 id="resume-title">${headline}</h2>
            <div class="modal-actions">
              <button class="primary-button test-button" type="button" data-action="resume-session">${icon('play')} Resume</button>
              <button class="secondary-button" type="button" data-action="confirm-abandon">End session</button>
            </div>
          </section>
        </div>
      `);
    }
    if (this.abandonPrompt) {
      overlays.push(`
        <div class="modal-backdrop" role="presentation">
          <section class="modal" role="dialog" aria-modal="true" aria-labelledby="abandon-title">
            <span class="modal-symbol test-symbol">${icon('clipboard-check')}</span>
            <p class="eyebrow">Session</p>
            <h2 id="abandon-title">End this session?</h2>
            <p class="modal-copy">It will be recorded as stopped early, never as a pass.</p>
            <div class="modal-actions">
              <button class="danger-button" type="button" data-action="confirm-abandon">End session</button>
              <button class="secondary-button" type="button" data-action="cancel-abandon">Keep going</button>
            </div>
          </section>
        </div>
      `);
    }
    if (this.resetPrompt) {
      overlays.push(`
        <div class="modal-backdrop" role="presentation">
          <section class="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
            <span class="modal-symbol danger-symbol">${icon('trash-2')}</span>
            <p class="eyebrow">Local data</p>
            <h2 id="reset-title">Reset everything?</h2>
            <p class="modal-copy">Progress, session history and settings will be removed from this device.${this.data.sync ? ' Family sync will be turned off and the cloud copy cleared.' : ''}</p>
            <div class="modal-actions">
              <button class="danger-button" type="button" data-action="confirm-reset">Reset all</button>
              <button class="secondary-button" type="button" data-action="cancel-reset">Cancel</button>
            </div>
          </section>
        </div>
      `);
    }
    if (this.factDialogKey) overlays.push(this.renderFactDialog(this.factDialogKey));
    return overlays.join('');
  }

  private renderFactDialog(key: FactKey): string {
    const fact = parseFactKey(key);
    const progress = this.data.facts[key];
    const label = memoryLabel(progress);
    const recall = Math.round(recallProbability(progress) * 100);
    return `
      <div class="modal-backdrop" role="presentation">
        <section class="modal fact-modal" role="dialog" aria-modal="true" aria-labelledby="fact-title">
          <button class="modal-close" type="button" data-action="close-fact" aria-label="Close">${icon('x')}</button>
          <p class="eyebrow">${label}</p>
          <h2 id="fact-title">${fact.factorA} × ${fact.factorB} = ${fact.answer}</h2>
          <div class="fact-metrics">
            <div><strong>${progress?.independentCorrect ?? 0}</strong><span>correct</span></div>
            <div><strong>${progress?.mistakes ?? 0}</strong><span>mistakes</span></div>
            <div><strong>${recall}%</strong><span>recall now</span></div>
          </div>
          <dl class="fact-data">
            <div><dt>Average answer</dt><dd>${progress?.averageResponseMs ? `${(progress.averageResponseMs / 1000).toFixed(1)}s` : 'No data'}</dd></div>
            <div><dt>Correct sessions</dt><dd>${progress?.correctSessionIds.length ?? 0}</dd></div>
            <div><dt>Memory stability</dt><dd>${progress?.stabilityHours ? this.formatStability(progress.stabilityHours) : 'New'}</dd></div>
            <div><dt>Last reviewed</dt><dd>${progress?.lastReviewedAt ? formatDate(progress.lastReviewedAt) : 'Never'}</dd></div>
          </dl>
          <div class="attempt-history">
            <h3>Recent attempts</h3>
            ${progress?.recentAttempts.length ? progress.recentAttempts.slice(-6).reverse().map((attempt) => `
              <p><span class="attempt-dot ${attempt.correct ? 'correct' : 'wrong'}"></span><strong>${attempt.correct ? 'Correct' : 'Mistake'}${attempt.independent ? '' : ' · guided'}</strong><time>${formatAgo(attempt.at)}</time></p>
            `).join('') : '<p class="empty-copy">No attempts yet.</p>'}
          </div>
        </section>
      </div>
    `;
  }

  private closeGate(): void {
    this.gateOpen = false;
    this.pinInput = '';
    this.pinWrong = false;
    this.render();
  }

  private appendPin(digit: string): void {
    if (!this.gateOpen || !/^\d$/.test(digit) || this.pinInput.length >= PIN_LENGTH) return;
    this.pinInput += digit;
    this.pinWrong = false;
    if (this.pinInput.length < PIN_LENGTH) {
      this.render();
      return;
    }
    if (this.pinInput === parentPin()) {
      this.unlockParent();
      return;
    }
    this.pinInput = '';
    this.pinWrong = true;
    this.render();
  }

  private unlockParent(): void {
    this.gateOpen = false;
    this.pinInput = '';
    this.pinWrong = false;
    this.parentTab = 'progress';
    this.screen = 'parent';
    this.render();
  }

  private goHome(): void {
    this.clearSessionTimers();
    this.screen = 'home';
    this.session = null;
    this.latestResult = null;
    this.render();
  }

  // --- Session flow ---------------------------------------------------------

  private startSession(): void {
    this.clearSessionTimers();
    const settings = this.data.settings;
    const warmUp = pickWarmUpFacts(settings.activeTables, this.data.facts, settings.session.warmUpCount);
    const active: ActiveSession = {
      id: this.makeId('session'),
      startedAt: Date.now(),
      config: {
        tables: [...settings.activeTables],
        questionCount: settings.session.questionCount,
        passMode: settings.session.passMode,
        passValue: settings.session.passValue,
        includeDivision: settings.session.includeDivision,
        timeLimitSeconds: settings.session.timeLimitSeconds,
      },
      warmUpQueue: warmUp.map((fact) => fact.key),
      answered: 0,
      correct: 0,
      introduced: warmUp.filter((fact) => !this.data.facts[fact.key]).length,
      recent: [],
      retries: warmUpRetries(warmUp.map((fact) => fact.key)),
      records: [],
      fixQueue: null,
    };
    this.data.activeSession = active;
    this.latestResult = null;
    this.resumePrompt = false;
    this.abandonPrompt = false;
    this.session = {
      phase: 'look',
      fixing: false,
      warmFact: warmUp.length ? warmUp[0] : null,
      warmMissed: false,
      current: null,
      input: '',
      questionStartedAt: Date.now(),
      pausedAt: null,
      timedOut: false,
    };
    this.screen = 'session';
    if (!warmUp.length) {
      this.nextQuestion();
    }
    this.persist();
    this.render();
  }

  private startFixSession(result: TestResult): void {
    this.clearSessionTimers();
    const missedKeys = [...new Set(result.questions
      .filter((question) => {
        const answer = result.answers.find((item) => item.questionId === question.id);
        return answer && !answer.correct;
      })
      .map((question) => question.factKey))];
    if (!missedKeys.length) return;

    this.latestResult = null;
    this.data.activeSession = {
      id: this.makeId('session'),
      startedAt: Date.now(),
      // Fixing is about getting the fact right, not fast, so the round is never timed.
      config: { ...result.config, tables: [...result.config.tables], timeLimitSeconds: 0 },
      warmUpQueue: [],
      answered: 0,
      correct: 0,
      introduced: 0,
      recent: [],
      retries: [],
      records: [],
      fixQueue: missedKeys,
    };
    this.session = {
      phase: 'answer',
      fixing: true,
      warmFact: null,
      warmMissed: false,
      current: null,
      input: '',
      questionStartedAt: Date.now(),
      pausedAt: null,
      timedOut: false,
    };
    this.screen = 'session';
    this.nextQuestion();
    this.persist();
    this.render();
  }

  private resumeSession(): void {
    const active = this.data.activeSession;
    if (!active) {
      this.resumePrompt = false;
      this.render();
      return;
    }
    this.resumePrompt = false;
    this.session = {
      phase: 'look',
      fixing: active.fixQueue !== null,
      warmFact: null,
      warmMissed: false,
      current: null,
      input: '',
      questionStartedAt: Date.now(),
      pausedAt: null,
      timedOut: false,
    };
    this.screen = 'session';
    if (active.warmUpQueue.length) {
      this.session.warmFact = parseFactKey(active.warmUpQueue[0]);
    } else {
      this.nextQuestion();
    }
    this.render();
  }

  private exitSession(): void {
    const active = this.data.activeSession;
    if (!active || this.session?.phase === 'done') {
      this.goHome();
      return;
    }
    if (active.fixQueue !== null || active.answered === 0) {
      this.data.activeSession = null;
      this.persist();
      this.goHome();
      return;
    }
    this.abandonPrompt = true;
    this.syncQuestionClock();
    this.render();
  }

  private confirmAbandon(): void {
    this.clearSessionTimers();
    const active = this.data.activeSession;
    if (active) {
      if (active.fixQueue === null && active.answered > 0) {
        this.data.testHistory = [...this.data.testHistory, sessionResult(active, 'abandoned')].slice(-100);
      }
      this.data.activeSession = null;
      this.persist();
    }
    this.abandonPrompt = false;
    this.resumePrompt = false;
    this.session = null;
    this.screen = 'home';
    this.render();
  }

  private nextQuestion(): void {
    const active = this.data.activeSession;
    const view = this.session;
    if (!active || !view) return;
    view.timedOut = false;

    if (active.fixQueue !== null) {
      const nextKey = active.fixQueue[0];
      if (!nextKey) {
        this.data.activeSession = null;
        view.phase = 'done';
        view.current = null;
        this.persist();
        return;
      }
      const fact = parseFactKey(nextKey);
      view.current = {
        ...fact,
        reason: 'retry',
        presented: presentQuestion(fact.factorA, fact.factorB, false, randomFlip()),
      };
      this.openQuestion(view);
      return;
    }

    if (active.answered >= active.config.questionCount) {
      this.finishSession();
      return;
    }

    const chosen = choosePracticeFact({
      tables: active.config.tables,
      facts: this.data.facts,
      recent: active.recent,
      retries: active.retries,
      answered: active.answered,
      introduced: active.introduced,
    });
    if (!this.data.facts[chosen.key]) active.introduced += 1;
    const asDivision = active.config.includeDivision &&
      chosen.reason !== 'retry' &&
      (this.data.facts[chosen.key]?.independentCorrect ?? 0) > 0 &&
      Math.random() < 0.4;
    view.current = { ...chosen, presented: presentQuestion(chosen.factorA, chosen.factorB, asDivision, randomFlip()) };
    this.openQuestion(view);
  }

  private openQuestion(view: SessionView): void {
    view.phase = 'answer';
    view.input = '';
    view.questionStartedAt = Date.now();
    view.pausedAt = null;
    this.syncQuestionClock();
  }

  private finishSession(): void {
    const active = this.data.activeSession;
    if (!active) return;
    this.clearSessionTimers();
    const result = sessionResult(active, null);
    this.data.testHistory = [...this.data.testHistory, result].slice(-100);
    this.data.activeSession = null;
    this.latestResult = result;
    this.session = null;
    this.screen = 'result';
    this.persist();
  }

  // --- Answers --------------------------------------------------------------

  private currentInput(): string | null {
    if (this.screen !== 'session' || !this.session) return null;
    if (['try', 'answer', 'correction'].includes(this.session.phase)) return this.session.input;
    return null;
  }

  private setCurrentInput(value: string): void {
    if (this.session) this.session.input = value;
  }

  private appendAnswer(digit: string): void {
    if (!/^\d$/.test(digit)) return;
    const current = this.currentInput();
    if (current === null || current.length >= 3) return;
    const next = current === '0' ? digit : current + digit;
    this.setCurrentInput(next);
    this.render();
  }

  private backspaceAnswer(): void {
    const current = this.currentInput();
    if (current === null || !current) return;
    this.setCurrentInput(current.slice(0, -1));
    this.render();
  }

  private submitCurrentAnswer(): void {
    const input = this.currentInput();
    if (!input) return;
    const answer = Number(input);
    if (this.session?.phase === 'try') {
      this.submitWarmUpAnswer(answer);
    } else {
      this.submitQuestionAnswer(answer);
    }
  }

  private submitWarmUpAnswer(answer: number): void {
    const active = this.data.activeSession;
    const view = this.session;
    if (!active || !view || !view.warmFact) return;
    const fact = view.warmFact;
    const responseMs = Math.max(200, Date.now() - view.questionStartedAt);

    if (answer !== fact.answer) {
      if (this.data.settings.soundEnabled) playAnswerSound(false);
      view.warmMissed = true;
      view.input = '';
      this.render();
      return;
    }

    this.updateFact(fact, true, false, responseMs, active.id, 'learn');
    if (this.data.settings.soundEnabled) playAnswerSound(true);
    active.warmUpQueue = active.warmUpQueue.slice(1);
    view.warmMissed = false;
    view.input = '';
    if (active.warmUpQueue.length) {
      view.warmFact = parseFactKey(active.warmUpQueue[0]);
      view.phase = 'look';
      view.questionStartedAt = Date.now();
    } else {
      view.warmFact = null;
      this.nextQuestion();
    }
    this.persist();
    this.render();
  }

  private submitQuestionAnswer(answer: number): void {
    if (this.session?.phase === 'answer') this.settleQuestion(answer);
    else if (this.session?.phase === 'correction') this.settleCorrection(answer);
  }

  /** The first answer to a question: a typed number, or null when the time limit ran out. */
  private settleQuestion(given: number | null): void {
    const active = this.data.activeSession;
    const view = this.session;
    if (!active || !view || !view.current || view.phase !== 'answer') return;
    this.clearQuestionTimer();
    const current = view.current;
    const presented = current.presented;
    const correct = given === presented.answer;
    const responseMs = given === null
      ? timeLimitMs(active.config)
      : Math.max(200, Date.now() - view.questionStartedAt);

    this.updateFact(current, correct, true, responseMs, active.id, 'practice');
    active.answered += 1;
    if (correct) active.correct += 1;
    active.records = [...active.records, {
      id: `${active.id}-${active.records.length}`,
      factKey: current.key,
      kind: presented.kind,
      left: presented.left,
      right: presented.right,
      operator: presented.operator,
      answer: presented.answer,
      given,
      correct,
      responseMs,
    }];
    active.recent = [...active.recent, current.key].slice(-10);
    view.input = '';
    view.timedOut = given === null;
    view.phase = correct ? 'right' : 'correction';
    if (active.fixQueue !== null) {
      active.fixQueue = correct ? active.fixQueue.slice(1) : [...active.fixQueue.slice(1), current.key];
    } else if (correct) {
      active.retries = active.retries.filter((item) => item.factKey !== current.key);
    } else {
      active.retries = scheduleRetry(active.retries, current.key, active.answered);
    }
    if (this.data.settings.soundEnabled) playAnswerSound(correct);
    this.persist();
    if (correct) this.afterFeedback(480, () => this.advanceSession());
    this.render();
  }

  private settleCorrection(answer: number): void {
    const active = this.data.activeSession;
    const view = this.session;
    if (!active || !view || !view.current || view.phase !== 'correction') return;
    const current = view.current;
    if (answer !== current.presented.answer) {
      view.input = '';
      if (this.data.settings.soundEnabled) playAnswerSound(false);
      this.render();
      return;
    }
    const responseMs = Math.max(200, Date.now() - view.questionStartedAt);
    this.updateFact(current, true, false, responseMs, active.id, 'practice');
    view.input = '';
    view.phase = 'corrected';
    if (this.data.settings.soundEnabled) playAnswerSound(true);
    this.persist();
    this.afterFeedback(650, () => this.advanceSession());
    this.render();
  }

  // --- Question clock -------------------------------------------------------

  /**
   * Keeps the per-question clock in step with what the child can actually
   * see: it stops while the tab is hidden or a prompt covers the question,
   * and the hidden time is not charged to the answer.
   */
  private syncQuestionClock(): void {
    const view = this.session;
    if (!view) return;
    const canRun = document.visibilityState === 'visible' && !this.hasBlockingOverlay();
    if (!canRun) {
      view.pausedAt ??= Date.now();
      this.clearQuestionTimer();
      return;
    }
    if (view.pausedAt !== null) {
      view.questionStartedAt += Date.now() - view.pausedAt;
      view.pausedAt = null;
    }
    this.armQuestionTimer();
  }

  private armQuestionTimer(): void {
    this.clearQuestionTimer();
    const active = this.data.activeSession;
    const view = this.session;
    if (!active || !view || view.phase !== 'answer') return;
    const limitMs = timeLimitMs(active.config);
    if (!limitMs) return;
    const remaining = Math.max(0, limitMs - (Date.now() - view.questionStartedAt));
    this.questionTimer = window.setTimeout(() => {
      this.questionTimer = null;
      this.settleQuestion(null);
    }, remaining);
  }

  private clearQuestionTimer(): void {
    if (this.questionTimer !== null) window.clearTimeout(this.questionTimer);
    this.questionTimer = null;
  }

  private clearSessionTimers(): void {
    this.clearTransition();
    this.clearQuestionTimer();
  }

  private advanceSession(): void {
    if (!this.data.activeSession && this.session?.phase !== 'done') return;
    this.nextQuestion();
    this.render();
  }

  private updateFact(
    descriptor: Pick<FactDescriptor, 'key' | 'factorA' | 'factorB'>,
    correct: boolean,
    independent: boolean,
    responseMs: number,
    sessionId: string,
    source: AttemptSource,
  ): void {
    const current = this.data.facts[descriptor.key] ?? newFactProgress(descriptor.key, descriptor.factorA, descriptor.factorB);
    this.data.facts[descriptor.key] = recordAnswer(current, {
      correct,
      independent,
      responseMs,
      sessionId,
      source,
    });
  }

  // --- Settings -------------------------------------------------------------

  private toggleTable(table: number): void {
    if (!ALL_TABLES.includes(table)) return;
    const current = this.data.settings.activeTables;
    if (current.includes(table) && current.length === 1) {
      this.showToast('Keep at least one table selected');
      return;
    }
    const next = current.includes(table) ? current.filter((item) => item !== table) : [...current, table].sort((a, b) => a - b);
    this.data.settings.activeTables = next;
    if (!next.includes(this.progressTable)) this.progressTable = next[0];
    this.touchSettings();
    this.persist();
    this.render();
  }

  private setTableGroup(group: string): void {
    const tables = group === 'core'
      ? [...CORE_TABLES]
      : group === 'beyond'
        ? [...BEYOND_CORE_TABLES]
        : [...ALL_TABLES];
    this.data.settings.activeTables = tables;
    if (!tables.includes(this.progressTable)) this.progressTable = tables[0];
    this.touchSettings();
    this.persist();
    this.render();
  }

  private setSessionCount(count: number): void {
    if (!QUESTION_COUNTS.includes(count)) return;
    const session = this.data.settings.session;
    const previousCount = session.questionCount;
    session.questionCount = count;
    if (session.passMode === 'count' && previousCount !== count) {
      // Keep the pass bar the same proportion rather than clamping 48/50 into
      // a silent 20/20 perfect-score requirement.
      session.passValue = clamp(Math.round(session.passValue / previousCount * count), 1, count);
    }
    this.touchSettings();
    this.persist();
    this.render();
  }

  private setPassMode(mode: SessionConfig['passMode']): void {
    const session = this.data.settings.session;
    if (mode === session.passMode) return;
    if (mode === 'percent') {
      session.passValue = Math.round(session.passValue / session.questionCount * 100);
    } else {
      session.passValue = Math.ceil(session.questionCount * session.passValue / 100);
    }
    session.passMode = mode;
    this.touchSettings();
    this.persist();
    this.render();
  }

  private stepPass(amount: number): void {
    const session = this.data.settings.session;
    const max = session.passMode === 'count' ? session.questionCount : 100;
    session.passValue = clamp(session.passValue + amount, 1, max);
    this.touchSettings();
    this.persist();
    this.render();
  }

  private setWarmUpCount(count: number): void {
    if (!WARM_UP_COUNTS.includes(count)) return;
    this.data.settings.session.warmUpCount = count;
    this.touchSettings();
    this.persist();
    this.render();
  }

  private setTimeLimit(seconds: number): void {
    if (!TIME_LIMITS.includes(seconds)) return;
    this.data.settings.session.timeLimitSeconds = seconds;
    this.touchSettings();
    this.persist();
    this.render();
  }

  // --- Data -----------------------------------------------------------------

  private downloadBackup(): void {
    const blob = new Blob([exportData(this.data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `danny-times-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    this.showToast('Backup exported');
  }

  private confirmReset(): void {
    const sync = this.data.sync;
    if (this.syncDebounce !== null) {
      window.clearTimeout(this.syncDebounce);
      this.syncDebounce = null;
    }
    this.data = resetData();
    this.progressTable = this.data.settings.activeTables[0];
    this.resetPrompt = false;
    this.parentTab = 'settings';
    this.syncStatus = 'idle';
    this.clearSessionTimers();
    this.session = null;
    this.persist();
    this.showToast('Progress reset');
    if (sync) {
      void new SyncClient(sync.familyCode).wipe().catch(() => {
        this.showToast('Could not clear the family cloud copy');
      });
    }
  }

  private tableProgressPercent(table: number): number {
    const weights: Record<MemoryLabel, number> = {
      New: 0,
      Learning: 0.25,
      Remembering: 0.55,
      Fast: 0.78,
      Secure: 1,
    };
    const total = factsForTables([table]).reduce((sum, fact) => sum + weights[memoryLabel(this.data.facts[fact.key])], 0);
    return Math.round(total / 12 * 100);
  }

  private sameTableSelection(first: number[], second: number[]): boolean {
    return first.length === second.length && second.every((table) => first.includes(table));
  }

  private formatStability(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    if (hours < 48) return `${Math.round(hours)} hours`;
    return `${Math.round(hours / 24)} days`;
  }

  private afterFeedback(delay: number, callback: () => void): void {
    this.clearTransition();
    this.transitionTimer = window.setTimeout(() => {
      this.transitionTimer = null;
      callback();
    }, delay);
  }

  private clearTransition(): void {
    if (this.transitionTimer !== null) window.clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
  }

  private persist(): void {
    saveData(this.data);
    this.scheduleSync();
  }

  private touchSettings(): void {
    this.data.settingsUpdatedAt = Date.now();
  }

  private scheduleSync(): void {
    if (!this.data.sync) return;
    if (this.syncDebounce !== null) window.clearTimeout(this.syncDebounce);
    this.syncDebounce = window.setTimeout(() => {
      this.syncDebounce = null;
      void this.syncNow();
    }, 3000);
  }

  private flushPendingSync(): void {
    if (this.syncDebounce === null) return;
    window.clearTimeout(this.syncDebounce);
    this.syncDebounce = null;
    void this.syncNow();
  }

  private enableSync(): void {
    const input = this.root.querySelector<HTMLInputElement>('#family-code-input');
    const code = input?.value.trim() ?? '';
    if (code.length < MIN_FAMILY_CODE_LENGTH) {
      this.showToast('That family code looks too short');
      return;
    }
    this.data.sync = { familyCode: code, lastSyncedAt: null };
    saveData(this.data);
    this.render();
    void this.syncNow(true);
  }

  private async syncNow(manual = false): Promise<void> {
    const sync = this.data.sync;
    if (!sync) return;
    if (this.syncBusy) {
      this.syncQueued = true;
      return;
    }
    this.syncBusy = true;
    this.syncStatus = 'syncing';
    if (manual) this.render();

    try {
      const client = new SyncClient(sync.familyCode);
      let remote = await client.pull();
      if (remote.fromNewerApp) throw new SyncError('Update this device first: the family data comes from a newer app.');
      let merged = remote.payload ? mergePayloads(toPayload(this.data), remote.payload) : toPayload(this.data);
      this.data = applyPayload(this.data, merged);
      this.data.settings = ensureSettings(this.data.settings);
      saveData(this.data);

      if (!remote.payload || !samePayload(merged, remote.payload)) {
        let version = remote.version;
        for (let attempt = 0; ; attempt += 1) {
          const pushed = await client.push(merged, version);
          if (pushed.ok) break;
          if (!pushed.conflict || attempt >= 2) throw new SyncError('Could not save to the family cloud.');
          remote = await client.pull();
          if (remote.fromNewerApp) throw new SyncError('Update this device first: the family data comes from a newer app.');
          version = remote.version;
          merged = remote.payload ? mergePayloads(merged, remote.payload) : merged;
          this.data = applyPayload(this.data, merged);
          this.data.settings = ensureSettings(this.data.settings);
          saveData(this.data);
        }
      }

      if (this.data.sync) {
        this.data.sync = { ...this.data.sync, lastSyncedAt: Date.now() };
        saveData(this.data);
      }
      this.syncStatus = 'ok';
      if (manual) this.showToast('Synced');
    } catch (error) {
      this.syncStatus = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error';
      if (manual) this.showToast(error instanceof SyncError ? error.message : 'Sync failed — will retry');
    } finally {
      this.syncBusy = false;
      this.render();
      if (this.syncQueued) {
        this.syncQueued = false;
        void this.syncNow();
      }
    }
  }

  private showToast(message: string): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toast = message;
    this.render();
    this.toastTimer = window.setTimeout(() => {
      this.toast = '';
      this.toastTimer = null;
      this.render();
    }, 2400);
  }

  private hasBlockingOverlay(): boolean {
    return this.gateOpen || this.resumePrompt || this.abandonPrompt || this.resetPrompt || this.factDialogKey !== null;
  }

  private makeId(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`;
  }
}
