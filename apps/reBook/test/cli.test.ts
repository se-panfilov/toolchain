import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRuntime, emptyBuild, emptyInit, parseArguments, safe } from '@reBook/cli';
import { printable, runBuild, runInit } from '@reBook/flows';
import type { Asker, Choice } from '@reBook/prompts';
import { findTool, parsePandocVersion, supportsPdf } from '@reBook/tools';
import { expect, test, type TestContext } from 'vitest';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const pandoc = findTool('pandoc');
const typst = findTool('typst');
const pandocVersion = pandoc ? parsePandocVersion(spawnSync(pandoc, ['--version'], { encoding: 'utf8' }).stdout) : undefined;
// PDF needs Pandoc 3.2 or later. With an older Pandoc, the PDF tests are skipped.
const pdfPandoc = pandocVersion !== undefined && supportsPdf(pandocVersion);

function workspace(t: TestContext): string {
  // The real path: on macOS the temporary directory is a link to /private, and the CLI prints real paths.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tx-rebook-cli-test-')));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function run(args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', ...env }, timeout: 120000 });
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
      '--typograf-rules',
      't.json',
      '--typograf-profile',
      'literary-markdown',
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
      typografRules: 't.json',
      typografProfile: 'literary-markdown',
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

  const missingVersion = run(['build', 'book.md', '--yes', '--typograf-profile', 'literary-markdown'], directory);
  expect(missingVersion.status).toBe(1);
  expect(missingVersion.stderr).toContain('пустое поле version');

  // A failed build does not write the new whitelist.
  expect(existsSync(join(directory, 'typograf.rules.json'))).toBe(false);

  const dry = run(['build', 'book.md', '--yes', '--dry-run', '--book-version', '0.1.0', '--book-date', '2024-01-02', '--typograf-profile', 'literary-markdown'], directory);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toBe('');
  expect(existsSync(join(directory, 'build'))).toBe(false);
  expect(readFileSync(join(directory, 'metadata.yaml'), 'utf8')).toBe(metadata);
  expect(existsSync(join(directory, 'book.formatted.md'))).toBe(false);
  expect(existsSync(join(directory, 'typograf.rules.json'))).toBe(false);

  const built = run(['build', 'book.md', '--yes', '--book-version', '0.1.0', '--book-date', '2024-01-02', '--typograf-profile', 'literary-markdown'], directory);
  expect(built.stderr).not.toContain('Ошибка');
  expect(built.status).toBe(0);
  // All formats are selected by default. PDF is left out when typst is not installed.
  const names = ['epub', 'docx', 'html', 'fb2', ...(typst && pdfPandoc ? ['pdf'] : [])].map((extension) => `Sample book - beta - 0_1_0.${extension}`);
  expect(built.stdout.trim().split('\n')).toEqual(names.map((name) => join(directory, 'build', name)));
  expect(readdirSync(join(directory, 'build')).sort()).toEqual([...names].sort());
  const rules = JSON.parse(readFileSync(join(directory, 'typograf.rules.json'), 'utf8')) as { enabledRules: string[] };
  expect(rules.enabledRules.length).toBe(10);
  const updated = readFileSync(join(directory, 'metadata.yaml'), 'utf8');
  expect(updated).toContain('version: "0.1.0"');
  expect(updated).toContain('date: "2024-01-02"');
  expect(updated).toContain('  version: "0.1.0"');
  expect(readFileSync(join(directory, 'book.md'), 'utf8')).toBe(manuscript);
  expect(existsSync(join(directory, 'book.formatted.md'))).toBe(true);
  const html = readFileSync(join(directory, 'build', names[2] ?? ''), 'utf8');
  expect(html).toContain('scene-break');
  expect(html).toContain('Draft version for beta readers.');
  expect(html).toContain('text-indent');

  const formattedBefore = readFileSync(join(directory, 'book.formatted.md'), 'utf8');
  const before = readFileSync(join(directory, 'build', names[0] ?? ''));
  const again = run(['build', 'book.md', '--yes'], directory);
  expect(again.status).toBe(1);
  expect(again.stderr).toContain('--overwrite');
  expect(readFileSync(join(directory, 'build', names[0] ?? ''))).toEqual(before);
  // The file-exists guard stops the build before Typograf Core runs again, so the formatted file is unchanged.
  expect(readFileSync(join(directory, 'book.formatted.md'), 'utf8')).toBe(formattedBefore);

  const production = run(['build', 'book.md', '--yes', '--mode', 'production', '--formats', 'docx', '--output', 'out'], directory);
  expect(production.status).toBe(0);
  expect(readdirSync(join(directory, 'out'))).toEqual(['Sample book - 0_1_0.docx']);
  expect(readdirSync(tmpdir()).filter((name) => name.startsWith('tx-rebook-') && !name.includes('test'))).toEqual([]);
});

test.skipIf(!pandoc)('Typograf Core transforms the manuscript before Pandoc reads it, and images still resolve', (t) => {
  const directory = workspace(t);
  const raw = '# Chapter\n\nOн посмотрел из за дерева...\n\n![Illustration](images/illustration.png)\n';
  mkdirSync(join(directory, 'images'));
  writeFileSync(join(directory, 'images', 'illustration.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  writeFileSync(join(directory, 'book.md'), raw);
  expect(run(['init', '--yes', '--title', 'Sample book', '--author', 'Someone', '--lang', 'en-US'], directory).status).toBe(0);

  const built = run(['build', 'book.md', '--typograf-profile', 'default', '--yes', '--book-version', '0.1.0', '--book-date', '2024-01-02', '--formats', 'html'], directory);
  expect(built.status).toBe(0);
  expect(readFileSync(join(directory, 'book.md'), 'utf8')).toBe(raw);
  const formatted = readFileSync(join(directory, 'book.formatted.md'), 'utf8');
  expect(formatted).toContain('из-за дерева…');
  expect(formatted).not.toContain('из за дерева...');

  const html = readFileSync(join(directory, 'build', 'Sample book - beta - 0_1_0.html'), 'utf8');
  expect(html).toContain('из-за дерева…');
  // Pandoc embeds the relative image as a self-contained data URI, proving resourcePath still resolved it.
  expect(html).toContain('data:image/png;base64,');
  expect(built.stderr).not.toContain('not found');
});

test.skipIf(!pandoc)('an invalid custom whitelist stops the build and leaves an existing formatted manuscript and results untouched', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  expect(run(['init', '--yes', '--title', 'Sample book', '--author', 'Someone', '--lang', 'en-US'], directory).status).toBe(0);

  const first = run(['build', 'book.md', '--yes', '--typograf-profile', 'default', '--book-version', '0.1.0', '--book-date', '2024-01-02'], directory);
  expect(first.status).toBe(0);
  const formattedBefore = readFileSync(join(directory, 'book.formatted.md'), 'utf8');
  const resultsBefore = readdirSync(join(directory, 'build')).sort();

  writeFileSync(join(directory, 'bad.rules.json'), JSON.stringify({ schemaVersion: 1, locale: 'ru', enabledRules: ['ru/dash/unknownRule'] }));
  const broken = run(['build', 'book.md', '--yes', '--typograf-rules', 'bad.rules.json', '--overwrite', '--book-version', '0.1.0', '--book-date', '2024-01-02'], directory);
  expect(broken.status).toBe(1);
  expect(broken.stderr).toContain('правил');
  expect(readdirSync(join(directory, 'build')).sort()).toEqual(resultsBefore);
  expect(readFileSync(join(directory, 'book.formatted.md'), 'utf8')).toBe(formattedBefore);
});

test.skipIf(!pandoc)('empty metadata fields stop the build before any write', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  writeFileSync(
    join(directory, 'metadata.yaml'),
    'title: "T"\nsubtitle: ""\ndate: "2024-01-01"\nversion: "1.0.0"\nlang: "en"\nidentifier:\n  - scheme: URN\n    text: "urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f"\n'
  );
  const result = run(['build', 'book.md', '--yes', '--typograf-profile', 'literary-markdown'], directory);
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
  const result = run(['build', name, '--yes', '--mode', 'production', '--formats', 'markdown', '--output', '.', '--overwrite', '--typograf-profile', 'literary-markdown'], directory);
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
  const build = run(['build', 'book.md', '--yes', '--mode', 'production', '--formats', 'html', '--book-version', '1.1.0', '--overwrite', '--typograf-profile', 'literary-markdown'], directory);
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
  const build = run(['build', 'book.md', '--yes', '--mode', 'production', '--formats', 'html', '--book-version', '1.1.0', '--typograf-profile', 'literary-markdown'], directory);
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
  const result = spawnSync(process.execPath, [cli, 'build', 'book.md', '--yes', '--formats', 'epub', '--typograf-profile', 'literary-markdown'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', PATH: `${tools}:${process.env.PATH ?? ''}` },
    timeout: 120000
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('EPUBCheck не выполнил проверку');
  expect(existsSync(join(directory, 'build'))).toBe(false);
});

/** Answers by question text. A hook runs before an answer, to change files at that moment. */
class Answers implements Asker {
  asked: string[] = [];
  constructor(
    private answers: Record<string, string | number | boolean | number[]>,
    private hooks: Record<string, () => void> = {}
  ) {}
  private next(question: string): string | number | boolean | number[] {
    this.asked.push(question);
    this.hooks[question]?.();
    const answer = this.answers[question];
    if (answer === undefined) throw new Error(`No answer for: ${question}`);
    return answer;
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

test.skipIf(!pandoc)('a confirmation replaces only the files that the plan showed', async (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  const out = join(directory, 'build');
  mkdirSync(out);
  const html = join(out, 'Sample - 1_0_0.html');
  const docx = join(out, 'Sample - 1_0_0.docx');
  writeFileSync(html, 'old html');
  const script = new Answers(
    {
      'Исходный файл Markdown': join(directory, 'book.md'),
      Форматы: [1, 2],
      'Тип сборки': 1,
      Оформление: 0,
      'Выходной каталог': out,
      'Выберите правила типографирования:': 0,
      'Версия книги': '1.0.0',
      'Дата книги (ГГГГ-ММ-ДД)': '2024-01-01',
      'Перезаписать существующие файлы?': true,
      'Собрать книгу?': true
    },
    // A DOCX file appears after the confirmation. The confirmation did not cover it.
    { 'Собрать книгу?': () => writeFileSync(docx, 'new docx from elsewhere') }
  );
  await expect(
    runBuild(
      emptyBuild(),
      script,
      () => undefined,
      () => undefined,
      directory
    )
  ).rejects.toThrow(/Файл уже существует: .*docx/);
  expect(script.asked).toContain('Перезаписать существующие файлы?');
  expect(readFileSync(html, 'utf8')).toBe('old html');
  expect(readFileSync(docx, 'utf8')).toBe('new docx from elsewhere');
});

test.skipIf(!pandoc || process.platform === 'win32')('the formatted manuscript is private, whatever the source mode and the umask', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  // A readable source can still have an ACL that the copy cannot get, so the source mode does not count.
  chmodSync(join(directory, 'book.md'), 0o644);
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  const args = ['build', 'book.md', '--yes', '--mode', 'production', '--formats', 'html', '--overwrite', '--typograf-profile', 'literary-markdown'];
  expect(run(args, directory).status).toBe(0);
  const formatted = join(directory, 'book.formatted.md');
  expect(statSync(formatted).mode & 0o777).toBe(0o600);
  // A replaced copy keeps only the bits that both the old copy and 0600 allow.
  chmodSync(formatted, 0o644);
  expect(run(args, directory).status).toBe(0);
  expect(statSync(formatted).mode & 0o777).toBe(0o600);
  chmodSync(formatted, 0o400);
  expect(run(args, directory).status).toBe(0);
  expect(statSync(formatted).mode & 0o777).toBe(0o400);
});

test.skipIf(!pandoc || process.platform === 'win32')('another spelling of the formatted path for --metadata stops the build', (t) => {
  const directory = workspace(t);
  mkdirSync(join(directory, 'sub'));
  writeFileSync(join(directory, 'book.md'), manuscript);
  // The metadata file is the formatted path of the manuscript, given through a parent directory.
  const metadata = join(directory, 'book.formatted.md');
  writeFileSync(metadata, plainMetadata);
  const result = run(['build', 'book.md', '--yes', '--formats', 'html', '--metadata', 'sub/../book.formatted.md', '--typograf-profile', 'literary-markdown'], directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('совпадает с входным файлом');
  expect(readFileSync(metadata, 'utf8')).toBe(plainMetadata);
  expect(existsSync(join(directory, 'typograf.rules.json'))).toBe(false);
  // A hard link with another name is the same file too.
  linkSync(metadata, join(directory, 'meta.yaml'));
  rmSync(metadata);
  linkSync(join(directory, 'meta.yaml'), metadata);
  const linked = run(['build', 'book.md', '--yes', '--formats', 'html', '--metadata', 'meta.yaml', '--typograf-profile', 'literary-markdown'], directory);
  expect(linked.status).toBe(1);
  expect(linked.stderr).toContain('совпадает с входным файлом');
  expect(readFileSync(join(directory, 'meta.yaml'), 'utf8')).toBe(plainMetadata);
});

test.skipIf(!pandoc)('a failed or stopped build writes no whitelist and keeps the old formatted manuscript', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), 'Он посмотрел из за дерева...\n');
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  writeFileSync(join(directory, 'book.formatted.md'), 'old formatted');
  const badVersion = run(['build', 'book.md', '--yes', '--formats', 'html', '--book-version', 'x', '--typograf-profile', 'default'], directory);
  expect(badVersion.status).toBe(1);
  // A reference document with a ZIP signature but no ZIP content makes Pandoc fail on DOCX.
  writeFileSync(join(directory, 'bad.docx'), 'PK\u0003\u0004 not a zip');
  const failed = run(['build', 'book.md', '--yes', '--formats', 'html,docx', '--reference-doc', 'bad.docx', '--typograf-profile', 'default'], directory);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain('Pandoc');
  expect(existsSync(join(directory, 'typograf.rules.json'))).toBe(false);
  expect(readFileSync(join(directory, 'book.formatted.md'), 'utf8')).toBe('old formatted');
  expect(existsSync(join(directory, 'build'))).toBe(false);
});

test.skipIf(!pandoc)('an interactive build that the user stops writes no whitelist', async (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), manuscript);
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  const script = new Answers({
    'Исходный файл Markdown': join(directory, 'book.md'),
    Форматы: [2],
    'Тип сборки': 1,
    Оформление: 0,
    'Выходной каталог': join(directory, 'build'),
    'Выберите правила типографирования:': 1,
    'Версия книги': '1.0.0',
    'Дата книги (ГГГГ-ММ-ДД)': '2024-01-01',
    'Собрать книгу?': false
  });
  expect(
    await runBuild(
      emptyBuild(),
      script,
      () => undefined,
      () => undefined,
      directory
    )
  ).toEqual([]);
  expect(script.asked).toContain('Выберите правила типографирования:');
  expect(readdirSync(directory).sort()).toEqual(['book.md', 'metadata.yaml']);
});

/** A synthetic typst: it records its arguments and writes a small PDF file to the output path. */
function fakeTypst(directory: string, status = 0): { bin: string; log: string } {
  const bin = join(directory, 'tools');
  mkdirSync(bin);
  const log = join(directory, 'typst.log');
  const script = [
    `#!${process.execPath}`,
    "const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
    `if (${String(status)} !== 0) { process.stderr.write('typst failure'); process.exit(${String(status)}); }`,
    'const input = args[args.length - 2], output = args[args.length - 1];',
    "writeFileSync(output, '%PDF-1.7\\n' + readFileSync(input, 'utf8'));"
  ].join('\n');
  writeFileSync(join(bin, 'typst'), `${script}\n`, { mode: 0o755 });
  return { bin, log };
}

// On macOS the CLI also looks in the Homebrew directories, so a real typst there cannot be hidden.
const homebrewTypst = process.platform === 'darwin' && ['/opt/homebrew/bin/typst', '/usr/local/bin/typst'].some((path) => existsSync(path));

test.skipIf(!pandoc)('FB2 gets the cover, the metadata, and a visible scene break', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), '# Глава\n\nТекст.\n\n***\n\nДальше.\n');
  writeFileSync(join(directory, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  writeFileSync(
    join(directory, 'metadata.yaml'),
    `${plainMetadata.replace('lang: "en"', 'lang: "ru-RU"')}creator:\n  - role: author\n    text: "Иван Петров"\n  - role: editor\n    text: "Редактор"\n`
  );
  const built = run(['build', 'book.md', '--yes', '--formats', 'fb2', '--cover', 'cover.png', '--mode', 'production', '--typograf-profile', 'literary-markdown'], directory);
  expect(built.stderr).not.toContain('Ошибка');
  expect(built.status).toBe(0);
  const fb2 = readFileSync(join(directory, 'build', 'Sample - 1_0_0.fb2'), 'utf8');
  expect(fb2).toContain('<FictionBook');
  expect(fb2).toContain('<book-title>Sample</book-title>');
  expect(fb2).toContain('<coverpage>');
  // The creator with the author role becomes the FB2 author. The editor does not.
  expect(fb2).toContain('<author><first-name>Иван</first-name><last-name>Петров</last-name></author>');
  expect(fb2).not.toContain('Редактор');
  expect(fb2).toContain('<p>* * *</p>');
  expect(fb2).toContain('Дальше.');
});

test.skipIf(!pdfPandoc || process.platform === 'win32')('PDF uses typst with the private directory as the root', (t) => {
  const directory = workspace(t);
  const { bin, log } = fakeTypst(directory);
  mkdirSync(join(directory, 'images'));
  writeFileSync(join(directory, 'images', 'picture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  // Raw Typst code in the manuscript and in the metadata could import packages. The build drops it.
  writeFileSync(
    join(directory, 'book.md'),
    '# Глава\n\nТекст `#import "@preview/inline:0.1.0": *`{=typst}.\n\n```{=typst}\n#import "@preview/block:0.1.0": *\n```\n\n![Рисунок](images/picture.png)\n'
  );
  writeFileSync(join(directory, 'metadata.yaml'), `${plainMetadata}subtitle: 'Sub \`#import "@preview/meta:0.1.0": *\`{=typst}'\n`);
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}` };
  const dry = run(['build', 'book.md', '--yes', '--dry-run', '--formats', 'pdf', '--typograf-profile', 'literary-markdown'], directory, env);
  expect(dry.status).toBe(0);
  expect(dry.stderr).toMatch(/\[dry-run\] typst compile --root=/);
  expect(existsSync(log)).toBe(false);

  const built = run(['build', 'book.md', '--yes', '--formats', 'pdf', '--typograf-profile', 'literary-markdown'], directory, env);
  expect(built.stderr).not.toContain('Ошибка');
  expect(built.status).toBe(0);
  const pdf = readFileSync(join(directory, 'build', 'Sample - beta - 1_0_0.pdf'), 'utf8');
  expect(pdf.startsWith('%PDF-')).toBe(true);
  // The markup comes from the Pandoc Typst writer: page settings from pdf.yaml, a relative image copy, and the beta notice.
  expect(pdf).toContain('paper: "a5"');
  expect(pdf).toContain('image("media/');
  expect(pdf).toContain('Please do not distribute.');
  expect(pdf).not.toContain('@preview');
  expect(pdf).not.toContain('#import');
  const [args] = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  const root = (args?.[1] ?? '').replace('--root=', '');
  const packages = join(dirname(root), 'typst-packages');
  // Empty private package directories: no local packages of the user, and no writes into the user package cache.
  expect(args?.slice(0, 5)).toEqual(['compile', `--root=${root}`, `--package-path=${join(packages, 'local')}`, `--package-cache-path=${join(packages, 'cache')}`, '--']);
  expect(args?.[5]).toBe(join(root, 'book.typ'));
  expect(root.startsWith(directory)).toBe(false);
  // The private directory is gone after the build.
  expect(existsSync(root)).toBe(false);
  expect(readdirSync(directory).sort()).toEqual(['book.formatted.md', 'book.md', 'build', 'images', 'metadata.yaml', 'tools', 'typograf.rules.json', 'typst.log']);
});

test.skipIf(!pdfPandoc || process.platform === 'win32')('a failed typst run replaces no result', (t) => {
  const directory = workspace(t);
  const { bin } = fakeTypst(directory, 3);
  writeFileSync(join(directory, 'book.md'), '# Глава\n\nТекст.\n');
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  const built = run(['build', 'book.md', '--yes', '--formats', 'html,pdf', '--typograf-profile', 'literary-markdown'], directory, { PATH: `${bin}:${process.env.PATH ?? ''}` });
  expect(built.status).toBe(1);
  expect(built.stderr).toContain('typst завершился с кодом 3');
  expect(built.stderr).toContain('typst failure');
  expect(existsSync(join(directory, 'build'))).toBe(false);
  expect(existsSync(join(directory, 'book.formatted.md'))).toBe(false);
});

test.skipIf(!pandoc || process.platform === 'win32' || homebrewTypst)('without typst the default leaves PDF out, and an explicit PDF stops the build', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), '# Глава\n\nТекст.\n');
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  // Only the Pandoc directory stays in PATH, so typst is not found there.
  const env = { PATH: dirname(pandoc ?? '') };
  const explicit = run(['build', 'book.md', '--yes', '--formats', 'pdf', '--typograf-profile', 'literary-markdown'], directory, env);
  expect(explicit.status).toBe(1);
  expect(explicit.stderr).toContain('Для PDF нужен typst. Установите его: brew install typst');
  expect(readdirSync(directory).sort()).toEqual(['book.md', 'metadata.yaml']);

  const fallback = run(['build', 'book.md', '--yes', '--typograf-profile', 'literary-markdown'], directory, env);
  expect(fallback.status).toBe(0);
  expect(fallback.stderr).toContain('PDF не будет собран. Для PDF нужен typst');
  expect(readdirSync(join(directory, 'build')).sort()).toEqual(['epub', 'docx', 'html', 'fb2'].map((extension) => `Sample - beta - 1_0_0.${extension}`).sort());
});

test.skipIf(!pdfPandoc || !typst)('a real typst makes a PDF from a Cyrillic book', (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'book.md'), '# Глава\n\nТекст «в кавычках» — с тире.\n\n***\n\nДальше.\n');
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata.replace('lang: "en"', 'lang: "ru-RU"'));
  const built = run(['build', 'book.md', '--yes', '--formats', 'pdf', '--mode', 'production', '--typograf-profile', 'literary-markdown'], directory);
  expect(built.stderr).not.toContain('Ошибка');
  expect(built.status).toBe(0);
  expect(
    readFileSync(join(directory, 'build', 'Sample - 1_0_0.pdf'))
      .subarray(0, 5)
      .toString('latin1')
  ).toBe('%PDF-');
});

test.skipIf(!pandoc || pdfPandoc || process.platform === 'win32')('an old Pandoc cannot build PDF, even with typst', (t) => {
  const directory = workspace(t);
  const { bin, log } = fakeTypst(directory);
  writeFileSync(join(directory, 'book.md'), '# Глава\n\nТекст.\n');
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}` };
  const explicit = run(['build', 'book.md', '--yes', '--formats', 'pdf', '--typograf-profile', 'literary-markdown'], directory, env);
  expect(explicit.status).toBe(1);
  expect(explicit.stderr).toContain('Для PDF нужен Pandoc 3.2 или новее');
  const fallback = run(['build', 'book.md', '--yes', '--formats', 'fb2', '--typograf-profile', 'literary-markdown'], directory, env);
  expect(fallback.status).toBe(0);
  expect(existsSync(log)).toBe(false);
});

test.skipIf(!pandoc || process.platform === 'win32' || homebrewTypst)('a typst that cannot run stops only a build that needs PDF', (t) => {
  const directory = workspace(t);
  const bin = join(directory, 'tools');
  mkdirSync(bin);
  writeFileSync(join(bin, 'typst'), 'not a program', { mode: 0o644 });
  writeFileSync(join(directory, 'book.md'), '# Chapter\n\nText.\n');
  writeFileSync(join(directory, 'metadata.yaml'), plainMetadata);
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}` };
  const html = run(['build', 'book.md', '--yes', '--formats', 'html', '--typograf-profile', 'literary-markdown'], directory, env);
  expect(html.stderr).not.toContain('Ошибка');
  expect(html.status).toBe(0);
  const pdf = run(['build', 'book.md', '--yes', '--formats', 'pdf', '--overwrite'], directory, env);
  expect(pdf.status).toBe(1);
  expect(pdf.stderr).toContain('нельзя запустить');
});
