import {
  ArrowLeft,
  BarChart3,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  createIcons,
  Delete,
  Download,
  Gamepad2,
  Home,
  Info,
  LockKeyhole,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Target,
  Trash2,
  Upload,
  Utensils,
  Volume2,
  VolumeX,
  X,
} from 'lucide';
import { explanationForFact } from '../core/facts';

const ICONS = {
  ArrowLeft,
  BarChart3,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Delete,
  Download,
  Gamepad2,
  Home,
  Info,
  LockKeyhole,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Target,
  Trash2,
  Upload,
  Utensils,
  Volume2,
  VolumeX,
  X,
};

export function refreshIcons(): void {
  createIcons({ icons: ICONS });
}

export function icon(name: string): string {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

export function renderKeypad(input: string, disabled = false): string {
  const numberKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((number) => `<button class="key" type="button" data-action="key" data-key="${number}" ${disabled ? 'disabled' : ''}>${number}</button>`)
    .join('');

  return `
    <div class="keypad" aria-label="Number keypad">
      ${numberKeys}
      <button class="key key-icon" type="button" data-action="backspace" aria-label="Delete last number" ${disabled || !input ? 'disabled' : ''}>${icon('delete')}</button>
      <button class="key" type="button" data-action="key" data-key="0" ${disabled ? 'disabled' : ''}>0</button>
      <button class="key key-submit" type="button" data-action="submit-answer" aria-label="Check answer" ${disabled || !input ? 'disabled' : ''}>${icon('check')}</button>
    </div>
  `;
}

export function renderFactVisual(factorA: number, factorB: number): string {
  const explanation = explanationForFact(factorA, factorB);
  if (explanation.visual === 'pairs') {
    return `<div class="pair-visual" aria-label="${factorA} pairs">${Array.from({ length: factorA }, () => '<span><b></b><b></b></span>').join('')}</div>`;
  }
  if (explanation.visual === 'groups') {
    return `<div class="group-visual" aria-label="${factorA} groups of three">${Array.from({ length: factorA }, () => '<span><b></b><b></b><b></b></span>').join('')}</div>`;
  }
  if (explanation.visual === 'fives') {
    return `<div class="five-track" aria-label="Counting in fives">${Array.from({ length: factorA }, (_, index) => `<span>${(index + 1) * 5}</span>`).join('')}</div>`;
  }
  if (explanation.visual === 'tens') {
    return `<div class="ten-visual" aria-label="${factorA} tens">${Array.from({ length: factorA }, () => `<span>${Array.from({ length: 10 }, () => '<b></b>').join('')}</span>`).join('')}</div>`;
  }
  return `<div class="array-visual" style="--columns:${factorB}" aria-label="${factorA} rows of ${factorB}">${Array.from({ length: factorA * factorB }, () => '<b></b>').join('')}</div>`;
}

export function renderProgressBar(current: number, total: number, label: string): string {
  const percent = total <= 0 ? 0 : Math.min(100, Math.round(current / total * 100));
  return `
    <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${current}" aria-label="${escapeHtml(label)}">
      <span style="width:${percent}%"></span>
    </div>
  `;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!);
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

export function formatAgo(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
