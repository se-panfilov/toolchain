import { checkBranch, checkOwner, cloneUrl, compareUrl, parseRepository, parseRepositoryInfo, parseUser } from '@moveToRepo/github';
import { describe, expect, test } from 'vitest';

describe('repository address', () => {
  test.each([
    ['https://github.com/me/notes', 'notes'],
    ['https://github.com/me/notes.git', 'notes'],
    ['https://github.com/me/notes/', 'notes'],
    ['git@github.com:me/notes.git', 'notes'],
    ['https://github.com/me/.github', '.github'],
    ['https://github.com/my-org/my.repo_1', 'my.repo_1']
  ])('accept %s', (value, name) => {
    expect(parseRepository(value).name).toBe(name);
  });

  test.each([
    'http://github.com/me/notes',
    'https://gitlab.com/me/notes',
    'https://github.com.evil.example/me/notes',
    'https://user:token@github.com/me/notes',
    'https://github.com:443/me/notes',
    'https://GITHUB.com/me/notes',
    'https://github.com/me/notes?x=1',
    'https://github.com/me/notes#x',
    'https://github.com/me/notes/tree/main',
    'https://github.com/me/..',
    'https://github.com/me/.git',
    'https://github.com/-me/notes',
    'ext::sh -c touch% /tmp/x',
    'file:///tmp/repo',
    '/tmp/repo',
    'me/notes',
    'https://github.com/me/noтes',
    'https://github.com/me/notes\n'
  ])('reject %j', (value) => {
    expect(() => parseRepository(value)).toThrow(/--repo/);
  });

  test('the clone address is built from the checked parts', () => {
    expect(cloneUrl({ owner: 'me', name: 'notes' })).toBe('https://github.com/me/notes.git');
  });
});

describe('branch names', () => {
  test.each(['main', 'release/1.2', 'feature/add_x', 'v1'])('accept %s', (value) => {
    expect(checkBranch(value, 'b')).toBe(value);
  });

  test.each(['', '-f', '--force', 'HEAD', 'a..b', 'a//b', 'a/', '/a', '.a', 'a/.b', 'a.lock', 'a/b.lock', 'a.', 'a@{1}', 'a b', 'a~1', 'a^', 'a:b', '+main', 'ветка', 'a\\b'])('reject %j', (value) => {
    expect(() => checkBranch(value, 'b')).toThrow(/недопустимое имя ветки/);
  });
});

describe('repository information', () => {
  const repo = { owner: 'me', name: 'notes' };
  const json = (data: object): string =>
    JSON.stringify({ nameWithOwner: 'me/notes', viewerPermission: 'WRITE', isArchived: false, defaultBranchRef: { name: 'main' }, visibility: 'PRIVATE', isPrivate: true, ...data });

  test('write access gives the full name and the default branch', () => {
    expect(parseRepositoryInfo(json({}), repo)).toEqual({ fullName: 'me/notes', defaultBranch: 'main', visibility: 'PRIVATE' });
    expect(parseRepositoryInfo(json({ visibility: 'PUBLIC', isPrivate: false }), repo).visibility).toBe('PUBLIC');
    expect(parseRepositoryInfo(json({ visibility: 'PRIVATE', isPrivate: false }), repo).visibility).toBe('UNKNOWN');
    expect(() => parseRepositoryInfo(json({ visibility: undefined }), repo)).toThrow(/видимость/);
    expect(() => parseRepositoryInfo(json({ visibility: 'SECRET' }), repo)).toThrow(/видимость/);
    expect(parseRepositoryInfo(json({ nameWithOwner: 'Me/Notes' }), repo).fullName).toBe('Me/Notes');
  });

  test('read access, archives, moved repositories, and bad data stop the run', () => {
    expect(() => parseRepositoryInfo(json({ viewerPermission: 'READ' }), repo)).toThrow(/Нет прав/);
    expect(() => parseRepositoryInfo(json({ viewerPermission: 'TRIAGE' }), repo)).toThrow(/Нет прав/);
    expect(() => parseRepositoryInfo(json({ isArchived: true }), repo)).toThrow(/в архиве/);
    expect(() => parseRepositoryInfo(json({ nameWithOwner: 'other/notes' }), repo)).toThrow(/перенесён/);
    expect(() => parseRepositoryInfo(json({ nameWithOwner: 'me/notes\n' }), repo)).toThrow(/некорректное имя/);
    expect(() => parseRepositoryInfo(json({ defaultBranchRef: { name: '-x' } }), repo)).toThrow(/недопустимое имя ветки/);
    expect(() => parseRepositoryInfo('not json', repo)).toThrow(/некорректный ответ/);
  });

  test('the compare page uses the full name', () => {
    expect(compareUrl({ fullName: 'me/notes', defaultBranch: 'main', visibility: 'PRIVATE' }, 'main', 'movetorepo/ab12cd34')).toBe(
      'https://github.com/me/notes/compare/main...movetorepo/ab12cd34?expand=1'
    );
  });
});

describe('repository owner', () => {
  test('gh user JSON gives the login', () => {
    expect(parseUser('{"login":"Me-1","id":1}')).toBe('Me-1');
    expect(() => parseUser('not json')).toThrow(/некорректный ответ/);
    expect(() => parseUser('{"login":"-x"}')).toThrow(/имя пользователя/);
    expect(() => parseUser('{"login":"a/b"}')).toThrow(/имя пользователя/);
    expect(() => parseUser('[]')).toThrow(/имя пользователя/);
  });

  test('only a repository of the signed-in user is permitted', () => {
    expect(() => checkOwner({ fullName: 'me/notes', defaultBranch: 'main', visibility: 'PRIVATE' }, 'me')).not.toThrow();
    expect(() => checkOwner({ fullName: 'Me/notes', defaultBranch: 'main', visibility: 'PRIVATE' }, 'mE')).not.toThrow();
    expect(() => checkOwner({ fullName: 'my-org/notes', defaultBranch: 'main', visibility: 'PRIVATE' }, 'me')).toThrow(/принадлежит my-org/);
    expect(() => checkOwner({ fullName: 'mee/notes', defaultBranch: 'main', visibility: 'PRIVATE' }, 'me')).toThrow(/только в свои репозитории/);
  });

  test.each(['PUBLIC', 'INTERNAL', 'UNKNOWN'])('an own %s repository is rejected', (visibility) => {
    expect(() => checkOwner({ fullName: 'me/notes', defaultBranch: 'main', visibility }, 'me')).toThrow(/только в приватные/);
  });
});
