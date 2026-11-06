import { ApiError, classify, GitHubClient, repoPath } from '@repoRules/github';
import { describe, expect, test } from 'vitest';

import { FakeApi } from './helpers.js';

const source = { owner: 'me', name: 'template' };
const target = { owner: 'me', name: 'project' };

describe('write guard', () => {
  test('mutations are refused before the final confirmation', async () => {
    const api = new FakeApi().on('PATCH', '/repos/me/project', { status: 200, body: {} });
    const client = api.client();
    await expect(client.mutate('PATCH', repoPath(target), {})).rejects.toThrow('Изменения запрещены');
    expect(api.requests).toHaveLength(0);
  });

  test('only the target repository and its team grants can change', async () => {
    const api = new FakeApi().on('PATCH', '/repos/me/project', { status: 200, body: {} }).on('PUT', /^\/orgs\/me\/teams\/devs\/repos\/me\/project$/, { status: 204 });
    const client = api.client();
    client.allowWrites(target);
    await client.mutate('PATCH', repoPath(target), { description: 'x' });
    await client.mutate('PUT', '/orgs/me/teams/devs/repos/me/project', { permission: 'push' });
    await expect(client.mutate('PATCH', repoPath(source), {})).rejects.toThrow('вне целевого репозитория');
    await expect(client.mutate('PUT', '/orgs/me/teams/devs/repos/me/template', {})).rejects.toThrow('вне целевого репозитория');
    await expect(client.mutate('PATCH', '/repos/me/project-other', {})).rejects.toThrow('вне целевого репозитория');
    expect(api.mutations).toHaveLength(2);
  });

  test('a frozen client never writes, also after allowWrites', () => {
    const client = new FakeApi().client();
    client.freezeWrites();
    expect(() => {
      client.allowWrites(target);
    }).toThrow();
    expect(() => {
      client.assertWritable(repoPath(target));
    }).toThrow('запрещены');
  });

  test('path segments are encoded, so data cannot add path parts', () => {
    expect(repoPath(target, 'environments', 'prod/../../x')).toBe('/repos/me/project/environments/prod%2F..%2F..%2Fx');
  });

  test('dot segments are refused, because URL normalization would remove them', async () => {
    for (const segment of ['..', '.', '%2e%2E', '']) expect(() => repoPath(target, 'labels', segment)).toThrow('Недопустимая часть пути API');
    const client = new FakeApi().client();
    client.allowWrites(target);
    await expect(client.mutate('PATCH', '/repos/me/project/../template', {})).rejects.toThrow('нормализации');
  });
});

describe('requests', () => {
  test('pagination follows next links on api.github.com only', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/labels', (request) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? { status: 200, body: [{ name: 'b' }] }
          : { status: 200, body: [{ name: 'a' }], headers: { link: '<https://api.github.com/repos/me/template/labels?page=2>; rel="next"' } }
      )
      .on('GET', '/repos/me/evil/labels', { status: 200, body: [], headers: { link: '<https://evil.example/steal>; rel="next"' } });
    const client = api.client();
    expect(await client.paginate(repoPath(source, 'labels'))).toEqual([{ name: 'a' }, { name: 'b' }]);
    await expect(client.paginate('/repos/me/evil/labels')).rejects.toThrow('другой адрес');
    expect(api.requests.every((request) => request.url.startsWith('https://api.github.com/'))).toBe(true);
  });

  test('the token goes only in the authorization header', async () => {
    const api = new FakeApi().on('GET', '/user', { status: 200, body: { login: 'me' } });
    await api.client().get('/user');
    const [request] = api.requests;
    expect(request?.headers.authorization).toBe('Bearer test-token-0123456789abcdef');
    expect(request?.url).not.toContain('test-token');
  });

  test('a secondary rate limit waits and repeats the request', async () => {
    let calls = 0;
    const waits: number[] = [];
    const api = new FakeApi().on('GET', '/user', () =>
      ++calls === 1 ? { status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: { 'retry-after': '3' } } : { status: 200, body: { login: 'me' } }
    );
    const client = new GitHubClient({ token: 'test-token-0123456789abcdef', transport: api.transport, sleep: (ms) => Promise.resolve(void waits.push(ms)) });
    expect(await client.get('/user')).toEqual({ login: 'me' });
    expect(waits).toEqual([3000]);
  });

  test('a long primary rate limit stops instead of waiting for hours', async () => {
    const api = new FakeApi().on('GET', '/user', {
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 7200) }
    });
    await expect(api.client().get('/user')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  test('a 5xx error repeats a read but never a mutation', async () => {
    let reads = 0;
    const api = new FakeApi()
      .on('GET', '/user', () => (++reads < 3 ? { status: 502 } : { status: 200, body: { login: 'me' } }))
      .on('POST', '/repos/me/project/labels', { status: 502, body: { message: 'Bad gateway' } });
    const client = api.client();
    expect(await client.get('/user')).toEqual({ login: 'me' });
    client.allowWrites(target);
    await expect(client.mutate('POST', repoPath(target, 'labels'), { name: 'x' })).rejects.toMatchObject({ kind: 'transient' });
    expect(api.mutations).toHaveLength(1);
  });

  test('a redirect is not followed and stops with a clear error', async () => {
    const api = new FakeApi().on('GET', '/repos/me/old', { status: 301, headers: { location: 'https://api.github.com/repositories/5' } });
    await expect(api.client().get('/repos/me/old')).rejects.toMatchObject({ kind: 'redirect' });
    expect(api.requests).toHaveLength(1);
  });
});

describe('error classes', () => {
  test.each([
    [401, { message: 'Bad credentials' }, 'auth'],
    [403, { message: 'Resource not accessible by integration' }, 'permission'],
    [403, { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' }, 'unsupported'],
    [404, { message: 'Not Found' }, 'not-found'],
    [409, { message: 'Actions is disabled by the organization' }, 'conflict'],
    [422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'already_exists' }] }, 'validation'],
    [503, {}, 'transient']
  ])('HTTP %i is %s', (status, data, kind) => {
    const error = classify(status, data);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe(kind);
  });

  test('API messages are sanitized', () => {
    expect(classify(422, { message: 'bad\x1b[31m text' }).message).toBe('bad?[31m text');
  });
});
