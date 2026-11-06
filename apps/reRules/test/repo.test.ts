import { checkPair, loadRepo, parseRepo } from '@reRules/repo';
import { describe, expect, test } from 'vitest';

import { FakeApi, repo } from './helpers.js';

describe('repository identifiers', () => {
  test.each([
    ['me/project', 'me', 'project'],
    ['https://github.com/me/project', 'me', 'project'],
    ['https://github.com/me/project.git', 'me', 'project'],
    ['https://github.com/me/project/', 'me', 'project'],
    ['git@github.com:me/project.git', 'me', 'project'],
    ['  me/my.repo_1  ', 'me', 'my.repo_1']
  ])('%s is %s/%s', (input, owner, name) => {
    expect(parseRepo(input)).toEqual({ owner, name });
  });

  test.each([
    'me',
    'me/',
    '/project',
    'me/project/extra',
    'https://gitlab.com/me/project',
    'http://github.com/me/project',
    'me/..',
    '-me/project',
    'me-/project',
    'me/pro ject',
    'me/project?x=1',
    'https://github.com.evil.example/me/project'
  ])('%s is rejected', (input) => {
    expect(() => parseRepo(input)).toThrow('Нужен репозиторий GitHub');
  });
});

describe('source and target checks', () => {
  test('the same repository is refused, also with other letter case', () => {
    expect(() => checkPair(repo('me', 'template'), repo('Me', 'Template', { id: 1 }))).toThrow('один и тот же');
  });

  test('an archived target or a target without write access stops the run', () => {
    expect(() => checkPair(repo('me', 'template'), repo('me', 'project', { archived: true }))).toThrow('в архиве');
    const readOnly = repo('me', 'project', { permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } });
    expect(() => checkPair(repo('me', 'template'), readOnly)).toThrow('Нет прав на запись');
  });

  test('missing administrator rights give warnings, not a stop', () => {
    const writer = repo('me', 'project', { permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } });
    expect(checkPair(repo('me', 'template'), writer)).toEqual([expect.stringContaining('Нет прав администратора в me/project')]);
  });
});

describe('repository loading', () => {
  test('a renamed repository is refused', async () => {
    const api = new FakeApi().on('GET', '/repos/me/old', { status: 200, body: { id: 3, name: 'new', full_name: 'me/new', owner: { login: 'me', type: 'User' }, default_branch: 'main' } });
    await expect(loadRepo(api.client(), { owner: 'me', name: 'old' })).rejects.toThrow('другой репозиторий');
  });

  test('a missing repository has a clear message', async () => {
    await expect(loadRepo(new FakeApi().client(), { owner: 'me', name: 'none' })).rejects.toThrow('не найден или нет доступа');
  });

  test('repository data and permissions come from the API response', async () => {
    const api = new FakeApi().on('GET', '/repos/me/project', {
      status: 200,
      body: {
        id: 9,
        name: 'project',
        full_name: 'me/project',
        owner: { login: 'me', type: 'Organization' },
        default_branch: 'trunk',
        private: true,
        visibility: 'private',
        permissions: { admin: true, push: true, pull: true }
      }
    });
    const info = await loadRepo(api.client(), { owner: 'me', name: 'project' });
    expect(info).toMatchObject({ id: 9, ownerType: 'Organization', defaultBranch: 'trunk', private: true, permissions: { admin: true, maintain: false } });
  });
});
