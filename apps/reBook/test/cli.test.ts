import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRuntime, emptyBuild, emptyInit, parseArguments, safe } from '@reBook/cli';
import { printable, runBuild, runInit } from '@reBook/flows';
import type { Asker, Choice } from '@reBook/prompts';
import { findTool } from '@reBook/tools';
import { expect, test, type TestContext } from 'vitest';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const pandoc = findTool('pandoc');

function workspace(t: TestContext): string {
  // The real path: on macOS the temporary directory is a link to /private, and the CLI prints real paths.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tx-rebook-cli-test-')));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function run(args: string[], cwd = process.cwd()): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' }, timeout: 120000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('help and version work without a TTY', () => {
  const help = run(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('tx-rebook build [ФАЙЛ]');
  expect(run(['--version']).stdout.trim()).toBe(manifest.version);
});

test('the built entry point is executable', () => {
  if (process.platform !== 'win32') expect(statSync(cli).mode & 0o111).not.toBe(0);
  expect(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
});

test('an unknown option stops before any work', () => {
  const result = run(['build', '--force']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Неизвестный параметр: --force');
});

test('without a TTY and without --yes the CLI stops', (t) => {
  const directory = workspace(t);
  for (const args of [[], ['book.md'], ['init']]) {
    const result = run(args, directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Нужен интерактивный терминал (TTY) или параметр --yes');
  }
  expect(readdirSync(directory)).toEqual([]);
});

test('arguments select the command and accept both value forms', () => {
  expect(parseArguments([])).toEqual({ name: 'menu' });
  expect(parseArguments(['book.md'])).toEqual({ name: 'build', options: { ...emptyBuild(), input: 'book.md' } });
  expect(parseArguments(['build', '--', '--book.md'])).toEqual({ name: 'build', options: { ...emptyBuild(), input: '--book.md' } });
  expect(
    parseArguments([
      'build',
      'b.md',
      '--output',
      'out',
      '--cover=c.png',
      '--formats',
      'epub',
      '--mode=production',
      '--book-version',
      '1.0.0',
      '--book-date',
      '2024-01-01',
      '--css',
      's.css',
      '--reference-doc',
      'r.docx',
      '--metadata',
      'm.yaml',
      '--overwrite',
      '-y',
      '--dry-run'
    ])
  ).toEqual({
    name: 'build',
    options: {
      input: 'b.md',
      output: 'out',
      cover: 'c.png',
      formats: 'epub',
      mode: 'production',
      bookVersion: '1.0.0',
      bookDate: '2024-01-01',
      css: 's.css',
      referenceDoc: 'r.docx',
      metadata: 'm.yaml',
      overwrite: true,
      yes: true,
      dryRun: true
    }
  });
  expect(parseArguments(['init', '--title', 'T', '--author=A', '--description=', '-y'])).toEqual({ name: 'init', options: { ...emptyInit(), title: 'T', author: 'A', description: '', yes: true } });
});

test('arguments reject repeated, empty, and misplaced values', () => {
  expect(() => parseArguments(['a.md', 'b.md'])).toThrow(/один исходный файл/);
  expect(() => parseArguments(['a.md', '--output', 'x', '--output=y'])).toThrow(/повторно/);
  expect(() => parseArguments(['a.md', '--output'])).toThrow(/Нет значения/);
  expect(() => parseArguments(['a.md', '--output', '--overwrite'])).toThrow(/Нет значения/);
  expect(() => parseArguments(['a.md', '--output='])).toThrow(/Нет значения/);
  expect(() => parseArguments(['init', '--title='])).toThrow(/Нет значения/);
  expect(() => parseArguments(['init', 'extra'])).toThrow(/Лишний аргумент/);
  expect(() => parseArguments(['init', '--overwrite'])).toThrow(/Неизвестный параметр/);
  expect(() => parseArguments(['build', '--yes'])).toThrow(/ФАЙЛ/);
  expect(() => parseArguments(['init', '--yes', '--title', 'T'])).toThrow(/--title и --author/);
});

test('the runtime check needs Node.js 24.12 or newer', () => {
  expect(() => {
    checkRuntime('24.11.0');
  }).toThrow(/24\.12/);
  checkRuntime('24.12.0');
  checkRuntime('26.0.0');
});

test('terminal output replaces control characters', () => {
  expect(safe('a\u001b[2Jb‮c\nd')).toBe('a?[2Jb?c\nd');
});

/** Scripted answers for the interactive flow. */
class Script implements Asker {
  asked: string[] = [];
  constructor(private answers: (string | number | boolean | number[])[]) {}
  private next(question: string): string | number | boolean | number[] {
    this.asked.push(question);
    if (!this.answers.length) throw new Error(`No answer for: ${question}`);
    return this.answers.shift() as string | number | boolean | number[];
  }
  text(question: string): Promise<string> {
    return Promise.resolve(this.next(question) as string);
  }
  select(question: string): Promise<number> {
    return Promise.resolve(this.next(question) as number);
  }
  checkbox(question: string, _choices: readonly Choice[]): Promise<number[]> {
    return Promise.resolve(this.next(question) as number[]);
  }
  confirm(question: string): Promise<boolean> {
    return Promise.resolve(this.next(question) as boolean);
  }
}

test('interactive init asks again after an invalid answer and writes the file', async (t) => {
  const directory = workspace(t);
  const messages: string[] = [];
  const script = new Script(['', 'Interactive title', 'Interactive author', 'ru-RU', 'About the book', 'Unpublished manuscript. All rights reserved.', true]);
  const path = await runInit(
    emptyInit(),
    script,
    (text) => messages.push(text),
    () => undefined,
    directory
  );
  expect(path).toBe(join(directory, 'metadata.yaml'));
  expect(script.asked).toEqual(['Название книги', 'Название книги', 'Автор', 'Язык (код BCP 47)', 'Описание (можно оставить пустым)', 'Права', 'Создать файл?']);
  expect(messages).toContain('Название: обязательное поле.');
  const text = readFileSync(join(directory, 'metadata.yaml'), 'utf8');
  expect(text).toContain('title: "Interactive title"');
  expect(text).toMatch(/text: "urn:uuid:[0-9a-f-]{36}"/);
});

test('interactive init writes nothing when the user declines', async (t) => {
  const directory = workspace(t);
  const script = new Script(['T', 'A', 'en', '', 'R', false]);
  expect(
    await runInit(
      emptyInit(),
      script,
      () => undefined,
      () => undefined,
      directory
    )
  ).toBeUndefined();
  expect(readdirSync(directory)).toEqual([]);
});

test('init without questions writes the file once and prints only its path', (t) => {
  const directory = workspace(t);
  const first = run(['init', '--yes', '--title', 'Sample', '--author', 'Someone'], directory);
  expect(first.status).toBe(0);
  expect(first.stdout).toBe(`${join(directory, 'metadata.yaml')}\n`);
  const text = readFileSync(join(directory, 'metadata.yaml'), 'utf8');
  expect(text).toContain('lang: "ru-RU"');
  const second = run(['init', '--yes', '--title', 'Other', '--author', 'Someone'], directory);
  expect(second.status).toBe(1);
  expect(second.stderr).toContain('уже существует');
  expect(readFileSync(join(directory, 'metadata.yaml'), 'utf8')).toBe(text);
  const dry = run(['init', '--yes', '--dry-run', '--metadata', 'other.yaml', '--title', 'T', '--author', 'A'], directory);
  expect(dry.status).toBe(0);
  expect(existsSync(join(directory, 'other.yaml'))).toBe(false);
});

const manuscript = '# Chapter\n\nText.\n\n\\*\\*\\*\n\nNext scene.\n\n# ❦ {.interlude-title}\n\nInterlude.\n';

test.skipIf(!pandoc)('a book builds from Markdown with Pandoc and keeps the source', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  expect(run(['init', '--yes', '--title', 'Sample book', '--author', 'Someone', '--lang', 'en-US'], directory).status).toBe(0);
  const metadata = readFileSync(join(directory, 'metadata.yaml'), 'utf8');

  const missingVersion = run(['build', 'book.md', '--yes'], directory);
  expect(missingVersion.status).toBe(1);
  expect(missingVersion.stderr).toContain('пустое поле version');

  const dry = run(['build', 'book.md', '--yes', '--dry-run', '--book-version', '0.1.0', '--book-date', '2024-01-02'], directory);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toBe('');
  expect(existsSync(join(directory, 'build'))).toBe(false);
  expect(readFileSync(join(directory, 'metadata.yaml'), 'utf8')).toBe(metadata);

  const built = run(['build', 'book.md', '--yes', '--book-version', '0.1.0', '--book-date', '2024-01-02'], directory);
  expect(built.stderr).not.toContain('Ошибка');
  expect(built.status).toBe(0);
  const names = ['Sample book - beta - 0_1_0.epub', 'Sample book - beta - 0_1_0.docx', 'Sample book - beta - 0_1_0.html'];
  expect(built.stdout.trim().split('\n')).toEqual(names.map((name) => join(directory, 'build', name)));
  expect(readdirSync(join(directory, 'build')).sort()).toEqual([...names].sort());
  const updated = readFileSync(join(directory, 'metadata.yaml'), 'utf8');
  expect(updated).toContain('version: "0.1.0"');
  expect(updated).toContain('date: "2024-01-02"');
  expect(updated).toContain('  version: "0.1.0"');
  expect(readFileSync(join(directory, 'book.md'), 'utf8')).toBe(manuscript);
  const html = readFileSync(join(directory, 'build', names[2] ?? ''), 'utf8');
  expect(html).toContain('scene-break');
  expect(html).toContain('Draft version for beta readers.');
  expect(html).toContain('text-indent');

  const before = readFileSync(join(directory, 'build', names[0] ?? ''));
  const again = run(['build', 'book.md', '--yes'], directory);
  expect(again.status).toBe(1);
  expect(again.stderr).toContain('--overwrite');
  expect(readFileSync(join(directory, 'build', names[0] ?? ''))).toEqual(before);

  const production = run(['build', 'book.md', '--yes', '--mode', 'production', '--formats', 'docx', '--output', 'out'], directory);
  expect(production.status).toBe(0);
  expect(readdirSync(join(directory, 'out'))).toEqual(['Sample book - 0_1_0.docx']);
  expect(readdirSync(tmpdir()).filter((name) => name.startsWith('tx-rebook-') && !name.includes('test'))).toEqual([]);
});

test.skipIf(!pandoc)('empty metadata fields stop the build before any write', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  writeFileSync(
    join(directory, 'metadata.yaml'),
    'title: "T"\nsubtitle: ""\ndate: "2024-01-01"\nversion: "1.0.0"\nlang: "en"\nidentifier:\n  - scheme: URN\n    text: "urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f"\n'
  );
  const result = run(['build', 'book.md', '--yes'], directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Пустые поля в metadata.yaml: subtitle');
  expect(existsSync(join(directory, 'build'))).toBe(false);
});

test.skipIf(!pandoc)('a missing metadata file stops the build without questions', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  const result = run(['build', 'book.md', '--yes'], directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('tx-rebook init');
});

test.skipIf(!pandoc)('a result never replaces the manuscript, even with --overwrite', (t) => {
  const directory = workspace(t);
  const name = 'Sample - 1_0_0.markdown';
  writeFileSync(join(directory, name), manuscript);
  writeFileSync(
    join(directory, 'metadata.yaml'),
    'title: "Sample"\ndate: "2024-01-01"\nversion: "1.0.0"\nlang: "en"\nidentifier:\n  - scheme: URN\n    text: "urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f"\n'
  );
  const result = run(['build', name, '--yes', '--mode', 'production', '--formats', 'markdown', '--output', '.', '--overwrite'], directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('совпадает с входным файлом');
  expect(readFileSync(join(directory, name), 'utf8')).toBe(manuscript);
});

test.skipIf(process.platform === 'win32')('dry-run commands stay text when they are copied into a shell', () => {
  const title = `$(echo X) \`echo Y\` it's "q" \\n`;
  const line = printable('printf', ['%s', title]);
  expect(line).toBe(`printf %s '$(echo X) \`echo Y\` it'\\''s "q" \\n'`);
  const result = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });
  expect(result.stdout).toBe(title);
});

const plainMetadata = 'title: "Sample"\ndate: "2024-01-01"\nversion: "1.0.0"\nlang: "en"\nidentifier:\n  - scheme: URN\n    text: "urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f"\n';

test.skipIf(!pandoc)('an interactive dry-run shows new metadata but does not write it', async (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  const messages: string[] = [];
  const script = new Script([join(directory, 'book.md'), true, 'T', 'A', 'en', '', 'R']);
  const result = await runBuild(
    { ...emptyBuild(), dryRun: true },
    script,
    (text) => messages.push(text),
    () => undefined,
    directory
  );
  expect(result).toEqual([]);
  expect(script.asked[1]).toBe('Показать metadata.yaml, который будет создан?');
  expect(messages).toContain('Dry-run: файл не создан. Содержимое:');
  expect(messages.at(-1)).toBe('Dry-run: книга не собрана, файлы не изменены.');
  expect(readdirSync(directory)).toEqual(['book.md']);
});

test.skipIf(!pandoc || process.platform === 'win32')('a metadata link stops a version change before results are replaced', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  writeFileSync(join(directory, 'real.yaml'), plainMetadata);
  symlinkSync(join(directory, 'real.yaml'), join(directory, 'metadata.yaml'));
  mkdirSync(join(directory, 'build'));
  const result = join(directory, 'build', 'Sample - 1_1_0.html');
  writeFileSync(result, 'old');
  const build = run(['build', 'book.md', '--yes', '--mode', 'production', '--formats', 'html', '--book-version', '1.1.0', '--overwrite'], directory);
  expect(build.status).toBe(1);
  expect(build.stderr).toContain('символическая ссылка');
  expect(readFileSync(result, 'utf8')).toBe('old');
  expect(readFileSync(join(directory, 'real.yaml'), 'utf8')).toBe(plainMetadata);
});

test.skipIf(!pandoc)('a version change keeps unrelated YAML fields', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  const metadata = `${plainMetadata}description: |\n  Notes.\n  version: "1.0.0"\ncustom:\n  ibooks:\n    version: "1.0.0"\nibooks:\n  version: "1.0.0"\n  extra:\n    version: "1.0.0"\n`;
  writeFileSync(join(directory, 'metadata.yaml'), metadata);
  const build = run(['build', 'book.md', '--yes', '--mode', 'production', '--formats', 'html', '--book-version', '1.1.0'], directory);
  expect(build.stderr).not.toContain('Ошибка');
  expect(build.status).toBe(0);
  const lines = readFileSync(join(directory, 'metadata.yaml'), 'utf8').split('\n');
  const changed = lines.filter((line, index) => line !== metadata.split('\n')[index]);
  expect(changed).toEqual(['version: "1.1.0"', '  version: "1.1.0"']);
});

test.skipIf(!pandoc || process.platform !== 'linux')('an EPUBCheck that cannot run stops the build', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  const tools = join(directory, 'tools');
  mkdirSync(tools);
  // An interpreter that does not exist makes the start fail, as a broken installation does.
  writeFileSync(join(tools, 'epubcheck'), '#!/nonexistent/interpreter\n');
  chmodSync(join(tools, 'epubcheck'), 0o755);
  const result = spawnSync(process.execPath, [cli, 'build', 'book.md', '--yes', '--formats', 'epub'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', PATH: `${tools}:${process.env.PATH ?? ''}` },
    timeout: 120000
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('EPUBCheck не выполнил проверку');
  expect(existsSync(join(directory, 'build'))).toBe(false);
});
