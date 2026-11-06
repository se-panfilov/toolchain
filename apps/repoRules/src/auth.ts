import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { ApiError, type GitHubClient } from '@repoRules/github';
import { rec, str } from '@repoRules/state';

export type TokenSource = 'GH_TOKEN' | 'GITHUB_TOKEN' | 'gh' | 'input';
export type Token = { value: string; source: TokenSource };
type Env = Record<string, string | undefined>;

/** A token is printable ASCII without spaces. This rejects pasted text with line breaks or control characters. */
export function validToken(value: string): boolean {
  return /^[\x21-\x7e]{20,255}$/.test(value);
}

/** Read an environment variable. On Windows, names are not case sensitive. */
export function envValue(env: Env, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((item) => item.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

export function tokenFromEnv(env: Env = process.env, platform: NodeJS.Platform = process.platform): Token | undefined {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const value = envValue(env, name, platform)?.trim();
    if (!value) continue;
    if (!validToken(value)) throw new Error(`${name} содержит недопустимые символы.`);
    return { value, source: name };
  }
  return undefined;
}

/** Find gh in absolute PATH entries only. The current directory is never searched. */
export function findGh(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = envValue(env, 'PATH', platform) ?? '';
  const names = platform === 'win32' ? ['gh.exe'] : ['gh'];
  const extra = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  for (const directory of new Set([...path.split(platform === 'win32' ? ';' : delimiter), ...extra])) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== 'win32') accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* Try the next directory. */
      }
    }
  }
  return undefined;
}

// Variables that select another host, an enterprise token, a pager, or debug output with request data.
const removedGhVariables = new Set(['GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'DEBUG', 'GH_PAGER', 'PAGER', 'GH_FORCE_TTY', 'GH_TOKEN', 'GITHUB_TOKEN']);

export function ghEnvironment(env: Env = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !removedGhVariables.has(key.toUpperCase())) result[key] = value;
  return { ...result, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
}

export type GhRunner = (file: string, args: string[], env: Record<string, string>) => Promise<string>;

const runGh: GhRunner = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) reject(new Error('gh auth token завершился с ошибкой.'));
      else resolve(stdout);
    });
  });

/** Ask GitHub CLI for its stored github.com token. Return undefined when gh is absent or not signed in. */
export async function tokenFromGh(env: Env = process.env, run: GhRunner = runGh, platform: NodeJS.Platform = process.platform): Promise<Token | undefined> {
  const gh = findGh(env, platform);
  if (!gh) return undefined;
  try {
    const value = (await run(gh, ['auth', 'token', '--hostname', 'github.com'], ghEnvironment(env))).trim();
    return validToken(value) ? { value, source: 'gh' } : undefined;
  } catch {
    return undefined;
  }
}

export type Identity = { login: string };

/** Check the token with GET /user. */
export async function verifyToken(client: GitHubClient): Promise<Identity> {
  try {
    const user = rec(await client.get('/user'));
    const login = str(user.login);
    if (!login) throw new Error('GitHub не вернул имя пользователя.');
    return { login };
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'auth') throw new Error('Токен GitHub недействителен или истёк. Обновите токен или выполните gh auth login.', { cause: error });
    throw error;
  }
}

export function sourceLabel(source: TokenSource): string {
  const labels: Record<TokenSource, string> = {
    GH_TOKEN: 'переменная GH_TOKEN',
    GITHUB_TOKEN: 'переменная GITHUB_TOKEN',
    gh: 'GitHub CLI (gh auth token)',
    input: 'токен, введённый вручную'
  };
  return labels[source];
}

export const authGuide = `Токен GitHub не найден. Варианты:
  1. Выполните gh auth login и запустите программу снова.
  2. Задайте GH_TOKEN или GITHUB_TOKEN в окружении.
  3. Введите токен сейчас. Он не сохраняется и не выводится.
Рекомендуется fine-grained токен только для двух репозиториев:
  источник — Metadata, Administration, Contents, Actions, Environments, Variables, Secrets, Webhooks, Issues, Pages: чтение;
  цель — те же разделы: чтение и запись только для переносимых категорий.
Classic токен: repo, read:org (проверка команд), admin:repo_hook (вебхуки).`;
