import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetDirectory,
  betaNotice,
  checkFile,
  checkOutputDirectory,
  createOutputDirectory,
  isCoverImage,
  outputStem,
  pandocArguments,
  type PandocContext,
  parseMode,
  placeFiles,
  profiles,
  resolveFormats,
  writerExtension
} from '@reBook/book';
import { expect, test, type TestContext } from 'vitest';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-rebook-book-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const writers = ['docx', 'epub2', 'epub3', 'html5', 'json', 'markdown', 'odt'];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('formats accept profiles, aliases, and listed Pandoc writers', () => {
  expect(resolveFormats('epub,docx,html', writers).map((item) => item.key)).toEqual(['epub', 'docx', 'html']);
  expect(resolveFormats(' Word , EPUB3, epub ', writers).map((item) => item.key)).toEqual(['docx', 'epub']);
  expect(resolveFormats('odt', writers)).toEqual([{ key: 'odt', label: 'odt', writer: 'odt', extension: 'odt', kind: 'other' }]);
  expect(() => resolveFormats('pdf', writers)).toThrow(/Неизвестный формат: pdf/);
  expect(() => resolveFormats('../../x', writers)).toThrow(/Неизвестный формат/);
  expect(() => resolveFormats(',,', writers)).toThrow(/Не выбран/);
  expect(() => resolveFormats('epub,epub2', writers)).toThrow(/одинаковым расширением/);
  expect(() => resolveFormats('epub', ['docx'])).toThrow(/Неизвестный формат/);
  expect(writerExtension('html4')).toBe('html');
  expect(writerExtension('gfm+smart')).toBeUndefined();
});

test('the mode accepts beta and production only', () => {
  expect(parseMode('beta')).toBe('beta');
  expect(parseMode('PROD')).toBe('production');
  expect(() => parseMode('draft')).toThrow(/beta или production/);
});

test('output names cannot leave the output directory', () => {
  expect(outputStem('My Book', '1.2.3+build.7', 'beta')).toBe('My Book - beta - 1_2_3_build_7');
  expect(outputStem('My Book', '1.0.0', 'production')).toBe('My Book - 1_0_0');
  expect(outputStem('../../etc/passwd', '1.0.0', 'production')).toBe('_.._etc_passwd - 1_0_0');
  expect(outputStem('..', '', 'production')).toBe('book');
  expect(outputStem('a\u0000b\u001b[31mc‮:d', '', 'production')).toBe('a_b_[31mc__d');
  expect(outputStem('x'.repeat(300), '', 'production')).toHaveLength(120);
  // Long runs of dots and spaces must not make the name check slow.
  expect(outputStem(`${'.'.repeat(100000)}x${' .'.repeat(100000)}`, '', 'production')).toBe('x');
});

test('the default assets are in the package and contain no book data', () => {
  const directory = assetDirectory();
  expect(readdirSync(directory).sort()).toEqual(['epub.css', 'reference.docx', 'scene-breaks.lua']);
  const docx = readFileSync(join(directory, 'reference.docx')).toString('latin1');
  expect(docx.startsWith('PK\x03\x04')).toBe(true);
  for (const name of ['epub.css', 'scene-breaks.lua']) expect(readFileSync(join(directory, name), 'utf8')).not.toMatch(/urn:uuid|@|https?:/);
});

test('file checks accept real files of the expected type only', (t) => {
  const directory = workspace(t);
  const cover = join(directory, 'cover.png');
  writeFileSync(cover, png);
  expect(checkFile(cover, 'cover')).toContain('cover.png');
  const fake = join(directory, 'fake.png');
  writeFileSync(fake, 'not an image');
  expect(() => checkFile(fake, 'cover')).toThrow(/JPEG, PNG/);
  const wrongExtension = join(directory, 'cover.svg');
  writeFileSync(wrongExtension, png);
  expect(() => checkFile(wrongExtension, 'cover')).toThrow(/JPEG, PNG/);
  expect(() => checkFile(join(directory, 'missing.md'), 'input')).toThrow(/не найден/);
  expect(() => checkFile(directory, 'input')).toThrow(/обычным файлом/);
  const empty = join(directory, 'empty.md');
  writeFileSync(empty, '');
  expect(() => checkFile(empty, 'input')).toThrow(/пустой/);
  const binary = join(directory, 'binary.md');
  writeFileSync(binary, Buffer.from([0x41, 0, 0x42]));
  expect(() => checkFile(binary, 'input')).toThrow(/текстовый/);
  const docx = join(directory, 'style.docx');
  writeFileSync(docx, 'plain text');
  expect(() => checkFile(docx, 'referenceDoc')).toThrow(/\.docx/);
  const css = join(directory, 'style.txt');
  writeFileSync(css, 'p {}');
  expect(() => checkFile(css, 'css')).toThrow(/\.css/);
  expect(isCoverImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
  expect(isCoverImage(Buffer.from('GIF89a'))).toBe(true);
  expect(isCoverImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
});

const context: PandocContext = {
  dataDir: '/work/data',
  metadata: '/work/metadata.yaml',
  filter: '/assets/scene-breaks.lua',
  css: '/assets/epub.css',
  referenceDoc: '/assets/reference.docx',
  cover: '/book/cover.png',
  mode: 'beta',
  resourcePath: '/book',
  input: '/book/--help.md'
};

test('Pandoc arguments keep paths out of option position', () => {
  const [epub, docx, html] = profiles.map((target) => pandocArguments(target, context, '/work/out'));
  expect(epub).toEqual([
    '--data-dir=/work/data',
    '--metadata-file=/work/metadata.yaml',
    '--resource-path=/book',
    '--lua-filter=/assets/scene-breaks.lua',
    '--to=epub3',
    '--split-level=1',
    '--css=/assets/epub.css',
    '--epub-cover-image=/book/cover.png',
    '--epub-title-page=false',
    '--output=/work/out',
    '--',
    '/book/--help.md'
  ]);
  expect(docx).toContain('--reference-doc=/assets/reference.docx');
  expect(html).toEqual(expect.arrayContaining(['--to=html5', '--standalone', '--embed-resources', '--css=/assets/epub.css']));
  const production = pandocArguments(profiles[0] ?? { key: '', label: '', writer: '', extension: '', kind: 'epub' }, { ...context, mode: 'production', cover: undefined }, '/o');
  expect(production).not.toContain('--epub-title-page=false');
  expect(production.some((arg) => arg.startsWith('--epub-cover-image'))).toBe(false);
  expect(pandocArguments({ key: 'odt', label: 'odt', writer: 'odt', extension: 'odt', kind: 'other' }, context, '/o')).toContain('--to=odt');
});

test('the beta notice escapes Markdown in the title and follows the book language', () => {
  const notice = betaNotice('*Bold* [link](x)', '1.0.0', '2024-01-01', 'ru-RU');
  expect(notice).toContain('**\\*Bold\\* \\[link\\]\\(x\\)**');
  expect(notice).toContain('Черновая версия для бета-чтения.');
  expect(betaNotice('T', '1.0.0', '2024-01-01', 'en-US')).toContain('Draft version for beta readers.');
  expect(notice.startsWith('::: {.beta-notice}\n')).toBe(true);
});

test('the output directory must be a real directory', (t) => {
  const directory = workspace(t);
  const output = join(directory, 'a', 'b');
  expect(checkOutputDirectory(output)).toBe(false);
  createOutputDirectory(output);
  expect(checkOutputDirectory(output)).toBe(true);
  const link = join(directory, 'link');
  symlinkSync(output, link);
  expect(() => checkOutputDirectory(link)).toThrow(/символической ссылкой/);
  const file = join(directory, 'file');
  writeFileSync(file, '');
  expect(() => checkOutputDirectory(file)).toThrow(/не является каталогом/);
});

test('results replace existing files only with overwrite and never through links', (t) => {
  const directory = workspace(t);
  const source = join(directory, 'source.epub');
  writeFileSync(source, 'new');
  const out = join(directory, 'out');
  mkdirSync(out);
  const target = join(out, 'book.epub');
  placeFiles([{ source, target }], false);
  expect(readFileSync(target, 'utf8')).toBe('new');
  writeFileSync(source, 'newer');
  expect(() => placeFiles([{ source, target }], false)).toThrow(/--overwrite/);
  expect(readFileSync(target, 'utf8')).toBe('new');
  expect(placeFiles([{ source, target }], true)).toEqual([]);
  expect(readFileSync(target, 'utf8')).toBe('newer');
  const victim = join(directory, 'victim.txt');
  writeFileSync(victim, 'keep');
  const link = join(out, 'link.epub');
  symlinkSync(victim, link);
  expect(() => placeFiles([{ source, target: link }], true)).toThrow(/не обычный файл/);
  expect(readFileSync(victim, 'utf8')).toBe('keep');
  expect(readdirSync(out).sort()).toEqual(['book.epub', 'link.epub']);
  expect(existsSync(source)).toBe(true);
});

test.skipIf(process.platform === 'win32')('a replaced result keeps its permission bits', (t) => {
  const directory = workspace(t);
  const source = join(directory, 'source.html');
  writeFileSync(source, 'new');
  const target = join(directory, 'book.html');
  writeFileSync(target, 'old');
  chmodSync(target, 0o600);
  placeFiles([{ source, target }], true);
  expect(readFileSync(target, 'utf8')).toBe('new');
  expect(statSync(target).mode & 0o777).toBe(0o600);
  chmodSync(target, 0o640);
  placeFiles([{ source, target }], true);
  expect(statSync(target).mode & 0o777).toBe(0o640);
  expect(readdirSync(directory).sort()).toEqual(['book.html', 'source.html']);
});

test('a failed last step brings the old results back and removes new names', (t) => {
  const directory = workspace(t);
  const source = join(directory, 'source');
  writeFileSync(source, 'new');
  const out = join(directory, 'out');
  mkdirSync(out);
  const replaced = join(out, 'book.epub');
  writeFileSync(replaced, 'old');
  const created = join(out, 'book.docx');
  expect(() =>
    placeFiles(
      [
        { source, target: replaced },
        { source, target: created }
      ],
      true,
      () => {
        throw new Error('metadata failed');
      }
    )
  ).toThrow(/metadata failed\nПрежние файлы результата восстановлены/);
  expect(readFileSync(replaced, 'utf8')).toBe('old');
  expect(readdirSync(out)).toEqual(['book.epub']);
});
