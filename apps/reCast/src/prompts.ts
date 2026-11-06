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
  return value.replace(/[\p{Cc}\p{Cf}]/gu, '?');
}

// Add ANSI colors only after text sanitization. Keep pipe output without colors.
export type TerminalStyle = Record<'plain' | 'accent' | 'muted' | 'strong' | 'success' | 'warning' | 'error', (text: string) => string>;
export function terminalStyle(output: Pick<WriteStream, 'isTTY'> = stdout): TerminalStyle {
  const enabled = Boolean(output.isTTY) && process.env.TERM !== 'dumb' && !('NO_COLOR' in process.env) && process.env.FORCE_COLOR !== '0';
  const color = (code: number) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { plain: (text: string) => text, accent: color(36), muted: color(2), strong: color(1), success: color(32), warning: color(33), error: color(31) };
}

/** Each prompt owns its handlers and restores the TTY state. */
export class TerminalPrompts {
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
        // If the user clears the line, pass an empty value to the validator.
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

  /** Single choice: one radio button is selected at a time. */
  async select(question: string, choices: readonly string[], initial = 0): Promise<number> {
    this.check();
    if (!choices.length || !Number.isInteger(initial) || initial < 0 || initial >= choices.length) throw new Error('Некорректный список вариантов.');
    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    let selected = initial;
    let focused = selected;
    let drawn = false;
    let pasting = false;
    let settled = false;
    let cancel = (): void => {};
    let keypress = (_text: string | undefined, _key: Key): void => {};
    const render = (): void => {
      if (drawn) {
        moveCursor(this.output, 0, -choices.length);
        cursorTo(this.output, 0);
        clearScreenDown(this.output);
      }
      this.output.write(
        choices
          .map((label, index) => {
            const cursor = focused === index ? this.style.accent('›') : ' ';
            const mark = selected === index ? this.style.success('◉') : this.style.muted('○');
            const text = focused === index ? this.style.accent(safe(label)) : this.style.muted(safe(label));
            return `  ${cursor} ${mark} ${text}\n`;
          })
          .join('')
      );
      drawn = true;
    };
    try {
      return await new Promise<number>((resolve, reject) => {
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(selected);
        };
        cancel = () => {
          finish(new PromptCancelled());
        };
        this.active = cancel;
        keypress = (_text, key = {}) => {
          if (settled) return;
          if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || key.name === 'escape') {
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
          if (pasting || key.ctrl || key.meta) return;
          if (key.name === 'up' || key.name === 'down') {
            focused = (focused + (key.name === 'up' ? -1 : 1) + choices.length) % choices.length;
            render();
          } else if (key.name === 'space') {
            selected = focused;
            render();
          } else if (key.name === 'return' || key.name === 'enter') finish();
          // Do not accept digits or letters as confirmation of destructive operations.
        };
        emitKeypressEvents(this.input);
        this.input.on('keypress', keypress);
        this.input.once('end', cancel);
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        this.input.setRawMode(true);
        this.input.resume();
        // Do not let bracketed paste select or confirm an answer.
        this.output.write(`\x1b[?2004h${this.style.accent('◆')} ${this.style.strong(safe(question))}\n`);
        render();
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
}
