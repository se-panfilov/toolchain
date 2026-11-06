import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalPrompts, PromptCancelled } from './prompts.ts';

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
}
class Output extends Writable {
  isTTY = true;
  columns = 100;
  text = '';
  _write(chunk: Buffer, _encoding: string, callback: () => void): void { this.text += chunk.toString(); callback(); }
}
function fixture(t: { after: (fn: () => void) => void }) {
  // Фикстура моделирует ANSI-терминал, а не TERM=dumb оболочки CI.
  const term = process.env.TERM; process.env.TERM = 'xterm-256color';
  t.after(() => { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; });
  const input = new Input(); const output = new Output();
  const prompts = new TerminalPrompts(input as unknown as ReadStream, output as unknown as WriteStream);
  t.after(() => { prompts.close(); input.destroy(); output.destroy(); });
  return { input, output, prompts };
}

test('чекбокс по умолчанию выбран; цифры не меняют ответ', async t => {
  const { input, output, prompts } = fixture(t);
  const answer = prompts.confirm('Применить?', false);
  assert.match(stripVTControlCharacters(output.text), /\[ \] Да\n› \[x\] Нет/);
  assert(!output.text.includes('Выберите номер'));
  input.write('1\r');
  assert.equal(await answer, false);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('стрелка меняет только фокус; пробел выбирает единственный вариант', async t => {
  const { input, prompts } = fixture(t);
  let answer = prompts.confirm('Применить?', false);
  input.write('\x1b[A\r');
  assert.equal(await answer, false);
  answer = prompts.confirm('Применить?', false);
  input.write('\x1b[A \r');
  assert.equal(await answer, true);
});

test('выбранное Да принимается Enter; стрелка и пробел переключают на Нет', async t => {
  const { input, prompts } = fixture(t);
  let answer = prompts.confirm('Бекап?', true);
  input.write('\r'); assert.equal(await answer, true);
  answer = prompts.confirm('Бекап?', true);
  input.write('\x1b[B \r'); assert.equal(await answer, false);
});

test('вставка bracketed paste не выбирает и не подтверждает применение', async t => {
  const { input, prompts } = fixture(t);
  let resolved = false;
  const answer = prompts.confirm('Применить?', false).then(value => { resolved = true; return value; });
  input.write('\x1b[200~\x1b[A \r\x1b[201~');
  await Promise.resolve();
  assert.equal(resolved, false);
  input.write('\r'); assert.equal(await answer, false);
});

test('значение по умолчанию находится в редактируемой строке, Enter его принимает', async t => {
  const { input, output, prompts } = fixture(t);
  const answer = prompts.text('Интервал', '12');
  assert.match(stripVTControlCharacters(output.text), /Интервал: 12/);
  assert(!output.text.includes('[12]'));
  input.write('\r'); assert.equal(await answer, '12');
  assert.equal(input.isRaw, false);
});

test('предзаполненный текст можно редактировать и полностью очистить', async t => {
  const { input, prompts } = fixture(t);
  let answer = prompts.text('Интервал', '12');
  input.write('\x7f'); input.write('3'); input.write('\r'); assert.equal(await answer, '13');
  answer = prompts.text('Интервал', '12');
  input.write('\x15'); input.write('\r'); assert.equal(await answer, '');
});

test('Ctrl+C отменяет выбор/ввод, восстанавливает raw mode и снимает обработчики', async t => {
  const { input, prompts } = fixture(t);
  const sigint = process.listenerCount('SIGINT'); const sigterm = process.listenerCount('SIGTERM');
  for (const answer of [() => prompts.confirm('Применить?', false), () => prompts.text('Дата', '2026-10-28')]) {
    const pending = answer();
    input.write('\x03');
    await assert.rejects(pending, PromptCancelled);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('keypress'), 0);
    assert.equal(process.listenerCount('SIGINT'), sigint);
    assert.equal(process.listenerCount('SIGTERM'), sigterm);
  }
});

test('закрытие диалога отменяет незавершённый ввод и сохраняет исходный raw mode', async t => {
  const { input, prompts } = fixture(t);
  input.isRaw = true; input.resume();
  const text = prompts.text('Значение', 'текст');
  input.write('\r'); await text;
  assert.equal(input.isRaw, true); assert.equal(input.readableFlowing, true);
  const pending = prompts.confirm('Применить?', false);
  prompts.close(); await assert.rejects(pending, PromptCancelled);
  assert.equal(input.isRaw, true);
  await assert.rejects(prompts.text('Имя'), PromptCancelled);
});

test('управляющие символы в вопросе/начальном тексте не уходят в терминал', async t => {
  const { input, output, prompts } = fixture(t);
  const pending = prompts.text('Вопрос\x1b[31m', 'текст\x1b[2J');
  input.write('\r');
  assert.equal(await pending, 'текст?[2J');
  assert(!output.text.includes('\x1b[31m'));
  assert(!output.text.includes('\x1b[2J'));
});


test('неподдерживаемый терминал отклоняется до смены raw mode и вывода', async t => {
  const { input, output, prompts } = fixture(t);
  input.isTTY = false;
  await assert.rejects(prompts.text('Имя'), /TTY/);
  input.isTTY = true; process.env.TERM = 'dumb';
  await assert.rejects(prompts.confirm('Применить?', false), /TERM=dumb/);
  assert.equal(input.isRaw, false); assert.equal(output.text, '');
});
