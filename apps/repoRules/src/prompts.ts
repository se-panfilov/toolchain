import { stdin, stdout } from 'node:process';
import { clearScreenDown, createInterface, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';

export class PromptCancelled extends Error {
  constructor() {
    super('Ввод отменён.');
  }
}
type Key = { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string };
function safe(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '?');
}

export type Choice = { label: string; checked?: boolean };

/** The questions that the migration flow asks. Tests use a scripted implementation. */
export interface Asker {
  select(question: string, choices: readonly string[], initial?: number): Promise<number>;
  checkbox(question: string, choices: readonly Choice[]): Promise<number[]>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  text(question: string, initial?: string): Promise<string>;
  /** Hidden input. The value is never shown, also not as a mask. */
  secret(question: string): Promise<string>;
}

// Add ANSI colors only after text sanitization. Keep pipe output without colors.
export type TerminalStyle = Record<'plain' | 'accent' | 'muted' | 'strong' | 'success' | 'warning' | 'error', (text: string) => string>;
export function terminalStyle(output: { isTTY?: boolean | undefined } = stdout, env: Record<string, string | undefined> = process.env): TerminalStyle {
  const enabled = Boolean(output.isTTY) && env.TERM !== 'dumb' && !('NO_COLOR' in env) && env.FORCE_COLOR !== '0';
  const color = (code: number) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { plain: (text: string) => text, accent: color(36), muted: color(2), strong: color(1), success: color(32), warning: color(33), error: color(31) };
}

/** Each prompt owns its handlers and restores the TTY state. */
export class TerminalPrompts implements Asker {
  input: ReadStream;
  output: WriteStream;
  private style: ReturnType<typeof terminalStyle>;
  private active?: (() => void) | undefined;
  private closed = false;
  constructor(input: ReadStream = stdin, output: WriteStream = stdout) {
    this.input = input;
    this.output = output;
    this.style = terminalStyle(output);
  }
  close(): void {
    this.closed = true;
    this.active?.();
  }
  private check(): void {
    if (this.closed) throw new PromptCancelled();
    if (!this.input.isTTY || !this.output.isTTY) throw new Error('Нужен интерактивный терминал (TTY).');
    if (process.env.TERM === 'dumb') throw new Error('TERM=dumb не поддерживается. Нужен ANSI-терминал.');
  }

  async text(question: string, initial = ''): Promise<string> {
    this.check();
    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    const rl = createInterface({ input: this.input, output: this.output, terminal: true, historySize: 0 });
    let settled = false;
    let cancel = (): void => {};
    try {
      return await new Promise<string>((resolve, reject) => {
        cancel = () => {
          if (settled) return;
          settled = true;
          reject(new PromptCancelled());
        };
        this.active = cancel;
        rl.on('SIGINT', cancel);
        rl.on('close', cancel);
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        rl.question(`${this.style.accent('◆')} ${this.style.strong(safe(question))}: `, (value) => {
          if (settled) return;
          settled = true;
          resolve(value.trim());
        });
        // Put the initial value in the editable line, not in a label or placeholder.
        rl.write(safe(initial));
      });
    } finally {
      rl.removeListener('SIGINT', cancel);
      rl.removeListener('close', cancel);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      rl.close();
      this.input.setRawMode(wasRaw);
      if (wasFlowing) this.input.resume();
      else this.input.pause();
      this.active = undefined;
    }
  }

  /** Use radio buttons. Arrows move focus. Space selects an answer. */
  async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    return (await this.select(question, ['Да', 'Нет'], defaultYes ? 0 : 1)) === 0;
  }

  /** Run a raw-mode keypress session. `onKey` returns a value to finish, or undefined to continue. */
  private async raw<T>(header: string, render: (() => string) | undefined, onKey: (text: string | undefined, key: Key, pasting: boolean) => T | undefined): Promise<T> {
    this.check();
    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    let drawnLines = 0;
    let pasting = false;
    let settled = false;
    let cancel = (): void => {};
    let keypress = (_text: string | undefined, _key: Key): void => {};
    const draw = (): void => {
      if (!render) return;
      if (drawnLines) {
        moveCursor(this.output, 0, -drawnLines);
        cursorTo(this.output, 0);
        clearScreenDown(this.output);
      }
      const text = render();
      this.output.write(text);
      drawnLines = text.split('\n').length - 1;
    };
    try {
      return await new Promise<T>((resolve, reject) => {
        const finish = (value: T | undefined, error?: Error): void => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value as T);
        };
        cancel = () => {
          finish(undefined, new PromptCancelled());
        };
        this.active = cancel;
        keypress = (text, key = {}) => {
          if (settled) return;
          if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || (key.name === 'escape' && !pasting)) {
            cancel();
            return;
          }
          if (key.name === 'paste-start') {
            pasting = true;
            return;
          }
          if (key.name === 'paste-end') {
            pasting = false;
            return;
          }
          const result = onKey(text, key, pasting);
          if (result !== undefined) finish(result);
          else draw();
        };
        emitKeypressEvents(this.input);
        this.input.on('keypress', keypress);
        this.input.once('end', cancel);
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        this.input.setRawMode(true);
        this.input.resume();
        // Bracketed paste keeps pasted text from selecting or confirming an answer.
        this.output.write(`\x1b[?2004h${this.style.accent('◆')} ${this.style.strong(safe(header))}\n`);
        draw();
      });
    } finally {
      this.input.removeListener('keypress', keypress);
      this.input.removeListener('end', cancel);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      this.active = undefined;
      try {
        this.output.write('\x1b[?2004l');
      } finally {
        this.input.setRawMode(wasRaw);
        if (wasFlowing) this.input.resume();
        else this.input.pause();
      }
    }
  }

  /** Single choice: one radio button is selected at a time. */
  async select(question: string, choices: readonly string[], initial = 0): Promise<number> {
    if (!choices.length || !Number.isInteger(initial) || initial < 0 || initial >= choices.length) throw new Error('Некорректный список вариантов.');
    let selected = initial;
    let focused = selected;
    const render = (): string =>
      choices
        .map((label, index) => {
          const cursor = focused === index ? this.style.accent('›') : ' ';
          const mark = selected === index ? this.style.success('◉') : this.style.muted('○');
          const text = focused === index ? this.style.accent(safe(label)) : this.style.muted(safe(label));
          return `  ${cursor} ${mark} ${text}\n`;
        })
        .join('');
    return this.raw(question, render, (_text, key, pasting) => {
      if (pasting || key.ctrl || key.meta) return undefined;
      if (key.name === 'up' || key.name === 'down') focused = (focused + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
      else if (key.name === 'space') selected = focused;
      else if (key.name === 'return' || key.name === 'enter') return selected;
      // Digits and letters do not confirm an answer.
      return undefined;
    });
  }

  /** Multiple choice: Space toggles a checkbox, Enter accepts the marked set. */
  async checkbox(question: string, choices: readonly Choice[]): Promise<number[]> {
    if (!choices.length) return [];
    const checked = choices.map((choice) => choice.checked === true);
    let focused = 0;
    const render = (): string =>
      choices
        .map((choice, index) => {
          const cursor = focused === index ? this.style.accent('›') : ' ';
          const mark = checked[index] ? this.style.success('◼') : this.style.muted('◻');
          const text = focused === index ? this.style.accent(safe(choice.label)) : this.style.muted(safe(choice.label));
          return `  ${cursor} ${mark} ${text}\n`;
        })
        .join('');
    return this.raw(`${question} (Space — отметить, Enter — готово)`, render, (_text, key, pasting) => {
      if (pasting || key.ctrl || key.meta) return undefined;
      if (key.name === 'up' || key.name === 'down') focused = (focused + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
      else if (key.name === 'space') checked[focused] = !checked[focused];
      else if (key.name === 'return' || key.name === 'enter') return checked.flatMap((value, index) => (value ? [index] : []));
      return undefined;
    });
  }

  /** Hidden input. Pasted text can contain line breaks; Enter outside a paste finishes the input. */
  async secret(question: string): Promise<string> {
    const chars: string[] = [];
    const value = await this.raw(question, undefined, (text, key, pasting) => {
      if (!pasting && (key.name === 'return' || key.name === 'enter')) return chars.join('');
      if (pasting && (key.name === 'return' || key.name === 'enter')) chars.push('\n');
      else if (key.name === 'backspace') chars.pop();
      else if (!key.ctrl && !key.meta && typeof text === 'string' && text.length > 0 && !/[\p{Cc}]/u.test(text)) chars.push(text);
      return undefined;
    });
    this.output.write(`  ${this.style.muted('(значение введено)')}\n`);
    return value;
  }
}
