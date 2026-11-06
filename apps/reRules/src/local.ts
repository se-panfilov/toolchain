import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import type { RepoRef } from '@reRules/github';
import { parseRepo } from '@reRules/repo';

const maxFileBytes = 1024 * 1024;
const maxDepth = 64;

export type LocalRepo = { ref: RepoRef; remote: string };

/** Read a small regular file. Return undefined for a missing file, a link, another file type, or a large file. */
function readSmallFile(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxFileBytes) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Find the Git directory for `start` or one of its parents, as Git does without environment variables.
 * A `.git` file (worktree or submodule) points to the real Git directory with `gitdir:`.
 * Git is not started: reading the files cannot run hooks, filters, or other configured programs.
 */
export function findGitDir(start: string): string | undefined {
  let current = resolve(start);
  for (let depth = 0; depth < maxDepth; depth++) {
    const candidate = join(current, '.git');
    try {
      const stat = lstatSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const line = (readSmallFile(candidate) ?? '').split(/\r?\n/).find((item) => item.startsWith('gitdir:'));
        const target = line?.slice('gitdir:'.length).trim();
        if (!target) return undefined;
        const gitDir = isAbsolute(target) ? target : resolve(current, target);
        return statSync(gitDir).isDirectory() ? gitDir : undefined;
      }
      // A link or another file type is not followed. A parent repository would be the wrong answer.
      return undefined;
    } catch {
      /* No .git entry here. Continue with the parent directory. */
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return undefined;
    current = parent;
  }
  return undefined;
}

/** A linked worktree keeps the shared configuration in the directory that `commondir` names. */
function configPath(gitDir: string): string {
  const common = readSmallFile(join(gitDir, 'commondir'))?.trim();
  return join(common ? resolve(gitDir, common) : gitDir, 'config');
}

/** Read `remote.<name>.url` values from Git configuration text. Includes and URL rewrites are not followed. */
export function remoteUrls(config: string): Map<string, string> {
  const urls = new Map<string, string>();
  let remote: string | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const section = /^\[\s*remote\s+"([^"\\]{1,100})"\s*\]$/i.exec(line);
      remote = section?.[1];
      continue;
    }
    if (remote === undefined) continue;
    // Parse `url = value` without a backtracking pattern.
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim().toLowerCase() !== 'url') continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // Git uses the first url value of a remote for fetch.
    if (value && !urls.has(remote)) urls.set(remote, value);
  }
  return urls;
}

/**
 * Convert a GitHub remote URL to owner/repo. User data in the URL, such as a token, is removed and never returned.
 * Only github.com is accepted.
 */
export function githubRef(url: string): RepoRef | undefined {
  let candidate = url.trim();
  const ssh = /^ssh:\/\/git@github\.com(?::22)?\/(.+)$/i.exec(candidate);
  if (ssh?.[1]) candidate = `git@github.com:${ssh[1]}`;
  else if (/^https:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname.toLowerCase() !== 'github.com' || (parsed.port && parsed.port !== '443') || parsed.search || parsed.hash) return undefined;
      candidate = `https://github.com${parsed.pathname}`;
    } catch {
      return undefined;
    }
  }
  // A local path such as `team/project` must not pass as the short owner/repo form.
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)/i.test(candidate)) return undefined;
  try {
    return parseRepo(candidate);
  } catch {
    return undefined;
  }
}

/** The GitHub repository of the local Git copy in `cwd`: remote `origin`, or the only GitHub remote. */
export function localRepo(cwd: string = process.cwd()): LocalRepo | undefined {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return undefined;
  const config = readSmallFile(configPath(gitDir));
  if (!config) return undefined;
  const refs = [...remoteUrls(config)].flatMap(([remote, url]) => {
    const ref = githubRef(url);
    return ref ? [{ ref, remote }] : [];
  });
  return refs.find((item) => item.remote === 'origin') ?? (refs.length === 1 ? refs[0] : undefined);
}
