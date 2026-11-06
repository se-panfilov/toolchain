import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envValue, ghEnvironment, tokenFromEnv, tokenFromGh, validToken, verifyToken } from '@repoRules/auth';
import { describe, expect, test, type TestContext } from 'vitest';

import { FakeApi } from './helpers.js';

const token = 'test-token-0123456789abcdef';

function fakeGh(context: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'reporules-auth-'));
  context.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh'), '');
  chmodSync(join(dir, 'gh'), 0o755);
  return dir;
}

describe('token sources', () => {
  test('GH_TOKEN comes before GITHUB_TOKEN', () => {
    expect(tokenFromEnv({ GH_TOKEN: token, GITHUB_TOKEN: `${token}x` }, 'linux')).toEqual({ value: token, source: 'GH_TOKEN' });
    expect(tokenFromEnv({ GITHUB_TOKEN: token }, 'linux')).toEqual({ value: token, source: 'GITHUB_TOKEN' });
    expect(tokenFromEnv({}, 'linux')).toBeUndefined();
  });

  test('environment variable names are not case sensitive on Windows only', () => {
    expect(envValue({ gh_token: token }, 'GH_TOKEN', 'win32')).toBe(token);
    expect(envValue({ gh_token: token }, 'GH_TOKEN', 'linux')).toBeUndefined();
  });

  test('a token with spaces or control characters is refused without echo', () => {
    expect(validToken('short')).toBe(false);
    expect(validToken(`${token}\nrm`)).toBe(false);
    expect(() => tokenFromEnv({ GH_TOKEN: `${token} x` }, 'linux')).toThrow('GH_TOKEN содержит недопустимые символы.');
    try {
      tokenFromEnv({ GH_TOKEN: `${token} x` }, 'linux');
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  test.skipIf(process.platform === 'win32')('gh auth token runs with an argument array and an isolated environment', async (context) => {
    const dir = fakeGh(context);
    const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
    const result = await tokenFromGh({ PATH: dir, GH_HOST: 'evil.example', GH_ENTERPRISE_TOKEN: 'x' }, (file, args, env) => {
      calls.push({ file, args, env });
      return Promise.resolve(`${token}\n`);
    });
    expect(result).toEqual({ value: token, source: 'gh' });
    expect(calls[0]?.file).toBe(join(dir, 'gh'));
    expect(calls[0]?.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(calls[0]?.env.GH_HOST).toBeUndefined();
    expect(calls[0]?.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
  });

  test('a relative PATH entry is never searched', async () => {
    let started = false;
    const result = await tokenFromGh({ PATH: '.:bin' }, () => {
      started = true;
      return Promise.resolve(token);
    });
    expect(result).toBeUndefined();
    expect(started).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('a failed gh call gives no token', async (context) => {
    const dir = fakeGh(context);
    expect(await tokenFromGh({ PATH: dir }, () => Promise.reject(new Error('not logged in')))).toBeUndefined();
  });

  test('the gh environment removes host and token overrides', () => {
    const env = ghEnvironment({ GH_HOST: 'x', gh_token: 'y', HOME: '/home/u' });
    expect(env).toMatchObject({ HOME: '/home/u', GH_PROMPT_DISABLED: '1' });
    expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain('GH_TOKEN');
    expect(env.GH_HOST).toBeUndefined();
  });
});

describe('token check', () => {
  test('an invalid token has a clear message', async () => {
    const api = new FakeApi().on('GET', '/user', { status: 401, body: { message: 'Bad credentials' } });
    await expect(verifyToken(api.client())).rejects.toThrow('недействителен или истёк');
  });

  test('a valid token returns the login', async () => {
    const api = new FakeApi().on('GET', '/user', { status: 200, body: { login: 'me' } });
    expect(await verifyToken(api.client())).toEqual({ login: 'me' });
  });
});
