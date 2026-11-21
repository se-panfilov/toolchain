import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildWhitelist,
  checkWhitelistName,
  defaultLocale,
  defaultWhitelistName,
  defaultWhitelistPath,
  detectLineEnding,
  formattedManuscriptPath,
  isFormattedManuscriptName,
  loadWhitelistFile,
  parseTypografProfile,
  parseWhitelist,
  renderWhitelist,
  schemaVersion,
  typografExecute
} from '@reBook/typograf';
import Typograf from 'typograf';
import { expect, test, type TestContext } from 'vitest';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-rebook-typograf-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('parseTypografProfile accepts the two known profiles and rejects anything else', () => {
  expect(parseTypografProfile('default')).toBe('default');
  expect(parseTypografProfile('literary-markdown')).toBe('literary-markdown');
  expect(parseTypografProfile(' DEFAULT ')).toBe('default');
  expect(() => parseTypografProfile('strict')).toThrow(/Неизвестный профиль/);
});

test('DEFAULT has exactly the 85 common/ru rules that Typograf Core enables by default', () => {
  const whitelist = buildWhitelist('default');
  expect(whitelist.schemaVersion).toBe(schemaVersion);
  expect(whitelist.locale).toBe(defaultLocale);
  expect(whitelist.enabledRules.length).toBe(85);
  expect(new Set(whitelist.enabledRules).size).toBe(85);
  const expected = Typograf.getRules()
    .filter((rule) => (rule.locale === 'ru' || rule.locale === 'common') && rule.enabled)
    .map((rule) => rule.name)
    .sort();
  expect([...whitelist.enabledRules].sort()).toEqual(expected);
});

test('LITERARY-MARKDOWN has exactly the 10 conservative rules', () => {
  const whitelist = buildWhitelist('literary-markdown');
  expect(whitelist.enabledRules.length).toBe(10);
  expect(new Set(whitelist.enabledRules).size).toBe(10);
  expect([...whitelist.enabledRules].sort()).toEqual(
    [
      'common/nbsp/afterShortWord',
      'common/other/delBOM',
      'common/punctuation/hellip',
      'ru/dash/izpod',
      'ru/dash/izza',
      'ru/dash/ka',
      'ru/dash/kakto',
      'ru/dash/koe',
      'ru/dash/taki',
      'ru/dash/to'
    ].sort()
  );
  for (const name of whitelist.enabledRules) {
    const rule = Typograf.getRule(name);
    expect(rule).not.toBeNull();
    expect(['common', 'ru']).toContain(rule?.locale);
  }
});

test('an empty enabledRules array is a valid whitelist', () => {
  const whitelist = parseWhitelist(renderWhitelist({ schemaVersion, locale: defaultLocale, enabledRules: [] }));
  expect(whitelist.enabledRules).toEqual([]);
  expect(typografExecute('a  b', whitelist)).toBe('a  b');
});

test('parseWhitelist rejects invalid JSON, unknown rules, duplicates, masks, schema version, and locale', () => {
  expect(() => parseWhitelist('not json')).toThrow(/некорректный JSON/);
  expect(() => parseWhitelist('[]')).toThrow(/объектом JSON/);
  expect(() => parseWhitelist(JSON.stringify({ schemaVersion: 2, locale: 'ru', enabledRules: [] }))).toThrow(/версия схемы/);
  expect(() => parseWhitelist(JSON.stringify({ schemaVersion, locale: 'xx', enabledRules: [] }))).toThrow(/Неизвестная локаль/);
  expect(() => parseWhitelist(JSON.stringify({ schemaVersion, locale: 'ru', enabledRules: ['common/punctuation/*'] }))).toThrow(/Маски/);
  expect(() => parseWhitelist(JSON.stringify({ schemaVersion, locale: 'ru', enabledRules: ['ru/not/a/rule'] }))).toThrow(/Неизвестное правило/);
  expect(() => parseWhitelist(JSON.stringify({ schemaVersion, locale: 'ru', enabledRules: ['ru/dash/izpod', 'ru/dash/izpod'] }))).toThrow(/повторно/);
  expect(() => parseWhitelist(JSON.stringify({ schemaVersion, locale: 'ru', enabledRules: [1] }))).toThrow(/массивом строк/);
  // en-GB/dash/main exists in Typograf Core, but not for the ru locale, so it must be rejected here.
  expect(() => parseWhitelist(JSON.stringify({ schemaVersion, locale: 'ru', enabledRules: ['en-GB/dash/main'] }))).toThrow(/относится к локали/);
});

test('loadWhitelistFile checks file type, size, and extension before parsing', (t) => {
  const directory = workspace(t);
  expect(() => loadWhitelistFile(join(directory, 'missing.json'))).toThrow(/не найден/);
  const notJson = join(directory, 'rules.txt');
  writeFileSync(notJson, renderWhitelist(buildWhitelist('default')));
  expect(() => loadWhitelistFile(notJson)).toThrow(/расширение \.json/);
  const empty = join(directory, 'empty.json');
  writeFileSync(empty, '');
  expect(() => loadWhitelistFile(empty)).toThrow(/пустой/);
  const huge = join(directory, 'huge.json');
  writeFileSync(huge, `{"schemaVersion":1,"locale":"ru","enabledRules":[${'"a",'.repeat(80000)}"b"]}`);
  expect(() => loadWhitelistFile(huge)).toThrow(/больше/);
});

test('defaultWhitelistPath sits next to the manuscript', () => {
  expect(defaultWhitelistPath('/a/b/manuscript.md')).toBe(join('/a/b', defaultWhitelistName));
});

test('a custom whitelist with a subset of rules only applies the listed rules', () => {
  const whitelist = parseWhitelist(JSON.stringify({ schemaVersion, locale: 'ru', enabledRules: ['common/punctuation/hellip'] }));
  // Only the ellipsis rule is enabled: the double space stays, because common/space/delRepeatSpace is not in the whitelist.
  expect(typografExecute('Привет...  мир', whitelist)).toBe('Привет…  мир');
});

test('detectLineEnding finds the style already used by the source text and typografExecute keeps it', () => {
  expect(detectLineEnding('a\nb')).toBe('LF');
  expect(detectLineEnding('a\r\nb')).toBe('CRLF');
  expect(detectLineEnding('a\rb')).toBe('CR');
  const whitelist = parseWhitelist(JSON.stringify({ schemaVersion, locale: 'ru', enabledRules: [] }));
  expect(typografExecute('a\r\nb\r\n', whitelist)).toBe('a\r\nb\r\n');
});

test('isFormattedManuscriptName and formattedManuscriptPath recognize the generated file', () => {
  expect(isFormattedManuscriptName('book.formatted.md')).toBe(true);
  expect(isFormattedManuscriptName('book.FORMATTED.MARKDOWN')).toBe(true);
  expect(isFormattedManuscriptName('book.md')).toBe(false);
  expect(isFormattedManuscriptName('book.formatted.txt')).toBe(false);
  expect(formattedManuscriptPath('/a/book.md')).toBe('/a/book.formatted.md');
  expect(formattedManuscriptPath('/a/book.markdown')).toBe('/a/book.formatted.markdown');
});

test('a Markdown manuscript keeps its structure through the LITERARY-MARKDOWN profile', () => {
  const whitelist = buildWhitelist('literary-markdown');
  const source = [
    '# I {.story-title}',
    '',
    '— Привет, — сказала она.',
    '',
    'Он посмотрел из за дерева...',
    '',
    '*Курсивный текст.*',
    '',
    '**Жирный текст.**',
    '',
    '\\*\\*\\*',
    '',
    '# ❦ {.interlude-title}',
    '',
    '::: {.book-page}',
    '',
    '# Вторая часть',
    '',
    ':::',
    '',
    '- Первый пункт',
    '- Второй пункт',
    '',
    '1. Первый пункт',
    '2. Второй пункт',
    '',
    '[Документация](https://example.org/manual)',
    '',
    '![Illustration](images/illustration.png)',
    ''
  ].join('\n');
  const formatted = typografExecute(source, whitelist);
  expect(formatted).toContain('# I {.story-title}');
  expect(formatted).toContain('*Курсивный текст.*');
  expect(formatted).toContain('**Жирный текст.**');
  expect(formatted).toContain('\\*\\*\\*');
  expect(formatted).toContain('::: {.book-page}');
  expect(formatted).toContain(':::');
  expect(formatted).toContain('- Первый пункт');
  expect(formatted).toContain('- Второй пункт');
  expect(formatted).toContain('1. Первый пункт');
  expect(formatted).toContain('[Документация](https://example.org/manual)');
  expect(formatted).toContain('![Illustration](images/illustration.png)');
  // ru/dash/izza joins a split preposition-noun pair with a hyphen, a conservative and well-known fix.
  expect(formatted).toContain('из-за дерева');
});

test('LITERARY-MARKDOWN puts a non-breaking space only after a short word and keeps list markers', () => {
  const whitelist = buildWhitelist('literary-markdown');
  const source = '- Пункт списка\n1. И вот\nа у меня и так всё в порядке — подумал он.\n';
  const formatted = typografExecute(source, whitelist);
  // U+00A0 as a character, not an HTML entity: Markdown code and attributes must not get `&nbsp;`.
  expect(formatted).not.toContain('&nbsp;');
  expect(formatted).toBe('- Пункт списка\n1. И\u00a0вот\nа\u00a0у\u00a0меня и\u00a0так всё в\u00a0порядке — подумал он.\n');
  // No other space changes: removing the non-breaking spaces gives the source back.
  expect(formatted.replaceAll('\u00a0', ' ')).toBe(source);
});

test('LITERARY-MARKDOWN keeps intentional repetitions and does not rewrite blank lines or hard breaks', () => {
  const whitelist = buildWhitelist('literary-markdown');
  const source = 'Нет, нет, нет!\n\nСтрока с принудительным переносом.  \nВторая строка.\n\n> Цитата в тексте.\n';
  const formatted = typografExecute(source, whitelist);
  // Only the spaces after the short words become non-breaking. The hard break and blank lines stay.
  expect(formatted).toBe(source.replace('с принудительным', 'с\u00a0принудительным').replace('Цитата в тексте', 'Цитата в\u00a0тексте'));
});

test('LITERARY-MARKDOWN removes a UTF-8 BOM and turns three dots into an ellipsis, also inside code (known limitation)', () => {
  const whitelist = buildWhitelist('literary-markdown');
  const withBom = `\ufeff# Текст\n\nМноготочие... в прозе.\n\nInline \`code...\` stays.\n\n\`\`\`\ncode...\n\`\`\`\n`;
  const formatted = typografExecute(withBom, whitelist);
  expect(formatted.startsWith('\ufeff')).toBe(false);
  expect(formatted).toContain('Многоточие… в\u00a0прозе.');
  // This is a known limitation: Typograf Core is not a Markdown parser, and the rule matches dots anywhere,
  // including inside inline or fenced code. The project does not claim full Markdown safety (see README).
  expect(formatted).toContain('`code…`');
  expect(formatted).toContain('code…\n');
});

test('YAML frontmatter and Pandoc heading attributes survive the LITERARY-MARKDOWN profile', () => {
  const whitelist = buildWhitelist('literary-markdown');
  const source = '---\ntitle: "Книга"\nversion: "1.0.0"\n---\n\n# Глава {.chapter-title}\n\nТекст главы.\n';
  const formatted = typografExecute(source, whitelist);
  expect(formatted).toContain('title: "Книга"');
  expect(formatted).toContain('# Глава {.chapter-title}');
});

test('known limitations: LITERARY-MARKDOWN also changes code and a YAML end marker', () => {
  const whitelist = buildWhitelist('literary-markdown');
  // Typograf Core is not a Markdown parser. These tests record the damage that the README documents.
  expect(typografExecute('Код `a и b` здесь.\n', whitelist)).toBe('Код `a и\u00a0b` здесь.\n');
  expect(typografExecute('```\nx = a и b\n```\n', whitelist)).toBe('```\nx = a и\u00a0b\n```\n');
  // A YAML block that ends with `...` loses its end marker. End a YAML block with `---`.
  expect(typografExecute('---\ntitle: "T"\n...\n', whitelist)).toBe('---\ntitle: "T"\n…\n');
});

test('a formatted name keeps the extension, and a name without one gets .formatted.md', () => {
  expect(formattedManuscriptPath('/a/book.md')).toBe('/a/book.formatted.md');
  expect(formattedManuscriptPath('/a/book.markdown')).toBe('/a/book.formatted.markdown');
  expect(formattedManuscriptPath('/a/book')).toBe('/a/book.formatted.md');
});

test('a whitelist must be a .json file', () => {
  expect(() => checkWhitelistName('/a/rules.txt')).toThrow(/\.json/);
  checkWhitelistName('/a/rules.JSON');
});
