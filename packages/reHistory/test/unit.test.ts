import { expect, test } from 'vitest';
import { parseDate, parseStart } from '@reHistory/cli';
import { stripTagSignature, validateIdentity, withoutGitEnvironment } from '@reHistory/engine';

test.each([
  '1970-01-01T00:00:00Z',
  '1970-01-01T01:00:00+01:00',
  '1969-12-31T23:00:00-01:00',
])('часовой пояс сохраняет начало Unix: %s', value => {
  expect(parseDate(value)).toBe(0);
});

test.each([
  '2026-02-29T12:00:00Z',
  '2026-01-01T24:00:00Z',
  '2026-01-01T12:60:00Z',
  '2016-12-31T23:59:60Z',
  '2026-01-01T12:00:00+24:00',
])('некорректная дата отклоняется: %s', value => {
  expect(() => parseDate(value)).toThrow();
});

test('раздельные дата и время совпадают с полным ISO-временем', () => {
  expect(parseStart('2000-02-29', '01:02:03+03:30')).toBe(parseDate('2000-02-29T01:02:03+03:30'));
  expect(parseDate('2000-02-29T00:00:00Z')).toBe(951782400);
});

test.each([
  ['Имя\ncommitter injected', 'name@example.org'],
  ['Имя', 'name@example.org\n'],
  ['Имя\x1b[31m', 'name@example.org'],
  ['Имя', 'name@exam\u200bple.org'],
])('идентичность отвергает управляющие символы: %j', (name, email) => {
  expect(() => validateIdentity(name, email)).toThrow();
});

test.each(['GIT_DIR', 'git_work_tree', 'Git_Config_Count', 'gIt_SsH_CoMmAnD'])('изоляция Git удаляет %s без изменения входа', key => {
  const source = { [key]: '/untrusted', GITHUB_ACTIONS: 'true', PATH: '/trusted' };
  expect(withoutGitEnvironment(source)).toEqual({ GITHUB_ACTIONS: 'true', PATH: '/trusted' });
  expect(source[key]).toBe('/untrusted');
});

test.each(['PGP SIGNATURE', 'SSH SIGNATURE'])('снятие %s сохраняет бинарное сообщение', kind => {
  const prefix = Buffer.from([0, 255, 128, 10]);
  const message = Buffer.concat([prefix, Buffer.from(`-----BEGIN ${kind}-----\nbody\n-----END ${kind}-----\n`)]);
  expect(stripTagSignature(message).message.equals(prefix)).toBe(true);
  expect(stripTagSignature(prefix).stripped).toBe(false);
  expect(() => stripTagSignature(Buffer.concat([message, Buffer.from('important message')]))).toThrow(/Неоднозначная подпись/);
});
