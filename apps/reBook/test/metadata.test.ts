import { chmodSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultLanguage,
  defaultRights,
  emptyFields,
  fieldProblem,
  graphemes,
  isIsoDate,
  isLanguageTag,
  isSemver,
  isUuidIdentifier,
  type MetadataFields,
  newIdentifier,
  parseMetadata,
  renderMetadata,
  updateMetadataFile,
  updateMetadataText,
  writeNewFile
} from '@reBook/metadata';
import { expect, test, type TestContext } from 'vitest';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-rebook-metadata-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const fields: MetadataFields = { title: 'Sample title', author: 'Sample author', lang: defaultLanguage, description: 'Sample description', rights: defaultRights };

test('new identifiers are random UUID version 4 values in the urn:uuid form', () => {
  const first = newIdentifier();
  const second = newIdentifier();
  expect(first).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first).not.toBe(second);
  expect(isUuidIdentifier(first)).toBe(true);
  expect(isUuidIdentifier('urn:isbn:9780000000000')).toBe(false);
});

test('versions use SemVer and dates are real calendar dates', () => {
  for (const value of ['0.1.0', '1.2.3-beta.1', '1.2.3+build.7']) expect(isSemver(value)).toBe(true);
  for (const value of ['1.2', 'v1.2.3', '01.2.3', '1.2.3 ', '1.2.3/x']) expect(isSemver(value)).toBe(false);
  expect(isIsoDate('2024-02-29')).toBe(true);
  expect(isIsoDate('2023-02-29')).toBe(false);
  expect(isIsoDate('2024-13-01')).toBe(false);
  expect(isIsoDate('24-01-01')).toBe(false);
  expect(isLanguageTag('ru-RU')).toBe(true);
  expect(isLanguageTag('en')).toBe(true);
  expect(isLanguageTag('ru_RU')).toBe(false);
});

test('field checks reject control characters, line breaks, and missing required values', () => {
  expect(fieldProblem('title', '')).toMatch(/обязательное/);
  expect(fieldProblem('author', '')).toMatch(/обязательное/);
  expect(fieldProblem('description', '')).toBeUndefined();
  expect(fieldProblem('title', 'a\nb')).toMatch(/управляющие/);
  expect(fieldProblem('title', 'a b')).toMatch(/управляющие/);
  expect(fieldProblem('title', 'a‮b')).toMatch(/управляющие/);
  expect(fieldProblem('lang', 'Russian')).toMatch(/код языка/);
  expect(fieldProblem('title', 'x'.repeat(501))).toMatch(/не длиннее/);
  expect(graphemes('👨‍👩‍👧é')).toHaveLength(2);
});

test('the metadata template quotes values and keeps empty optional fields as comments', () => {
  const text = renderMetadata({ ...fields, title: 'Title: "quoted" # not a comment', description: '' }, 'urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f');
  expect(text).toContain('title: "Title: \\"quoted\\" # not a comment"');
  expect(text).toContain('# description: ""');
  expect(text).toContain('# subtitle: ""');
  expect(text).toContain('lang: "ru-RU"');
  expect(text).toContain('rights: "Unpublished manuscript. All rights reserved."');
  expect(text).toContain('date: ""\nversion: ""');
  expect(text).toContain('    text: "urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f"');
  expect(text).toContain('ibooks:\n  version: ""');
  expect(() => renderMetadata({ ...fields, title: 'a\nb: c' }, newIdentifier())).toThrow(/управляющие/);
  expect(() => renderMetadata(fields, 'not-a-uuid')).toThrow(/identifier/);
});

test('a new file never replaces an existing file or follows a link', (t) => {
  const directory = workspace(t);
  const path = join(directory, 'metadata.yaml');
  writeNewFile(path, 'title: "a"\n');
  expect(readFileSync(path, 'utf8')).toBe('title: "a"\n');
  expect(() => {
    writeNewFile(path, 'title: "b"\n');
  }).toThrow(/уже существует/);
  expect(readFileSync(path, 'utf8')).toBe('title: "a"\n');
  const victim = join(directory, 'victim.txt');
  const link = join(directory, 'link.yaml');
  symlinkSync(victim, link);
  expect(() => {
    writeNewFile(link, 'x');
  }).toThrow(/уже существует/);
  expect(readdirSync(directory).sort()).toEqual(['link.yaml', 'metadata.yaml']);
});

const sample = ['title: "Book"', 'date: ""', 'version: "0.1.0"', '# version: "ignored comment"', 'ibooks:', '  # nested comment', '  version: "0.1.0"', '  other: "kept"', 'subject: []', ''].join(
  '\n'
);

test('the update changes only top-level version, date, and ibooks.version', () => {
  const next = updateMetadataText(sample, { version: '0.2.0', date: '2024-05-06' });
  expect(next).toBe(
    ['title: "Book"', 'date: "2024-05-06"', 'version: "0.2.0"', '# version: "ignored comment"', 'ibooks:', '  # nested comment', '  version: "0.2.0"', '  other: "kept"', 'subject: []', ''].join('\n')
  );
  expect(updateMetadataText(sample, { date: '2024-05-06' })).toContain('  version: "0.1.0"');
  expect(updateMetadataText(sample.replaceAll('\n', '\r\n'), { version: '1.0.0' })).toContain('version: "1.0.0"\r\n');
  expect(() => updateMetadataText('title: "a"\n', { version: '1.0.0' })).toThrow(/version/);
  expect(() => updateMetadataText('title: "a"\n', { date: '2024-01-01' })).toThrow(/date/);
  // A nested key outside ibooks stays as it is.
  expect(updateMetadataText('other:\n  version: "x"\nversion: ""\n', { version: '1.0.0' })).toBe('other:\n  version: "x"\nversion: "1.0.0"\n');
});

test('the file update is atomic, keeps the mode, and stops after a concurrent change', (t) => {
  const directory = workspace(t);
  const path = join(directory, 'metadata.yaml');
  writeFileSync(path, sample);
  chmodSync(path, 0o640);
  updateMetadataFile(path, sample, { version: '0.3.0' });
  expect(readFileSync(path, 'utf8')).toContain('version: "0.3.0"');
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o640);
  expect(readdirSync(directory)).toEqual(['metadata.yaml']);
  expect(() => {
    updateMetadataFile(path, sample, { version: '0.4.0' });
  }).toThrow(/изменился/);
  expect(readFileSync(path, 'utf8')).toContain('version: "0.3.0"');
});

test('the file update refuses links that a rename would break', (t) => {
  const directory = workspace(t);
  const real = join(directory, 'real.yaml');
  writeFileSync(real, sample);
  const link = join(directory, 'link.yaml');
  symlinkSync(real, link);
  expect(() => {
    updateMetadataFile(link, sample, { version: '1.0.0' });
  }).toThrow(/символическая ссылка/);
  const hard = join(directory, 'hard.yaml');
  linkSync(real, hard);
  expect(() => {
    updateMetadataFile(hard, sample, { version: '1.0.0' });
  }).toThrow(/жёсткие ссылки/);
  expect(readFileSync(real, 'utf8')).toBe(sample);
});

const str = (text: string): { t: string; c: unknown[] } => ({
  t: 'MetaInlines',
  c: text.split(' ').flatMap((word, index) => (index ? [{ t: 'Space' }, { t: 'Str', c: word }] : [{ t: 'Str', c: word }]))
});

test('Pandoc JSON gives title, version, identifiers, and empty fields', () => {
  const meta = {
    title: str('My Book'),
    subtitle: { t: 'MetaString', c: '' },
    version: str('1.0.0'),
    date: { t: 'MetaInlines', c: [] },
    lang: str('en-US'),
    ibooks: { t: 'MetaMap', c: { version: str('1.0.0') } },
    creator: { t: 'MetaList', c: [{ t: 'MetaMap', c: { role: str('author'), text: { t: 'MetaInlines', c: [] } } }] },
    subject: { t: 'MetaList', c: [] },
    identifier: { t: 'MetaList', c: [{ t: 'MetaMap', c: { scheme: str('URN'), text: str('urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f') } }] }
  };
  const parsed = parseMetadata(JSON.stringify({ meta, blocks: [] }));
  expect(parsed.title).toBe('My Book');
  expect(parsed.version).toBe('1.0.0');
  expect(parsed.ibooksVersion).toBe('1.0.0');
  expect(parsed.lang).toBe('en-US');
  expect(parsed.identifiers).toEqual([{ text: 'urn:uuid:2ec0dbf3-baf9-419d-b7e4-525e7d2af23f', scheme: 'URN' }]);
  expect(parsed.empty.sort()).toEqual(['creator[1].text', 'date', 'subtitle']);
  expect(emptyFields({ subject: { t: 'MetaList', c: [] }, flag: { t: 'MetaBool', c: false } })).toEqual([]);
  expect(() => parseMetadata('not json')).toThrow(/некорректный/);
});

test('a title list uses the main title, and quotes stay in the text', () => {
  const quoted = { t: 'MetaInlines', c: [{ t: 'Quoted', c: [{ t: 'DoubleQuote' }, [{ t: 'Str', c: 'Main' }]] }] };
  const meta = {
    title: {
      t: 'MetaList',
      c: [
        { t: 'MetaMap', c: { type: str('subtitle'), text: str('Sub') } },
        { t: 'MetaMap', c: { type: str('main'), text: quoted } }
      ]
    }
  };
  expect(parseMetadata(JSON.stringify({ meta })).title).toBe('“Main”');
});
