import { safe } from '@repoRules/github';
import { type TerminalStyle, terminalStyle } from '@repoRules/prompts';
import { type Read, stateLabel } from '@repoRules/state';

export type Output = { write(text: string): unknown; isTTY?: boolean | undefined };

/** Terminal output. Every value from GitHub passes through `safe` before styles add control sequences. */
export class Ui {
  readonly style: TerminalStyle;
  private readonly out: Output;
  constructor(out: Output, style: TerminalStyle = terminalStyle(out)) {
    this.out = out;
    this.style = style;
  }
  line(text = ''): void {
    this.out.write(`${text}\n`);
  }
  heading(index: number, total: number, title: string): void {
    const rule = '─'.repeat(48);
    this.line();
    this.line(this.style.muted(rule));
    this.line(this.style.strong(`[${index}/${total}] ${title.toUpperCase()}`));
    this.line(this.style.muted(rule));
  }
  section(title: string): void {
    this.line();
    this.line(this.style.strong(safe(title)));
  }
  /** Aligned "label: value" rows. Labels and values can come from GitHub and are sanitized. */
  rows(rows: readonly (readonly [string, string])[], indent = 2): void {
    const width = Math.min(32, Math.max(0, ...rows.map(([label]) => label.length)) + 1);
    for (const [label, value] of rows) this.line(`${' '.repeat(indent)}${`${safe(label)}:`.padEnd(width + 1)} ${safe(value)}`);
  }
  text(value: string, indent = 2): void {
    for (const part of safe(value, true).split('\n')) this.line(`${' '.repeat(indent)}${part}`);
  }
  info(text: string): void {
    this.line(`  ${this.style.muted(safe(text))}`);
  }
  warn(text: string): void {
    this.line(`  ${this.style.warning('[!]')} ${safe(text)}`);
  }
  error(text: string): void {
    this.line(`${this.style.error('Ошибка:')} ${safe(text)}`);
  }
  json(value: unknown): void {
    this.text(JSON.stringify(value, null, 2));
  }
}

export function yesNo(value: boolean | undefined): string {
  return value === undefined ? 'Неизвестно' : value ? 'Да' : 'Нет';
}

export function onOff(value: boolean | undefined): string {
  return value === undefined ? 'Неизвестно' : value ? 'Включено' : 'Выключено';
}

/** Show a value or the reason why it is missing. */
export function shown<T>(read: Read<T>, format: (value: T) => string): string {
  return read.ok ? format(read.value) : stateLabel(read.state);
}

/** Format a plain JSON value for one table cell. */
export function plain(value: unknown): string {
  if (value === undefined) return 'Неизвестно';
  if (value === null) return 'Не задано';
  if (typeof value === 'boolean') return yesNo(value);
  if (typeof value === 'string') return value === '' ? '(пусто)' : value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => plain(item)).join(', ') : '(нет)';
  return JSON.stringify(value);
}

/** Cut long text for display and say how much is hidden. */
export function clip(value: string, limit = 200): string {
  return value.length > limit ? `${value.slice(0, limit)}… (ещё ${value.length - limit} символов)` : value;
}
