import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Homebrew directories come first, as on Apple silicon and Intel Macs. */
export const toolDirectories = ['/opt/homebrew/bin', '/usr/local/bin'];
const systemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const outputLimit = 64 * 1024 * 1024;
/** Pandoc 3.0 added --split-level. The Lua filter uses the Pandoc 3 API. */
export const minimumPandoc = [3, 0] as const;

/**
 * Variables that the tools need. Other variables stay out: LUA_PATH and LUA_CPATH change the Lua
 * modules of a filter, JAVA_TOOL_OPTIONS and _JAVA_OPTIONS load Java agents into EPUBCheck,
 * XDG_DATA_HOME selects another Pandoc data directory.
 */
const keptPosix = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SOURCE_DATE_EPOCH', 'JAVA_HOME'];
const keptWindows = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SOURCE_DATE_EPOCH', 'JAVA_HOME'];

/** Make the environment for Pandoc and EPUBCheck. Names on Windows do not depend on letter case. */
export function toolEnvironment(tool: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  if (platform === 'win32') {
    for (const [name, value] of Object.entries(env)) if (keptWindows.includes(name.toUpperCase()) && value !== undefined) result[name.toUpperCase()] = value;
    return result;
  }
  for (const name of keptPosix) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  // The tool directory comes first. A wrapper script such as epubcheck finds java there or in system directories.
  result.PATH = [...new Set([dirname(tool), ...toolDirectories, ...systemPath])].join(':');
  return result;
}

function executable(path: string, platform: NodeJS.Platform): string | undefined {
  try {
    const real = realpathSync(path);
    if (!statSync(real).isFile()) return undefined;
    if (platform !== 'win32') accessSync(real, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

/** Find a tool by its name. Only absolute PATH entries count, so the current directory is never searched. */
export function findTool(name: string, path = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): string | undefined {
  const separator = platform === 'win32' ? ';' : ':';
  const file = platform === 'win32' ? `${name}.exe` : name;
  const directories = [...(platform === 'darwin' ? toolDirectories : []), ...path.split(separator).filter((entry) => entry !== '' && isAbsolute(entry))];
  for (const directory of new Set(directories)) {
    const found = executable(join(directory, file), platform);
    if (found) return found;
  }
  return undefined;
}

export type RunResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
export type RunOptions = { cwd: string; input?: string; timeout?: number };

/** Start a tool with an argument array and without a shell. */
export function run(tool: string, args: readonly string[], options: RunOptions): RunResult {
  const result = spawnSync(tool, args, {
    cwd: options.cwd,
    env: toolEnvironment(tool),
    encoding: 'utf8',
    input: options.input ?? '',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: outputLimit,
    timeout: options.timeout ?? 10 * 60 * 1000,
    shell: false,
    windowsHide: true
  });
  if (result.error) throw new Error(`Не удалось запустить ${tool}: ${result.error.message}`);
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

/** Last lines of tool output for an error message. */
export function lastLines(text: string, count = 5): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

export function runChecked(tool: string, args: readonly string[], options: RunOptions, label: string): RunResult {
  const result = run(tool, args, options);
  if (result.signal) throw new Error(`${label}: процесс остановлен сигналом ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${label}: код ${String(result.status)}.${result.stderr.trim() ? `\n${lastLines(result.stderr)}` : ''}`);
  return result;
}

/** Read the version from the first line of `pandoc --version`. */
export function parsePandocVersion(output: string): [number, number] | undefined {
  const match = /^pandoc(?:\.exe)?\s+(\d+)\.(\d+)/.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function checkPandocVersion(version: readonly [number, number] | undefined): void {
  if (!version) throw new Error('Не удалось определить версию Pandoc.');
  const [major, minor] = version;
  if (major < minimumPandoc[0] || (major === minimumPandoc[0] && minor < minimumPandoc[1])) {
    throw new Error(`Нужен Pandoc ${minimumPandoc.join('.')} или новее. Установлен ${version.join('.')}.`);
  }
}

/** Output format names from `pandoc --list-output-formats`. */
export function parseWriters(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9][a-z0-9_+.-]*$/.test(line));
}

export type Pandoc = { path: string; version: [number, number]; writers: string[] };

/** Find Pandoc, check its version, and read the list of output formats. */
export function findPandoc(cwd: string): Pandoc {
  const path = findTool('pandoc');
  if (!path) throw new Error('Pandoc не найден. Установите его: brew install pandoc');
  const version = parsePandocVersion(runChecked(path, ['--version'], { cwd, timeout: 30000 }, 'pandoc --version').stdout);
  checkPandocVersion(version);
  const writers = parseWriters(runChecked(path, ['--list-output-formats'], { cwd, timeout: 30000 }, 'pandoc --list-output-formats').stdout);
  if (!writers.length) throw new Error('Pandoc не вернул список выходных форматов.');
  return { path, version: version ?? [0, 0], writers };
}

/**
 * EPUBCheck is optional. Its `--version` exits with code 1 in version 4, so the search does not start it.
 * Wrapper scripts are not started on Windows without a shell, so the check skips there.
 */
export function findEpubcheck(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return undefined;
  return findTool('epubcheck', process.env.PATH ?? '', platform);
}
