import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { askRepo, targetSuggestion } from '@reRules/cli';
import { findGitDir, githubRef, localRepo, remoteUrls } from '@reRules/local';
import { Ui } from '@reRules/ui';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { Buffered, ScriptedAsker } from './helpers.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rerules-local-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gitRepo(dir: string, config: string): string {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), config);
  return dir;
}

const origin = (url: string, name = 'origin'): string => `[core]\n\tbare = false\n[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`;

describe('remote URLs', () => {
  test.each([
    ['https://github.com/me/project.git', 'me', 'project'],
    ['https://GitHub.com/me/project', 'me', 'project'],
    ['https://github.com:443/me/project.git', 'me', 'project'],
    ['git@github.com:me/project.git', 'me', 'project'],
    ['ssh://git@github.com/me/project.git', 'me', 'project'],
    ['ssh://git@github.com:22/me/project', 'me', 'project']
  ])('%s is %s/%s', (url, owner, name) => {
    expect(githubRef(url)).toEqual({ owner, name });
  });

  test('a token in the URL is removed', () => {
    const ref = githubRef('https://x-access-token:ghp_secretvalue@github.com/me/project.git');
    expect(ref).toEqual({ owner: 'me', name: 'project' });
    expect(JSON.stringify(ref)).not.toContain('secret');
  });

  test.each([
    'https://gitlab.com/me/project.git',
    'https://github.com.evil.example/me/project',
    'https://github.com:8443/me/project',
    'https://github.com/me/project?ref=x',
    'http://github.com/me/project',
    'ssh://git@example.com/me/project',
    'git@gitlab.com:me/project.git',
    'team/project',
    '../project.git',
    '/srv/git/project.git',
    'file:///srv/git/me/project'
  ])('%s is not a GitHub repository', (url) => {
    expect(githubRef(url)).toBeUndefined();
  });

  test('the first url of each remote is read, other sections are ignored', () => {
    const config = '[remote "origin"]\n url = "git@github.com:me/a.git"\n url = git@github.com:me/b.git\n[branch "main"]\n url = git@github.com:me/c.git\n[remote "up"]\nURL=https://github.com/me/d\n';
    expect([...remoteUrls(config)]).toEqual([
      ['origin', 'git@github.com:me/a.git'],
      ['up', 'https://github.com/me/d']
    ]);
  });
});

describe('local repository', () => {
  test('origin is found from a subdirectory', () => {
    gitRepo(root, origin('https://github.com/me/project.git') + origin('git@github.com:other/fork.git', 'fork'));
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(localRepo(deep)).toEqual({ ref: { owner: 'me', name: 'project' }, remote: 'origin' });
  });

  test('without origin, the only GitHub remote is used', () => {
    gitRepo(root, origin('git@github.com:me/project.git', 'upstream') + origin('https://gitlab.com/me/project', 'mirror'));
    expect(localRepo(root)?.ref).toEqual({ owner: 'me', name: 'project' });
  });

  test('without origin and with two GitHub remotes, there is no guess', () => {
    gitRepo(root, origin('git@github.com:me/a.git', 'one') + origin('git@github.com:me/b.git', 'two'));
    expect(localRepo(root)).toBeUndefined();
  });

  test('a directory outside Git or without a GitHub remote gives no repository', () => {
    expect(localRepo(root)).toBeUndefined();
    gitRepo(root, origin('https://gitlab.com/me/project.git'));
    expect(localRepo(root)).toBeUndefined();
  });

  test('a linked worktree reads the shared configuration through commondir', () => {
    const main = gitRepo(join(root, 'main'), origin('git@github.com:me/project.git'));
    const worktreeGit = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(worktreeGit, { recursive: true });
    writeFileSync(join(worktreeGit, 'commondir'), '../..\n');
    const worktree = join(root, 'wt');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGit}\n`);
    expect(findGitDir(worktree)).toBe(worktreeGit);
    expect(localRepo(worktree)?.ref).toEqual({ owner: 'me', name: 'project' });
  });

  test('a relative gitdir in a .git file is resolved from its directory', () => {
    gitRepo(join(root, 'store'), origin('git@github.com:me/sub.git'));
    const work = join(root, 'work');
    mkdirSync(work);
    writeFileSync(join(work, '.git'), 'gitdir: ../store/.git\n');
    expect(localRepo(work)?.ref).toEqual({ owner: 'me', name: 'sub' });
  });

  test('a linked .git entry stops the search instead of using a parent repository', () => {
    gitRepo(root, origin('git@github.com:me/parent.git'));
    const child = join(root, 'child');
    mkdirSync(join(root, 'real'));
    mkdirSync(child);
    symlinkSync(join(root, 'real'), join(child, '.git'));
    expect(localRepo(child)).toBeUndefined();
  });

  test('a linked or large configuration file is not read', () => {
    const elsewhere = join(root, 'elsewhere');
    writeFileSync(elsewhere, origin('git@github.com:me/linked.git'));
    mkdirSync(join(root, 'linked', '.git'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'linked', '.git', 'config'));
    expect(localRepo(join(root, 'linked'))).toBeUndefined();

    gitRepo(join(root, 'large'), origin('git@github.com:me/large.git') + '#'.repeat(1024 * 1024));
    expect(localRepo(join(root, 'large'))).toBeUndefined();
  });
});

describe('target question', () => {
  const local = { ref: { owner: 'me', name: 'project' }, remote: 'origin' };

  test('the local repository is the editable default of the target question', async () => {
    const ask = new ScriptedAsker(['me/project']);
    const suggestion = targetSuggestion({ owner: 'me', name: 'template' }, local);
    expect(await askRepo(ask, new Ui(new Buffered()), 'Целевой репозиторий (owner/repo)', undefined, suggestion)).toBe('me/project');
    expect(ask.initials).toEqual(['me/project']);
  });

  test('no default when the local repository is the source or is unknown', () => {
    expect(targetSuggestion({ owner: 'Me', name: 'Project' }, local)).toBe('');
    expect(targetSuggestion({ owner: 'me', name: 'template' }, undefined)).toBe('');
  });

  test('a valid --target value is used without a question', async () => {
    const ask = new ScriptedAsker([]);
    expect(await askRepo(ask, new Ui(new Buffered()), 'Целевой репозиторий (owner/repo)', 'me/other', 'me/project')).toBe('me/other');
    expect(ask.questions).toEqual([]);
  });

  test('an invalid --target value is shown for correction instead of the default', async () => {
    const ask = new ScriptedAsker(['me/fixed']);
    expect(await askRepo(ask, new Ui(new Buffered()), 'Целевой репозиторий (owner/repo)', 'bad', 'me/project')).toBe('me/fixed');
    expect(ask.initials).toEqual(['bad']);
  });
});
