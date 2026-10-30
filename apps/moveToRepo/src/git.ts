import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SourceFile } from '@moveToRepo/files';
import { runTool } from '@moveToRepo/tools';

export type Change = SourceFile & { mode: '100644' | '100755'; state: 'add' | 'replace' | 'same' };
type TreeEntry = { mode: string; type: string; oid: string };

/**
 * Settings for each Git call. They have priority over the user configuration:
 * no hooks from core.hooksPath, no fsmonitor program, no automatic maintenance,
 * only HTTPS and SSH transports, no submodules, no tags on push.
 * The credential helper list is cleared, then gh gives the token of the signed-in GitHub user.
 */
export function gitConfig(gh: string, hooks: string): string[] {
  const settings = [
    `core.hooksPath=${hooks}`,
    'core.fsmonitor=false',
    'gc.auto=0',
    'maintenance.auto=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.ssh.allow=always',
    'credential.helper=',
    `credential.helper=!${gh} auth git-credential`,
    'submodule.recurse=false',
    'fetch.recurseSubmodules=false',
    'push.recurseSubmodules=no',
    'push.followTags=false'
  ];
  return ['--no-pager', ...settings.flatMap((setting) => ['-c', setting])];
}

/** Parse `git ls-tree -z` output: `<mode> <type> <oid>TAB<path>NUL`. */
export function parseTree(output: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(record);
    const [, mode, type, oid, path] = match ?? [];
    if (!mode || !type || !oid || !path) throw new Error('Git вернул некорректный список файлов.');
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

/** All parent directories of the destination paths, for example `a` and `a/b` for `a/b/c.txt`. */
export function parentDirectories(paths: string[]): string[] {
  const result = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) result.add(segments.slice(0, i).join('/'));
  }
  return [...result];
}

/** The commit message: only the list of changed files. */
export function commitMessage(changes: Change[]): string {
  return `${changes.map((change) => change.target).join('\n')}\n`;
}

/** The pull request title: the list of changed files, shortened to about 120 characters. */
export function pullRequestTitle(changes: Change[]): string {
  const title = changes.map((change) => change.target).join(', ');
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

export function pullRequestBody(changes: Change[]): string {
  return `${changes.map((change) => `- \`${change.target}\``).join('\n')}\n`;
}

/** Push the commit to a new branch. No force and no `+` refspec: the server rejects a push that replaces other commits. */
export function pushArguments(url: string, commit: string, branch: string): string[] {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Некорректный ID коммита.');
  return ['push', '--quiet', '--no-verify', '--', url, `${commit}:refs/heads/${branch}`];
}

/** A shallow clone of one branch in a private temporary directory. The work tree is never written. */
export class Clone {
  readonly path: string;
  private readonly config: string[];

  constructor(
    readonly git: string,
    readonly gh: string,
    readonly work: string
  ) {
    const hooks = join(work, 'hooks');
    mkdirSync(hooks, { mode: 0o700 });
    this.path = join(work, 'repository');
    this.config = gitConfig(gh, hooks);
  }

  run(args: string[], input?: Buffer | string, timeout?: number): string {
    return runTool(this.git, [...this.config, '-C', this.path, ...args], { cwd: this.work, ...(input === undefined ? {} : { input }), ...(timeout === undefined ? {} : { timeout }) }, 'git').toString(
      'utf8'
    );
  }

  /**
   * Clone without a checkout: no file in the work tree, no checkout filters, no hooks.
   * The URL is built from checked parts. `--` ends the options before the URL and the path.
   */
  clone(url: string, base: string): void {
    runTool(
      this.git,
      [...this.config, 'clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--no-checkout', '--branch', base, '--', url, this.path],
      { cwd: this.work, timeout: 600000 },
      'git clone'
    );
    // --branch also accepts a tag. A tag gives a detached HEAD, and a pull request needs a branch.
    const head = this.run(['symbolic-ref', '--quiet', 'HEAD']).trim();
    if (head !== `refs/heads/${base}`) throw new Error(`${base} — не ветка репозитория.`);
    this.run(['read-tree', 'HEAD']);
  }

  /** Compare the files with the base branch. Stop when a destination or its parent is not a regular file or directory. */
  plan(files: SourceFile[]): Change[] {
    const targets = files.map((file) => file.target);
    const parents = parentDirectories(targets);
    const tree = parseTree(this.run(['ls-tree', '-z', '--full-tree', 'HEAD', '--', ...parents, ...targets]));
    for (const parent of parents) {
      const entry = tree.get(parent);
      if (entry && entry.mode !== '040000') throw new Error(`В репозитории ${parent} — не каталог.`);
    }
    return files.map((file) => {
      const mode = file.executable ? '100755' : '100644';
      const entry = tree.get(file.target);
      if (entry && entry.mode !== '100644' && entry.mode !== '100755') throw new Error(`В репозитории ${file.target} — не обычный файл (каталог, ссылка или подмодуль). Замена запрещена.`);
      if (!entry) return { ...file, mode, state: 'add' };
      const oid = this.run(['hash-object', '--no-filters', '--stdin'], file.content).trim();
      return { ...file, mode, state: oid === entry.oid && mode === entry.mode ? 'same' : 'replace' };
    });
  }

  /** Write the objects and make one commit on top of the base branch. Return the commit ID. */
  commit(changes: Change[]): string {
    const lines = changes.map((change) => `${change.mode} ${this.run(['hash-object', '-w', '--no-filters', '--stdin'], change.content).trim()}\t${change.target}\n`);
    this.run(['update-index', '--add', '--index-info'], lines.join(''));
    const tree = this.run(['write-tree']).trim();
    const commit = this.run(['commit-tree', tree, '-p', 'HEAD', '-F', '-'], commitMessage(changes)).trim();
    // The commit must change only the listed files.
    const changed = this.run(['diff-tree', '-r', '--no-renames', '--name-only', '-z', 'HEAD', commit]).split('\0').filter(Boolean).sort();
    const expected = changes.map((change) => change.target).sort();
    if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error('Коммит содержит неожиданные изменения. Отправка отменена.');
    return commit;
  }

  /** Check that the branch does not exist on the server. */
  branchExists(url: string, branch: string): boolean {
    return this.run(['ls-remote', '--heads', '--', url, `refs/heads/${branch}`], undefined, 120000).trim() !== '';
  }

  push(url: string, commit: string, branch: string): void {
    this.run(pushArguments(url, commit, branch), undefined, 600000);
  }
}
