import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetDirectory,
  betaNotice,
  checkFile,
  checkOutputDirectory,
  checkTargets,
  createOutputDirectory,
  isCoverImage,
  outputStem,
  pandocArguments,
  type PandocContext,
  parseMode,
  placeFiles,
  profiles,
  resolveFormats,
  typstArguments,
  writerExtension
} from '@reBook/book';
import { hasAccessControlList } from '@reBook/tools';
import { expect, test, type TestContext } from 'vitest';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-rebook-book-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const writers = ['docx', 'epub2', 'epub3', 'fb2', 'html5', 'json', 'markdown', 'odt', 'typst'];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('formats accept profiles, aliases, and listed Pandoc writers', () => {
  expect(resolveFormats('epub,docx,html', writers).map((item) => item.key)).toEqual(['epub', 'docx', 'html']);
  expect(resolveFormats(' Word , EPUB3, epub ', writers).map((item) => item.key)).toEqual(['docx', 'epub']);
  expect(resolveFormats('odt', writers)).toEqual([{ key: 'odt', label: 'odt', writer: 'odt', extension: 'odt', kind: 'other' }]);
  expect(resolveFormats('fb2, PDF', writers).map((item) => item.kind)).toEqual(['fb2', 'pdf']);
  // The name typst selects the Typst writer, not the PDF profile.
  expect(resolveFormats('typst', writers)).toEqual([{ key: 'typst', label: 'typst', writer: 'typst', extension: 'typst', kind: 'other' }]);
  expect(() => resolveFormats('pdf', ['epub3'])).toThrow(/Неизвестный формат: pdf/);
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
  expect(readdirSync(directory).sort()).toEqual(['epub.css', 'pdf.yaml', 'reference.docx', 'scene-breaks.lua']);
  const docx = readFileSync(join(directory, 'reference.docx')).toString('latin1');
  expect(docx.startsWith('PK\x03\x04')).toBe(true);
  for (const name of ['epub.css', 'pdf.yaml', 'scene-breaks.lua']) expect(readFileSync(join(directory, name), 'utf8')).not.toMatch(/urn:uuid|@|https?:/);
  // The PDF page settings have only layout fields, no book data.
  const keys = readFileSync(join(directory, 'pdf.yaml'), 'utf8')
    .split('\n')
    .filter((line) => /^[a-z]/.test(line))
    .map((line) => line.split(':')[0]);
  expect(keys).toEqual(['papersize', 'margin', 'fontsize']);
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
  pdfDefaults: '/assets/pdf.yaml',
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
  const [, , , fb2, pdf] = profiles.map((target) => pandocArguments(target, context, '/work/out'));
  expect(fb2).toEqual(expect.arrayContaining(['--to=fb2', '--metadata=cover-image:/book/cover.png']));
  expect(pandocArguments(profiles[3] ?? { key: '', label: '', writer: '', extension: '', kind: 'fb2' }, { ...context, cover: undefined }, '/o').some((arg) => arg.includes('cover-image'))).toBe(false);
  // The book metadata comes after the PDF defaults, so its values win.
  expect(pdf?.slice(0, 3)).toEqual(['--data-dir=/work/data', '--metadata-file=/assets/pdf.yaml', '--metadata-file=/work/metadata.yaml']);
  expect(pdf).toEqual(expect.arrayContaining(['--to=typst', '--standalone', '--extract-media=media']));
  expect(pdf?.some((arg) => arg.startsWith('--pdf-engine'))).toBe(false);
  expect(typstArguments('/work/pdf', '/work/typst-packages', '/work/pdf/book.typ', '/work/result.pdf')).toEqual([
    'compile',
    '--root=/work/pdf',
    `--package-path=${join('/work/typst-packages', 'local')}`,
    `--package-cache-path=${join('/work/typst-packages', 'cache')}`,
    '--',
    '/work/pdf/book.typ',
    '/work/result.pdf'
  ]);
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
  placeFiles([{ source, target, replace: false }]);
  expect(readFileSync(target, 'utf8')).toBe('new');
  writeFileSync(source, 'newer');
  expect(() => placeFiles([{ source, target, replace: false }])).toThrow(/--overwrite/);
  expect(readFileSync(target, 'utf8')).toBe('new');
  expect(placeFiles([{ source, target, replace: true }])).toEqual([]);
  expect(readFileSync(target, 'utf8')).toBe('newer');
  const victim = join(directory, 'victim.txt');
  writeFileSync(victim, 'keep');
  const link = join(out, 'link.epub');
  symlinkSync(victim, link);
  expect(() => placeFiles([{ source, target: link, replace: true }])).toThrow(/не обычный файл/);
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
  placeFiles([{ source, target, replace: true }]);
  expect(readFileSync(target, 'utf8')).toBe('new');
  expect(statSync(target).mode & 0o777).toBe(0o600);
  chmodSync(target, 0o640);
  placeFiles([{ source, target, replace: true }]);
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
        { source, target: replaced, replace: true },
        { source, target: created, replace: true }
      ],
      () => {
        throw new Error('metadata failed');
      }
    )
  ).toThrow(/metadata failed\nПрежние файлы результата восстановлены/);
  expect(readFileSync(replaced, 'utf8')).toBe('old');
  expect(readdirSync(out)).toEqual(['book.epub']);
});

test('a rollback keeps a newer file that another process saved at the result path', (t) => {
  const directory = workspace(t);
  const source = join(directory, 'source');
  writeFileSync(source, 'new');
  const target = join(directory, 'book.html');
  writeFileSync(target, 'old');
  let message = '';
  try {
    placeFiles([{ source, target, replace: true }], () => {
      // Another process saves its own file at the same path before the last step fails.
      const other = join(directory, 'other');
      writeFileSync(other, 'newer');
      renameSync(other, target);
      throw new Error('metadata failed');
    });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('изменён другим процессом');
  expect(readFileSync(target, 'utf8')).toBe('newer');
  const kept = readdirSync(directory).filter((name) => name.endsWith('.old'));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(directory, kept[0] ?? ''), 'utf8')).toBe('old');
});

test('only a placement with replace can replace an existing file', (t) => {
  const directory = workspace(t);
  const source = join(directory, 'source');
  writeFileSync(source, 'new');
  const allowed = join(directory, 'book.html');
  const other = join(directory, 'book.docx');
  writeFileSync(allowed, 'old html');
  writeFileSync(other, 'old docx');
  expect(() =>
    checkTargets([
      { target: allowed, replace: true },
      { target: other, replace: false }
    ])
  ).toThrow(/book\.docx/);
  expect(() =>
    placeFiles([
      { source, target: allowed, replace: true },
      { source, target: other, replace: false }
    ])
  ).toThrow(/--overwrite/);
  expect(readFileSync(allowed, 'utf8')).toBe('old html');
  expect(readFileSync(other, 'utf8')).toBe('old docx');
});

const setfacl = ['/usr/bin/setfacl', '/bin/setfacl'].find((path) => existsSync(path));
// macOS sets ACL entries with chmod +a. On Linux, setfacl comes from the acl package.
const aclCommand: [string, string[]] | undefined =
  process.platform === 'darwin' ? ['/bin/chmod', ['+a', 'user:nobody deny read']] : process.platform === 'linux' && setfacl ? [setfacl, ['-m', 'u:nobody:r']] : undefined;

test.skipIf(!aclCommand)('a result with an ACL is not replaced', (t) => {
  const directory = workspace(t);
  const source = join(directory, 'source');
  writeFileSync(source, 'new');
  const target = join(directory, 'book.html');
  writeFileSync(target, 'old');
  const [command, args] = aclCommand ?? ['', []];
  const result = spawnSync(command, [...args, target]);
  if (result.status !== 0) {
    t.skip();
    return;
  }
  expect(hasAccessControlList(target)).toBe(true);
  expect(hasAccessControlList(source)).toBe(false);
  expect(() => placeFiles([{ source, target, replace: true }])).toThrow(/ACL/);
  expect(readFileSync(target, 'utf8')).toBe('old');
});
