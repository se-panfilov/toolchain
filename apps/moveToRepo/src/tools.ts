import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Package manager directories come first, as in a terminal start on macOS and Linux. */
export const toolDirectories = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
/** The credential helper command contains this path. Only these characters cannot change the helper text. */
const safeToolPath = /^\/[A-Za-z0-9/._+-]+$/;
const outputLimit = 32 * 1024 * 1024;

/** Replace terminal control characters. File names, Git messages, and gh messages can contain them. */
export function safe(value: unknown): string {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' ? ch : '?'));
}

export class Interrupted extends Error {
  constructor() {
    super('Прервано.');
  }
}

/** Find an executable in fixed directories and in the absolute PATH entries. Never search the current directory. */
export function findExecutable(name: string, path = process.env.PATH ?? '', directories = toolDirectories): string {
  const candidates = [...directories, ...path.split(':').filter((entry) => isAbsolute(entry))];
  for (const directory of new Set(candidates)) {
    const candidate = join(directory, name);
    try {
      const real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
      if (!safeToolPath.test(candidate)) continue;
      return candidate;
    } catch {
      /* Continue to the next directory. */
    }
  }
  throw new Error(name === 'gh' ? 'GitHub CLI (gh) не найден. Установите его: https://cli.github.com' : `${name} не найден. Установите его.`);
}

// Variables that can select another GitHub host or repository, start an editor, a browser, or a pager, or ask questions.
const removedVariables = new Set([
  'GH_HOST',
  'GH_REPO',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_BROWSER',
  'BROWSER',
  'GH_EDITOR',
  'EDITOR',
  'VISUAL',
  'GH_PAGER',
  'PAGER',
  'GH_FORCE_TTY',
  'GH_DEBUG',
  'DEBUG'
]);
// SSH settings stay, because a user URL rewrite can select SSH for the push.
const keptGitVariables = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT']);

/**
 * Make the environment for Git and gh. Remove Git routing variables, such as GIT_DIR and GIT_CONFIG_PARAMETERS,
 * and gh variables that select another host or repository. Keep authentication: GH_TOKEN, HOME, SSH_AUTH_SOCK, and proxies.
 * Environment variable names are compared without letter case, as on Windows.
 */
export function toolEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value === undefined || removedVariables.has(upper)) continue;
    if (upper.startsWith('GIT_') && !keptGitVariables.has(upper)) continue;
    result[key] = value;
  }
  return {
    ...result,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    GH_PAGER: 'cat',
    PAGER: 'cat',
    NO_COLOR: '1',
    LC_ALL: 'C'
  };
}

export type RunOptions = { cwd: string; input?: Buffer | string; timeout?: number };

/** Start a tool with an argument array and no shell. Return stdout. Stop with the last lines of stderr on failure. */
export function runTool(tool: string, args: string[], options: RunOptions, label = tool): Buffer {
  const result = spawnSync(tool, args, {
    cwd: options.cwd,
    env: toolEnvironment(),
    input: options.input ?? '',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: outputLimit,
    timeout: options.timeout ?? 120000,
    windowsHide: true
  });
  // On a timeout, Node.js stops the process with SIGTERM. Check the timeout first, so it is not shown as an interruption.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`${label}: превышено время ожидания.`);
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM' || result.signal === 'SIGHUP') throw new Interrupted();
  if (result.error) throw new Error(`Не удалось запустить ${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const message = result.stderr.toString('utf8').trim().split('\n').slice(-3).join('\n');
    throw new Error(`${label}: ${message || `код ${result.status}`}`);
  }
  return result.stdout;
}
