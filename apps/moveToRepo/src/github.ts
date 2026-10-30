import { runTool } from '@moveToRepo/tools';

export type Repository = { owner: string; name: string };
export type RepositoryInfo = { fullName: string; defaultBranch: string };

const owner = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const name = '[A-Za-z0-9._-]{1,100}';
const httpsUrl = new RegExp(`^https://github\\.com/(${owner})/(${name})/?$`);
const sshUrl = new RegExp(`^git@github\\.com:(${owner})/(${name})$`);
const fullName = new RegExp(`^(${owner})/(${name})$`);
const writePermissions = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** Accept only a github.com repository address: https://github.com/OWNER/REPO or git@github.com:OWNER/REPO.git. */
export function parseRepository(value: string): Repository {
  const match = httpsUrl.exec(value) ?? sshUrl.exec(value);
  const repoOwner = match?.[1];
  let repoName = match?.[2];
  if (repoName?.endsWith('.git')) repoName = repoName.slice(0, -4);
  if (!repoOwner || !repoName || repoName === '.' || repoName === '..' || repoName.endsWith('.git')) {
    throw new Error('--repo: нужен адрес репозитория GitHub: https://github.com/OWNER/REPO или git@github.com:OWNER/REPO.git');
  }
  return { owner: repoOwner, name: repoName };
}

/** The clone and push address. It is built from checked parts, never copied from the argument. */
export function cloneUrl(repo: Repository): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

/** Check a branch name more strictly than Git: ASCII letters, digits, and `. _ / -`, without empty or dot segments. */
export function checkBranch(value: string, label: string): string {
  const valid =
    /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(value) &&
    value !== 'HEAD' &&
    !value.includes('..') &&
    value.split('/').every((segment) => segment !== '' && !segment.startsWith('.') && !segment.startsWith('-') && !segment.endsWith('.') && !segment.endsWith('.lock'));
  if (!valid) throw new Error(`${label}: недопустимое имя ветки: ${value}`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Parse `gh repo view` JSON. Require write access and an active repository with the same name. */
export function parseRepositoryInfo(json: string, repo: Repository): RepositoryInfo {
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(json));
  } catch {
    throw new Error('gh вернул некорректный ответ.');
  }
  const actual = typeof data.nameWithOwner === 'string' ? data.nameWithOwner : '';
  const expected = `${repo.owner}/${repo.name}`;
  if (!fullName.test(actual)) throw new Error('gh вернул некорректное имя репозитория.');
  // GitHub redirects a renamed or moved repository. Stop, so the user confirms the new target.
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`Репозиторий ${expected} переименован или перенесён в ${actual}. Укажите новый адрес.`);
  if (data.isArchived === true) throw new Error(`Репозиторий ${actual} в архиве. Запись невозможна.`);
  if (typeof data.viewerPermission !== 'string' || !writePermissions.has(data.viewerPermission)) throw new Error(`Нет прав на запись в ${actual}.`);
  const defaultBranch = record(data.defaultBranchRef).name;
  return { fullName: actual, defaultBranch: typeof defaultBranch === 'string' ? checkBranch(defaultBranch, 'Ветка по умолчанию') : '' };
}

export class GitHub {
  constructor(
    readonly gh: string,
    readonly cwd: string
  ) {}

  /** Read the repository through the authenticated gh. This also checks that gh is signed in. */
  repository(repo: Repository): RepositoryInfo {
    const json = runTool(this.gh, ['repo', 'view', `${repo.owner}/${repo.name}`, '--json', 'nameWithOwner,viewerPermission,isArchived,defaultBranchRef'], { cwd: this.cwd, timeout: 60000 }, 'gh');
    return parseRepositoryInfo(json.toString('utf8'), repo);
  }

  /** Open a pull request from a branch in the same repository. The body goes through stdin. Return the PR URL. */
  createPullRequest(info: RepositoryInfo, base: string, head: string, title: string, body: string): string {
    const output = runTool(
      this.gh,
      ['pr', 'create', '--repo', info.fullName, '--base', base, '--head', head, '--title', title, '--body-file', '-'],
      { cwd: this.cwd, input: body, timeout: 120000 },
      'gh'
    ).toString('utf8');
    const url = output
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(`https://github.com/${info.fullName}/pull/`));
    if (!url || !/\/pull\/\d+$/.test(url)) throw new Error('gh не вернул адрес pull request.');
    return url;
  }
}

/** The page where the user can open the pull request manually. */
export function compareUrl(info: RepositoryInfo, base: string, head: string): string {
  return `https://github.com/${info.fullName}/compare/${base}...${head}?expand=1`;
}
