import { createInterface, emitKeypressEvents, cursorTo, moveCursor, clearScreenDown } from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { ReadStream, WriteStream } from 'node:tty';

export class PromptCancelled extends Error {
  constructor() { super('Ввод отменён. Изменения не применены.'); }
}
type Key = { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string };
function safe(value: string): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, '?'); }

/** Каждый вопрос владеет своими обработчиками и восстанавливает состояние TTY. */
export class TerminalPrompts {
  input: ReadStream;
  output: WriteStream;
  private active?: () => void;
  private closed = false;
  constructor(input = stdin, output = stdout) { this.input = input; this.output = output; }
  close(): void { this.closed = true; this.active?.(); }
  private check(): void {
    if (this.closed) throw new PromptCancelled();
    if (!this.input.isTTY || !this.output.isTTY) throw new Error('Для интерактивного выбора нужен терминал (TTY).');
    if (process.env.TERM === 'dumb') throw new Error('TERM=dumb не поддерживает интерактивное редактирование. Запустите CLI в терминале с поддержкой ANSI.');
  }

  async text(question: string, initial = ''): Promise<string> {
    this.check();
    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    const rl = createInterface({ input: this.input, output: this.output, terminal: true, historySize: 0 });
    let settled = false;
    let cancel = () => {};
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
        rl.question(`${safe(question)}: `, value => {
          if (settled) return;
          settled = true;
          resolve(value.trim());
        });
        // Это содержимое редактируемой строки, а не подпись или placeholder.
        // Очистка строки пользователем оставляет пустой ответ для валидатора.
        rl.write(safe(initial));
      });
    } finally {
      rl.removeListener('SIGINT', cancel);
      rl.removeListener('close', cancel);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      rl.close();
      this.input.setRawMode(wasRaw);
      if (wasFlowing) this.input.resume(); else this.input.pause();
      this.active = undefined;
    }
  }

  /** Взаимоисключающие чекбоксы: стрелки двигают фокус, пробел отмечает вариант. */
  async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    this.check();
    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    let selected = defaultYes ? 0 : 1;
    let focused = selected;
    let drawn = false;
    let pasting = false;
    let settled = false;
    let cancel = () => {};
    let keypress = (_text: string | undefined, _key: Key) => {};
    const render = () => {
      if (drawn) { moveCursor(this.output, 0, -2); cursorTo(this.output, 0); clearScreenDown(this.output); }
      this.output.write(['Да', 'Нет'].map((label, index) => `${focused === index ? '›' : ' '} [${selected === index ? 'x' : ' '}] ${label}\n`).join(''));
      drawn = true;
    };
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve(selected === 0);
        };
        cancel = () => finish(new PromptCancelled());
        this.active = cancel;
        keypress = (_text, key = {}) => {
          if (settled) return;
          if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || key.name === 'escape') { cancel(); return; }
          if (key.name === 'paste-start') { pasting = true; return; }
          if (key.name === 'paste-end') { pasting = false; return; }
          if (pasting || key.ctrl || key.meta) return;
          if (key.name === 'up' || key.name === 'down') { focused = 1 - focused; render(); }
          else if (key.name === 'space') { selected = focused; render(); }
          else if (key.name === 'return' || key.name === 'enter') finish();
          // Цифры и буквенные ответы намеренно не подтверждают опасные операции.
        };
        emitKeypressEvents(this.input);
        this.input.on('keypress', keypress);
        this.input.once('end', cancel);
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        this.input.setRawMode(true);
        this.input.resume();
        // Вставка текста в bracketed paste не должна выбирать и подтверждать ответ.
        this.output.write(`\x1b[?2004h${safe(question)}\n↑/↓ — фокус, пробел — выбрать, Enter — подтвердить, Esc — отменить\n`);
        render();
      });
    } finally {
      this.input.removeListener('keypress', keypress);
      this.input.removeListener('end', cancel);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      this.active = undefined;
      try { this.output.write('\x1b[?2004l'); }
      finally {
        this.input.setRawMode(wasRaw);
        if (wasFlowing) this.input.resume(); else this.input.pause();
      }
    }
  }
}
