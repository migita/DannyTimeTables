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
import { choosePracticeFact, scheduleRetry, type ScheduledFact } from './core/scheduler';
import {
  defaultTestConfig,
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
import {
  abandonTest,
  answerTest,
  createSeed,
  finishTest,
  generateTestQuestions,
  requiredCorrect,
} from './core/test-engine';
import type {
  ActiveTest,
  AppData,
  FactKey,
  MemoryLabel,
  PracticeSessionSummary,
  RetryItem,
  TestConfig,
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

type Screen = 'home' | 'learn' | 'practice' | 'parent' | 'test' | 'test-result';
type ParentTab = 'progress' | 'tests' | 'settings';
type PracticePhase = 'answer' | 'right' | 'correction' | 'corrected' | 'complete';
type LearnPhase = 'explain' | 'guided' | 'guided-correction' | 'independent' | 'correction' | 'complete';

interface PracticeState {
  id: string;
  startedAt: number;
  target: number | null;
  answered: number;
  correct: number;
  current: ScheduledFact;
  recent: FactKey[];
  retries: RetryItem[];
  factKeys: FactKey[];
  input: string;
  phase: PracticePhase;
  questionStartedAt: number;
  completed: boolean;
}

interface LearnState {
  id: string;
  startedAt: number;
  fact: FactDescriptor;
  input: string;
  phase: LearnPhase;
  questionStartedAt: number;
  independentCorrect: boolean;
  completed: boolean;
}

export class App {
  private data: AppData;
  private screen: Screen;
  private parentTab: ParentTab = 'progress';
  private progressTable: number;
  private draftTest: TestConfig;
  private practice: PracticeState | null = null;
  private learn: LearnState | null = null;
  private testInput = '';
  private testQuestionStartedAt = Date.now();
  private latestResult: TestResult | null = null;
  private gateOpen = false;
  private gateDestination: ParentTab = 'progress';
  private resumePrompt = false;
  private abandonPrompt = false;
  private resetPrompt = false;
  private factDialogKey: FactKey | null = null;
  private toast = '';
  private holdTimer: number | null = null;
  private transitionTimer: number | null = null;
  private toastTimer: number | null = null;
  private syncStatus: 'idle' | 'syncing' | 'ok' | 'offline' | 'error' = 'idle';
  private syncBusy = false;
  private syncQueued = false;
  private syncDebounce: number | null = null;

  constructor(private readonly root: HTMLElement) {
    this.data = loadData();
    this.progressTable = this.data.settings.activeTables[0] ?? 2;
    this.draftTest = {
      ...defaultTestConfig(),
      tables: [...this.data.settings.activeTables],
    };
    this.screen = this.data.activeTest ? 'test' : 'home';
    this.resumePrompt = this.data.activeTest !== null;

    this.root.addEventListener('click', (event) => this.handleClick(event));
    this.root.addEventListener('change', (event) => void this.handleChange(event));
    this.root.addEventListener('pointerdown', (event) => this.handlePointerDown(event));
    window.addEventListener('pointerup', () => this.cancelParentHold());
    window.addEventListener('pointercancel', () => this.cancelParentHold());
    window.addEventListener('keydown', (event) => this.handleKeydown(event));
    window.addEventListener('online', () => void this.syncNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushPendingSync();
    });
    this.render();
    if (this.data.sync) void this.syncNow();
  }

  private render(): void {
    document.body.dataset.screen = this.screen;
    let content: string;
    switch (this.screen) {
      case 'learn':
        content = this.renderLearn();
        break;
      case 'practice':
        content = this.renderPractice();
        break;
      case 'parent':
        content = this.renderParent();
        break;
      case 'test':
        content = this.renderTest();
        break;
      case 'test-result':
        content = this.renderTestResult();
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
      case 'start-learn':
        this.startLearn();
        break;
      case 'start-practice':
        this.startPractice();
        break;
      case 'open-test-gate':
        this.openParentGate('tests');
        break;
      case 'open-parent-gate':
        this.openParentGate('progress');
        break;
      case 'close-gate':
        this.gateOpen = false;
        this.render();
        break;
      case 'hold-parent':
        if ((event as MouseEvent).detail === 0) this.unlockParent();
        break;
      case 'home':
        this.goHome();
        break;
      case 'practice-end':
        this.finishPractice();
        this.goHome();
        break;
      case 'learn-try':
        if (this.learn) {
          this.learn.phase = 'guided';
          this.learn.input = '';
          this.learn.questionStartedAt = Date.now();
          this.render();
        }
        break;
      case 'learn-another':
        this.startLearn(this.learn?.fact.key);
        break;
      case 'learn-practice':
        this.startPractice();
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
        this.toggleTable(Number(target.dataset.table), target.dataset.context ?? 'settings');
        break;
      case 'set-table-group':
        this.setTableGroup(target.dataset.group ?? 'all', target.dataset.context ?? 'settings');
        break;
      case 'set-practice-target':
        this.setPracticeTarget(target.dataset.value ?? '20');
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
      case 'set-test-count':
        this.setTestCount(Number(target.dataset.value));
        break;
      case 'set-pass-mode':
        this.setPassMode(target.dataset.value as TestConfig['passMode']);
        break;
      case 'step-pass':
        this.stepPass(Number(target.dataset.amount));
        break;
      case 'toggle-division':
        this.draftTest.includeDivision = !this.draftTest.includeDivision;
        this.render();
        break;
      case 'start-custom-test':
        this.startTest(this.draftTest, null);
        break;
      case 'start-preset':
        this.startPreset(target.dataset.id ?? '');
        break;
      case 'save-preset':
        this.savePreset();
        break;
      case 'delete-preset':
        this.deletePreset(target.dataset.id ?? '');
        break;
      case 'test-exit':
        this.abandonPrompt = true;
        this.render();
        break;
      case 'cancel-abandon':
        this.abandonPrompt = false;
        this.render();
        break;
      case 'confirm-abandon':
        this.confirmAbandon();
        break;
      case 'resume-test':
        this.resumePrompt = false;
        this.testQuestionStartedAt = Date.now();
        this.render();
        break;
      case 'retry-test':
        if (this.latestResult) this.startTest(this.latestResult.config, this.latestResult.presetName);
        break;
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
      const max = this.draftTest.passMode === 'count' ? this.draftTest.questionCount : 100;
      this.draftTest.passValue = clamp(Math.round(target.valueAsNumber || 0), 1, max);
      this.render();
    }
    if (target.dataset.action === 'import-file' && target.files?.[0]) {
      try {
        this.data = importData(await target.files[0].text());
        this.progressTable = this.data.settings.activeTables[0] ?? 2;
        this.draftTest = { ...defaultTestConfig(), tables: [...this.data.settings.activeTables] };
        this.persist();
        this.showToast('Backup imported');
      } catch (error) {
        this.showToast(error instanceof Error ? error.message : 'Could not import that backup');
      }
    }
  }

  private handlePointerDown(event: PointerEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="hold-parent"]');
    if (!button) return;
    button.classList.add('is-holding');
    this.holdTimer = window.setTimeout(() => this.unlockParent(), 1600);
  }

  private cancelParentHold(): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.root.querySelector('[data-action="hold-parent"]')?.classList.remove('is-holding');
  }

  private handleKeydown(event: KeyboardEvent): void {
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
    const activeFacts = factsForTables(this.data.settings.activeTables);
    const labelCounts = activeFacts.reduce<Record<MemoryLabel, number>>((counts, fact) => {
      counts[memoryLabel(this.data.facts[fact.key])] += 1;
      return counts;
    }, { New: 0, Learning: 0, Remembering: 0, Fast: 0, Secure: 0 });
    const growing = labelCounts.Remembering + labelCounts.Fast + labelCounts.Secure;
    const practiceTarget = this.data.settings.practiceTarget === null ? 'Open' : this.data.settings.practiceTarget;

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

        <section class="mode-grid" aria-label="Choose a mode">
          <button class="mode-card learn-card" type="button" data-action="start-learn">
            <span class="mode-visual mini-array" aria-hidden="true">${Array.from({ length: 12 }, () => '<b></b>').join('')}</span>
            <span class="mode-copy"><small>Look, build, try</small><strong>Learn</strong></span>
            ${icon('chevron-right')}
          </button>
          <button class="mode-card practice-card" type="button" data-action="start-practice">
            <span class="mode-visual target-visual" aria-hidden="true"><b>${practiceTarget}</b></span>
            <span class="mode-copy"><small>Your next set</small><strong>Practice</strong></span>
            ${icon('chevron-right')}
          </button>
          <button class="mode-card test-card" type="button" data-action="open-test-gate">
            <span class="mode-visual test-visual" aria-hidden="true">${icon('clipboard-check')}</span>
            <span class="mode-copy"><small>Grown-up start</small><strong>Just Test</strong></span>
            ${icon('chevron-right')}
          </button>
        </section>

        <section class="home-progress" aria-label="Learning progress">
          <div><strong>${growing}</strong><span>growing</span></div>
          <div><strong>${labelCounts.Secure}</strong><span>secure</span></div>
          <div><strong>${this.data.practiceHistory.length}</strong><span>sessions</span></div>
        </section>
      </main>
    `;
  }

  private renderLearn(): string {
    if (!this.learn) return this.renderHome();
    const { fact, phase, input } = this.learn;
    const explanation = explanationForFact(fact.factorA, fact.factorB);
    const question = `${fact.factorA} × ${fact.factorB}`;

    if (phase === 'complete') {
      return `
        <main class="child-shell learn-shell complete-shell">
          ${this.renderChildHeader('Learn', 'home')}
          <section class="session-complete ${this.learn.independentCorrect ? 'complete-right' : 'complete-return'}">
            <span class="result-symbol">${this.learn.independentCorrect ? icon('check') : icon('rotate-ccw')}</span>
            <p class="eyebrow">${question} = ${fact.answer}</p>
            <h1>${this.learn.independentCorrect ? 'You remembered it' : 'We’ll bring it back'}</h1>
            <div class="complete-actions">
              <button class="primary-button learn-button" type="button" data-action="learn-another">${icon('book-open')} Learn another</button>
              <button class="secondary-button" type="button" data-action="learn-practice">${icon('brain')} Practice</button>
            </div>
          </section>
        </main>
      `;
    }

    if (phase === 'explain') {
      return `
        <main class="child-shell learn-shell">
          ${this.renderChildHeader('Learn', 'home')}
          <section class="lesson-stage">
            <p class="eyebrow">${question}</p>
            <h1>${escapeHtml(explanation.title)}</h1>
            <div class="fact-visual-wrap">${renderFactVisual(fact.factorA, fact.factorB)}</div>
            <p class="lesson-short">${escapeHtml(explanation.short)}</p>
            <p class="lesson-equation">${escapeHtml(explanation.equation)}</p>
          </section>
          <footer class="lesson-footer">
            <button class="primary-button learn-button" type="button" data-action="learn-try">Try it ${icon('chevron-right')}</button>
          </footer>
        </main>
      `;
    }

    const corrective = phase === 'guided-correction' || phase === 'correction';
    const independent = phase === 'independent' || phase === 'correction';
    return `
      <main class="child-shell learn-shell question-shell">
        ${this.renderChildHeader(independent ? 'Your turn' : 'Build it', 'home')}
        <section class="question-stage">
          ${!independent || corrective ? `<div class="compact-visual">${renderFactVisual(fact.factorA, fact.factorB)}</div>` : ''}
          ${corrective ? `
            <div class="correction-copy" role="status">
              <strong>${fact.factorA} groups of ${fact.factorB} make ${fact.answer}</strong>
              <span>Type ${fact.answer}</span>
            </div>
          ` : ''}
          <div class="equation ${corrective ? 'equation-small' : ''}">
            <span>${question}</span><span>=</span><output aria-label="Your answer">${input || '?'}</output>
          </div>
        </section>
        ${renderKeypad(input)}
      </main>
    `;
  }

  private renderPractice(): string {
    if (!this.practice) return this.renderHome();
    const state = this.practice;
    const fact = state.current;

    if (state.phase === 'complete') {
      return `
        <main class="child-shell practice-shell complete-shell">
          ${this.renderChildHeader('Practice', 'home')}
          <section class="session-complete complete-right">
            <span class="result-symbol">${icon('check')}</span>
            <p class="eyebrow">Set complete</p>
            <h1>${state.correct} of ${state.answered}</h1>
            <p class="complete-note">answered first time</p>
            <div class="complete-actions">
              <button class="primary-button practice-button" type="button" data-action="start-practice">${icon('play')} Another set</button>
              <button class="secondary-button" type="button" data-action="home">${icon('home')} Home</button>
            </div>
          </section>
        </main>
      `;
    }

    const total = state.target;
    const currentNumber = state.phase === 'answer' ? state.answered + 1 : state.answered;
    const progress = total
      ? `<div class="child-progress"><span>${Math.min(currentNumber, total)} / ${total}</span>${renderProgressBar(state.answered, total, 'Practice progress')}</div>`
      : `<div class="child-progress open-progress"><span>${state.answered} done</span></div>`;
    const correction = state.phase === 'correction' || state.phase === 'corrected';
    const feedback = state.phase === 'right' || state.phase === 'corrected';

    return `
      <main class="child-shell practice-shell question-shell">
        ${this.renderChildHeader('Practice', 'practice-end')}
        ${progress}
        <section class="question-stage ${feedback ? 'has-feedback' : ''}">
          ${correction ? `
            <div class="practice-correction" role="status">
              <div class="compact-visual">${renderFactVisual(fact.factorA, fact.factorB)}</div>
              <p><strong>${fact.factorA} groups of ${fact.factorB} make ${fact.factorA * fact.factorB}</strong><span>Type the correct answer</span></p>
            </div>
          ` : ''}
          <div class="equation ${correction ? 'equation-small' : ''}">
            <span>${fact.factorA} × ${fact.factorB}</span><span>=</span>
            <output aria-label="Your answer">${feedback && state.phase === 'right' ? fact.factorA * fact.factorB : state.input || '?'}</output>
          </div>
          ${state.phase === 'right' ? '<p class="answer-feedback right-feedback" role="status">Yes</p>' : ''}
          ${state.phase === 'corrected' ? '<p class="answer-feedback right-feedback" role="status">That’s it</p>' : ''}
        </section>
        ${renderKeypad(state.input, feedback)}
      </main>
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

  private renderParent(): string {
    const tabs: Array<{ id: ParentTab; label: string; iconName: string }> = [
      { id: 'progress', label: 'Progress', iconName: 'bar-chart-3' },
      { id: 'tests', label: 'Tests', iconName: 'clipboard-check' },
      { id: 'settings', label: 'Settings', iconName: 'settings' },
    ];
    const view = this.parentTab === 'progress'
      ? this.renderProgressView()
      : this.parentTab === 'tests'
        ? this.renderTestsView()
        : this.renderSettingsView();

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
    const recentPractice = this.data.practiceHistory.slice(-3).reverse();
    const recentTests = this.data.testHistory.filter((result) => result.status !== 'abandoned').slice(-3).reverse();

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
        ` : '<p class="empty-copy">Practice answers will appear here.</p>'}
        ${slowFacts.length ? `<div class="slow-row"><span>Correct but slow</span>${slowFacts.map((fact) => `<button type="button" data-action="inspect-fact" data-key="${fact.key}">${fact.factorA}×${fact.factorB}</button>`).join('')}</div>` : ''}
        ${oftenMissed.length ? `<div class="slow-row"><span>Often missed</span>${oftenMissed.map((fact) => `<button type="button" data-action="inspect-fact" data-key="${fact.key}">${fact.factorA}×${fact.factorB}</button>`).join('')}</div>` : ''}
        ${recentlySecure.length ? `<div class="slow-row"><span>Recently secure</span>${recentlySecure.map((fact) => `<button type="button" data-action="inspect-fact" data-key="${fact.key}">${fact.factorA}×${fact.factorB}</button>`).join('')}</div>` : ''}
        <details class="how-it-works">
          <summary>${icon('info')} How practice chooses</summary>
          <p>Practice aims near 75% recall: fading facts, recent mistakes and new facts get priority. A missed fact returns after 3–5 different questions, then at longer gaps. Corrected answers do not count as mastery.</p>
        </details>
      </section>

      <section class="parent-section activity-section">
        <div class="section-heading"><div><p class="eyebrow">History</p><h2>Recent activity</h2></div></div>
        <div class="activity-columns">
          <div>
            <h3>Practice</h3>
            ${recentPractice.length ? recentPractice.map((session) => `
              <div class="activity-item"><span class="activity-icon practice-icon">${icon('brain')}</span><p><strong>${session.mode === 'learn' ? 'Learn' : `${session.answered} questions`}</strong><span>${session.independentCorrect} first-time correct · ${formatAgo(session.finishedAt)}</span></p></div>
            `).join('') : '<p class="empty-copy">No sessions yet.</p>'}
          </div>
          <div>
            <h3>Tests</h3>
            ${recentTests.length ? recentTests.map((result) => `
              <div class="activity-item"><span class="activity-icon ${result.status === 'passed' ? 'passed-icon' : 'failed-icon'}">${result.status === 'passed' ? icon('check') : icon('x')}</span><p><strong>${result.status === 'passed' ? 'Pass' : 'Not yet'} · ${result.correct}/${result.config.questionCount}</strong><span>${escapeHtml(result.presetName ?? 'Custom test')} · ${formatAgo(result.finishedAt)}</span></p></div>
            `).join('') : '<p class="empty-copy">No completed tests yet.</p>'}
          </div>
        </div>
      </section>
    `;
  }

  private renderTestsView(): string {
    const needed = requiredCorrect(this.draftTest);
    return `
      <section class="parent-section test-presets-section">
        <div class="section-heading"><div><p class="eyebrow">Quick start</p><h1>Just Test</h1></div></div>
        <div class="preset-list">
          ${this.data.presets.map((preset) => `
            <div class="preset-row">
              <span class="preset-icon">${preset.id === 'restaurant-test' ? icon('utensils') : icon('clipboard-check')}</span>
              <p><strong>${escapeHtml(preset.name)}</strong><span>${preset.config.questionCount} questions · need ${requiredCorrect(preset.config)} · ${preset.config.tables.join(', ')}</span></p>
              ${preset.id !== 'restaurant-test' ? `<button class="icon-button subtle-button" type="button" data-action="delete-preset" data-id="${escapeHtml(preset.id)}" aria-label="Delete ${escapeHtml(preset.name)}">${icon('trash-2')}</button>` : ''}
              <button class="play-button" type="button" data-action="start-preset" data-id="${escapeHtml(preset.id)}" aria-label="Start ${escapeHtml(preset.name)}">${icon('play')}</button>
            </div>
          `).join('')}
        </div>
      </section>

      <section class="parent-section test-builder-section">
        <div class="section-heading"><div><p class="eyebrow">New test</p><h2>Set the gate</h2></div></div>
        <div class="form-group">
          <div class="form-label"><strong>Tables</strong><span>${this.draftTest.tables.length} selected</span></div>
          ${this.renderTableSelector(this.draftTest.tables, 'test')}
        </div>
        <div class="form-group">
          <div class="form-label"><strong>Questions</strong></div>
          <div class="segmented-control three-segments">
            ${[20, 50, 100].map((count) => `<button type="button" class="${this.draftTest.questionCount === count ? 'active' : ''}" data-action="set-test-count" data-value="${count}">${count}</button>`).join('')}
          </div>
        </div>
        <div class="form-split">
          <div class="form-group">
            <div class="form-label"><strong>Pass mark</strong></div>
            <div class="segmented-control two-segments compact-segments">
              <button type="button" class="${this.draftTest.passMode === 'count' ? 'active' : ''}" data-action="set-pass-mode" data-value="count">Number</button>
              <button type="button" class="${this.draftTest.passMode === 'percent' ? 'active' : ''}" data-action="set-pass-mode" data-value="percent">Percent</button>
            </div>
          </div>
          <div class="form-group">
            <div class="form-label"><strong>Required</strong><span>${needed} of ${this.draftTest.questionCount}</span></div>
            <div class="stepper">
              <button type="button" data-action="step-pass" data-amount="-1" aria-label="Decrease pass mark">${icon('minus')}</button>
              <input type="number" data-action="pass-value" min="1" max="${this.draftTest.passMode === 'count' ? this.draftTest.questionCount : 100}" value="${this.draftTest.passValue}" aria-label="Required ${this.draftTest.passMode === 'count' ? 'correct answers' : 'percentage'}" />
              <span>${this.draftTest.passMode === 'percent' ? '%' : ''}</span>
              <button type="button" data-action="step-pass" data-amount="1" aria-label="Increase pass mark">${icon('plus')}</button>
            </div>
          </div>
        </div>
        <button class="switch-row" type="button" role="switch" aria-checked="${this.draftTest.includeDivision}" data-action="toggle-division">
          <span><strong>Related division</strong><small>Mix in questions such as 35 ÷ 5</small></span>
          <i class="switch ${this.draftTest.includeDivision ? 'on' : ''}"><b></b></i>
        </button>
        <div class="builder-actions">
          <button class="secondary-button" type="button" data-action="save-preset">${icon('save')} Save preset</button>
          <button class="primary-button test-button" type="button" data-action="start-custom-test">${icon('play')} Start test</button>
        </div>
      </section>
    `;
  }

  private renderSettingsView(): string {
    const target = this.data.settings.practiceTarget;
    return `
      <section class="parent-section settings-section">
        <div class="section-heading"><div><p class="eyebrow">Learning</p><h1>Settings</h1></div></div>
        <div class="form-group">
          <div class="form-label"><strong>Active tables</strong><span>${this.data.settings.activeTables.length} selected</span></div>
          ${this.renderTableSelector(this.data.settings.activeTables, 'settings')}
        </div>
        <div class="form-group">
          <div class="form-label"><strong>Practice set</strong></div>
          <div class="segmented-control four-segments">
            ${[10, 20, 30, 'open'].map((value) => {
              const selected = value === 'open' ? target === null : target === value;
              return `<button type="button" class="${selected ? 'active' : ''}" data-action="set-practice-target" data-value="${value}">${value === 'open' ? 'Open' : value}</button>`;
            }).join('')}
          </div>
        </div>
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
        <p class="storage-note">Version ${this.data.version} · saved automatically on this device</p>
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

  private renderTableSelector(selected: number[], context: string): string {
    const groups = [
      { id: 'core', label: 'Core', detail: '2, 3, 5, 10', tables: CORE_TABLES },
      { id: 'beyond', label: 'Beyond core', detail: 'the other 8', tables: BEYOND_CORE_TABLES },
      { id: 'all', label: 'All 1–12', detail: 'every table', tables: ALL_TABLES },
    ];
    return `
      <div class="table-quick-sets" aria-label="Quick table choices">
        ${groups.map((group) => `
          <button type="button" class="${this.sameTableSelection(selected, group.tables) ? 'active' : ''}" data-action="set-table-group" data-context="${context}" data-group="${group.id}">
            <strong>${group.label}</strong><small>${group.detail}</small>
          </button>
        `).join('')}
      </div>
      <div class="table-selector" aria-label="Times tables">
        ${ALL_TABLES.map((table) => `
          <button type="button" class="${selected.includes(table) ? 'active' : ''}" data-action="toggle-table" data-context="${context}" data-table="${table}" aria-pressed="${selected.includes(table)}">${table}</button>
        `).join('')}
      </div>
    `;
  }

  private renderTest(): string {
    const active = this.data.activeTest;
    if (!active) return this.latestResult ? this.renderTestResult() : this.renderHome();
    const index = active.answers.length;
    const question = active.questions[index];
    const total = active.config.questionCount;

    return `
      <main class="child-shell strict-test-shell question-shell">
        <header class="test-header">
          <span class="test-badge">Just Test</span>
          <strong>${index + 1} / ${total}</strong>
          <button class="icon-button" type="button" data-action="test-exit" aria-label="Leave test">${icon('x')}</button>
        </header>
        <div class="test-progress">${renderProgressBar(index, total, 'Test progress')}</div>
        <section class="question-stage">
          <div class="equation test-equation">
            <span>${question.left} ${question.operator} ${question.right}</span><span>=</span><output aria-label="Your answer">${this.testInput || '?'}</output>
          </div>
        </section>
        ${renderKeypad(this.testInput)}
      </main>
    `;
  }

  private renderTestResult(): string {
    const result = this.latestResult ?? this.data.testHistory.at(-1);
    if (!result || result.status === 'abandoned') return this.renderHome();
    const passed = result.status === 'passed';
    const needed = requiredCorrect(result.config);
    const missed = result.questions.filter((question) => {
      const answer = result.answers.find((item) => item.questionId === question.id);
      return answer && !answer.correct;
    });

    return `
      <main class="result-shell ${passed ? 'pass-result' : 'fail-result'}">
        <header class="result-header"><span>Danny Times</span><strong>${escapeHtml(result.presetName ?? 'Just Test')}</strong></header>
        <section class="result-main">
          <span class="result-stamp">${passed ? icon('shield-check') : icon('rotate-ccw')}</span>
          <p class="result-word">${passed ? 'PASS' : 'NOT YET'}</p>
          <h1>${result.correct} / ${result.config.questionCount} correct</h1>
          ${passed ? `<p class="pass-line">Pass mark ${needed}</p>` : `<p class="pass-line">Pass mark: ${needed}</p>`}
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
                return `<p><span>${question.left} ${question.operator} ${question.right}</span><s>${answer.answer}</s><strong>${question.answer}</strong></p>`;
              }).join('')}</div>
            </details>
          ` : ''}
          <div class="result-actions">
            ${!passed ? `<button class="primary-button test-button" type="button" data-action="retry-test">${icon('rotate-ccw')} New test</button>` : ''}
            <button class="${passed ? 'primary-button test-button' : 'secondary-button'}" type="button" data-action="home">${icon('home')} Home</button>
          </div>
        </section>
      </main>
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
            <h2 id="gate-title">Hold to open</h2>
            <button class="hold-button" type="button" data-action="hold-parent"><span>${icon('lock-keyhole')} Press and hold</span><i></i></button>
          </section>
        </div>
      `);
    }
    if (this.resumePrompt && this.data.activeTest) {
      const active = this.data.activeTest;
      overlays.push(`
        <div class="modal-backdrop" role="presentation">
          <section class="modal resume-modal" role="dialog" aria-modal="true" aria-labelledby="resume-title">
            <span class="modal-symbol test-symbol">${icon('pause')}</span>
            <p class="eyebrow">Test in progress</p>
            <h2 id="resume-title">${active.answers.length} of ${active.config.questionCount} answered</h2>
            <div class="modal-actions">
              <button class="primary-button test-button" type="button" data-action="resume-test">${icon('play')} Resume</button>
              <button class="secondary-button" type="button" data-action="confirm-abandon">End test</button>
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
            <p class="eyebrow">Just Test</p>
            <h2 id="abandon-title">End this test?</h2>
            <p class="modal-copy">It will be recorded as abandoned, never as a pass.</p>
            <div class="modal-actions">
              <button class="danger-button" type="button" data-action="confirm-abandon">End test</button>
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
            <p class="modal-copy">Progress, test history, settings and presets will be removed from this device.${this.data.sync ? ' Family sync will be turned off and the cloud copy cleared.' : ''}</p>
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

  private openParentGate(destination: ParentTab): void {
    this.gateDestination = destination;
    this.gateOpen = true;
    this.render();
  }

  private unlockParent(): void {
    this.cancelParentHold();
    this.gateOpen = false;
    this.parentTab = this.gateDestination;
    this.screen = 'parent';
    this.render();
  }

  private goHome(): void {
    this.clearTransition();
    this.screen = 'home';
    this.practice = null;
    this.learn = null;
    this.latestResult = null;
    this.render();
  }

  private startLearn(avoidKey?: FactKey): void {
    this.clearTransition();
    const candidates = factsForTables(this.data.settings.activeTables)
      .map((fact) => {
        const progress = this.data.facts[fact.key];
        const label = memoryLabel(progress);
        let score = label === 'New' ? 10 : label === 'Learning' ? 7 : 2;
        score += weaknessScore(progress) * 4 + Math.random();
        if (fact.key === avoidKey) score -= 8;
        return { fact, score };
      })
      .sort((a, b) => b.score - a.score);
    const fact = candidates[0].fact;
    this.learn = {
      id: this.makeId('learn'),
      startedAt: Date.now(),
      fact,
      input: '',
      phase: 'explain',
      questionStartedAt: Date.now(),
      independentCorrect: false,
      completed: false,
    };
    this.screen = 'learn';
    this.render();
  }

  private startPractice(): void {
    this.clearTransition();
    const id = this.makeId('practice');
    const current = choosePracticeFact({
      tables: this.data.settings.activeTables,
      facts: this.data.facts,
      recent: [],
      retries: [],
      answered: 0,
    });
    this.practice = {
      id,
      startedAt: Date.now(),
      target: this.data.settings.practiceTarget,
      answered: 0,
      correct: 0,
      current,
      recent: [],
      retries: [],
      factKeys: [],
      input: '',
      phase: 'answer',
      questionStartedAt: Date.now(),
      completed: false,
    };
    this.screen = 'practice';
    this.render();
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

  private currentInput(): string | null {
    if (this.screen === 'practice' && this.practice && ['answer', 'correction'].includes(this.practice.phase)) return this.practice.input;
    if (this.screen === 'learn' && this.learn && !['explain', 'complete'].includes(this.learn.phase)) return this.learn.input;
    if (this.screen === 'test' && this.data.activeTest && !this.resumePrompt && !this.abandonPrompt) return this.testInput;
    return null;
  }

  private setCurrentInput(value: string): void {
    if (this.screen === 'practice' && this.practice) this.practice.input = value;
    if (this.screen === 'learn' && this.learn) this.learn.input = value;
    if (this.screen === 'test') this.testInput = value;
  }

  private submitCurrentAnswer(): void {
    const input = this.currentInput();
    if (!input) return;
    const answer = Number(input);
    if (this.screen === 'practice') this.submitPracticeAnswer(answer);
    if (this.screen === 'learn') this.submitLearnAnswer(answer);
    if (this.screen === 'test') this.submitTestAnswer(answer);
  }

  private submitLearnAnswer(answer: number): void {
    if (!this.learn) return;
    const state = this.learn;
    const correctAnswer = state.fact.answer;
    const responseMs = Math.max(200, Date.now() - state.questionStartedAt);

    if (state.phase === 'guided') {
      this.updateFact(state.fact, answer === correctAnswer, false, responseMs, state.id, 'learn');
      state.input = '';
      if (answer === correctAnswer) {
        if (this.data.settings.soundEnabled) playAnswerSound(true);
        state.phase = 'independent';
        state.questionStartedAt = Date.now();
      } else {
        if (this.data.settings.soundEnabled) playAnswerSound(false);
        state.phase = 'guided-correction';
      }
      this.persist();
      this.render();
      return;
    }

    if (state.phase === 'guided-correction') {
      if (answer !== correctAnswer) {
        if (this.data.settings.soundEnabled) playAnswerSound(false);
        state.input = '';
        this.render();
        return;
      }
      this.updateFact(state.fact, true, false, responseMs, state.id, 'learn');
      state.input = '';
      state.phase = 'independent';
      state.questionStartedAt = Date.now();
      if (this.data.settings.soundEnabled) playAnswerSound(true);
      this.persist();
      this.render();
      return;
    }

    if (state.phase === 'independent') {
      const correct = answer === correctAnswer;
      this.updateFact(state.fact, correct, true, responseMs, state.id, 'learn');
      state.input = '';
      if (this.data.settings.soundEnabled) playAnswerSound(correct);
      if (correct) {
        state.independentCorrect = true;
        this.completeLearn();
      } else {
        state.phase = 'correction';
        this.persist();
        this.render();
      }
      return;
    }

    if (state.phase === 'correction') {
      if (answer !== correctAnswer) {
        if (this.data.settings.soundEnabled) playAnswerSound(false);
        state.input = '';
        this.render();
        return;
      }
      this.updateFact(state.fact, true, false, responseMs, state.id, 'learn');
      if (this.data.settings.soundEnabled) playAnswerSound(true);
      this.completeLearn();
    }
  }

  private completeLearn(): void {
    if (!this.learn || this.learn.completed) return;
    this.learn.completed = true;
    this.learn.phase = 'complete';
    const summary: PracticeSessionSummary = {
      id: this.learn.id,
      mode: 'learn',
      startedAt: this.learn.startedAt,
      finishedAt: Date.now(),
      answered: 1,
      independentCorrect: this.learn.independentCorrect ? 1 : 0,
      target: 1,
      factKeys: [this.learn.fact.key],
    };
    this.data.practiceHistory = [...this.data.practiceHistory, summary].slice(-100);
    this.persist();
    this.render();
  }

  private submitPracticeAnswer(answer: number): void {
    if (!this.practice) return;
    const state = this.practice;
    const descriptor = parseFactKey(state.current.key);
    const correctAnswer = descriptor.answer;
    const responseMs = Math.max(200, Date.now() - state.questionStartedAt);

    if (state.phase === 'answer') {
      const correct = answer === correctAnswer;
      this.updateFact(descriptor, correct, true, responseMs, state.id, 'practice');
      state.answered += 1;
      state.factKeys.push(descriptor.key);
      state.recent.push(descriptor.key);
      state.recent = state.recent.slice(-6);
      state.input = '';
      if (correct) {
        state.correct += 1;
        state.phase = 'right';
      } else {
        state.phase = 'correction';
        state.retries = scheduleRetry(state.retries, descriptor.key, state.answered);
      }
      if (this.data.settings.soundEnabled) playAnswerSound(correct);
      this.persist();
      if (correct) this.afterFeedback(480, () => this.advancePractice());
      this.render();
      return;
    }

    if (state.phase === 'correction') {
      if (answer !== correctAnswer) {
        state.input = '';
        if (this.data.settings.soundEnabled) playAnswerSound(false);
        this.render();
        return;
      }
      this.updateFact(descriptor, true, false, responseMs, state.id, 'practice');
      state.input = '';
      state.phase = 'corrected';
      if (this.data.settings.soundEnabled) playAnswerSound(true);
      this.persist();
      this.afterFeedback(650, () => this.advancePractice());
      this.render();
    }
  }

  private advancePractice(): void {
    if (!this.practice) return;
    const state = this.practice;
    if (state.target !== null && state.answered >= state.target) {
      this.finishPractice();
      this.render();
      return;
    }
    if (state.current.reason === 'retry') {
      state.retries = state.retries.filter((item) => item.factKey !== state.current.key);
    }
    state.current = choosePracticeFact({
      tables: this.data.settings.activeTables,
      facts: this.data.facts,
      recent: state.recent,
      retries: state.retries,
      answered: state.answered,
    });
    state.input = '';
    state.phase = 'answer';
    state.questionStartedAt = Date.now();
    this.render();
  }

  private finishPractice(): void {
    if (!this.practice || this.practice.completed) return;
    this.clearTransition();
    this.practice.completed = true;
    this.practice.phase = 'complete';
    if (this.practice.answered > 0) {
      const summary: PracticeSessionSummary = {
        id: this.practice.id,
        mode: 'practice',
        startedAt: this.practice.startedAt,
        finishedAt: Date.now(),
        answered: this.practice.answered,
        independentCorrect: this.practice.correct,
        target: this.practice.target,
        factKeys: [...new Set(this.practice.factKeys)],
      };
      this.data.practiceHistory = [...this.data.practiceHistory, summary].slice(-100);
      this.persist();
    }
  }

  private updateFact(
    descriptor: FactDescriptor,
    correct: boolean,
    independent: boolean,
    responseMs: number,
    sessionId: string,
    source: 'learn' | 'practice',
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

  private startTest(config: TestConfig, presetName: string | null): void {
    if (!config.tables.length) {
      this.showToast('Choose at least one table');
      return;
    }
    const cleanConfig: TestConfig = {
      ...config,
      tables: [...new Set(config.tables)].sort((a, b) => a - b),
      questionCount: clamp(Math.round(config.questionCount), 1, 100),
      passValue: config.passMode === 'count'
        ? clamp(Math.round(config.passValue), 1, config.questionCount)
        : clamp(Math.round(config.passValue), 1, 100),
    };
    const seed = createSeed();
    const active: ActiveTest = {
      id: this.makeId('test'),
      presetName,
      config: cleanConfig,
      seed,
      startedAt: Date.now(),
      questions: generateTestQuestions(cleanConfig, seed),
      answers: [],
    };
    this.data.activeTest = active;
    this.latestResult = null;
    this.testInput = '';
    this.testQuestionStartedAt = Date.now();
    this.resumePrompt = false;
    this.abandonPrompt = false;
    this.screen = 'test';
    this.persist();
    this.render();
  }

  private submitTestAnswer(answer: number): void {
    const active = this.data.activeTest;
    if (!active) return;
    this.data.activeTest = answerTest(active, answer, Math.max(200, Date.now() - this.testQuestionStartedAt));
    this.testInput = '';
    if (this.data.activeTest.answers.length === this.data.activeTest.questions.length) {
      const result = finishTest(this.data.activeTest);
      this.data.testHistory = [...this.data.testHistory, result].slice(-100);
      this.data.activeTest = null;
      this.latestResult = result;
      this.screen = 'test-result';
    } else {
      this.testQuestionStartedAt = Date.now();
    }
    this.persist();
    this.render();
  }

  private confirmAbandon(): void {
    const active = this.data.activeTest;
    if (active) {
      this.data.testHistory = [...this.data.testHistory, abandonTest(active)].slice(-100);
      this.data.activeTest = null;
      this.persist();
    }
    this.abandonPrompt = false;
    this.resumePrompt = false;
    this.screen = 'home';
    this.render();
  }

  private startPreset(id: string): void {
    const preset = this.data.presets.find((item) => item.id === id);
    if (preset) this.startTest(preset.config, preset.name);
  }

  private toggleTable(table: number, context: string): void {
    if (!ALL_TABLES.includes(table)) return;
    const current = context === 'test' ? this.draftTest.tables : this.data.settings.activeTables;
    if (current.includes(table) && current.length === 1) {
      this.showToast('Keep at least one table selected');
      return;
    }
    const next = current.includes(table) ? current.filter((item) => item !== table) : [...current, table].sort((a, b) => a - b);
    if (context === 'test') {
      this.draftTest.tables = next;
    } else {
      this.data.settings.activeTables = next;
      if (!next.includes(this.progressTable)) this.progressTable = next[0];
      this.touchSettings();
      this.persist();
    }
    this.render();
  }

  private setTableGroup(group: string, context: string): void {
    const tables = group === 'core'
      ? [...CORE_TABLES]
      : group === 'beyond'
        ? [...BEYOND_CORE_TABLES]
        : [...ALL_TABLES];
    if (context === 'test') {
      this.draftTest.tables = tables;
    } else {
      this.data.settings.activeTables = tables;
      if (!tables.includes(this.progressTable)) this.progressTable = tables[0];
      this.touchSettings();
      this.persist();
    }
    this.render();
  }

  private setPracticeTarget(value: string): void {
    this.data.settings.practiceTarget = value === 'open' ? null : Number(value) as 10 | 20 | 30;
    this.touchSettings();
    this.persist();
    this.render();
  }

  private setTestCount(count: number): void {
    if (![20, 50, 100].includes(count)) return;
    this.draftTest.questionCount = count;
    if (this.draftTest.passMode === 'count') this.draftTest.passValue = Math.min(this.draftTest.passValue, count);
    this.render();
  }

  private setPassMode(mode: TestConfig['passMode']): void {
    if (mode === this.draftTest.passMode) return;
    if (mode === 'percent') {
      this.draftTest.passValue = Math.round(this.draftTest.passValue / this.draftTest.questionCount * 100);
    } else {
      this.draftTest.passValue = Math.ceil(this.draftTest.questionCount * this.draftTest.passValue / 100);
    }
    this.draftTest.passMode = mode;
    this.render();
  }

  private stepPass(amount: number): void {
    const max = this.draftTest.passMode === 'count' ? this.draftTest.questionCount : 100;
    this.draftTest.passValue = clamp(this.draftTest.passValue + amount, 1, max);
    this.render();
  }

  private savePreset(): void {
    const name = window.prompt('Preset name', 'My test')?.trim();
    if (!name) return;
    this.data.presets = [
      ...this.data.presets,
      {
        id: this.makeId('preset'),
        name: name.slice(0, 40),
        config: { ...this.draftTest, tables: [...this.draftTest.tables] },
      },
    ];
    this.touchSettings();
    this.persist();
    this.showToast('Preset saved');
  }

  private deletePreset(id: string): void {
    this.data.presets = this.data.presets.filter((preset) => preset.id !== id || preset.id === 'restaurant-test');
    this.touchSettings();
    this.persist();
    this.render();
  }

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
    this.draftTest = { ...defaultTestConfig(), tables: [...this.data.settings.activeTables] };
    this.resetPrompt = false;
    this.parentTab = 'settings';
    this.syncStatus = 'idle';
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
