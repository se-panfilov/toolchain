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

/** Parse `gh api user` JSON and return the login of the signed-in GitHub user. */
export function parseUser(json: string): string {
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(json));
  } catch {
    throw new Error('gh вернул некорректный ответ.');
  }
  const login = typeof data.login === 'string' ? data.login : '';
  if (!new RegExp(`^${owner}$`).test(login)) throw new Error('gh вернул некорректное имя пользователя.');
  return login;
}

/**
 * Permit only a repository of the signed-in GitHub user. Organization repositories and repositories of other users
 * stop the run, also with write access. This prevents a transfer of files to a repository that another person controls.
 * GitHub logins are not case sensitive.
 */
export function checkOwner(info: RepositoryInfo, login: string): void {
  const repoOwner = info.fullName.split('/')[0] ?? '';
  if (repoOwner.toLowerCase() !== login.toLowerCase()) {
    throw new Error(`Репозиторий ${info.fullName} принадлежит ${repoOwner}, а не текущему пользователю GitHub ${login}. Копировать можно только в свои репозитории.`);
  }
}

/**
 * The gh commands that the program can start: read the repository, read the user, and open a pull request.
 * No other command can start, so the program cannot complete a pull request, review it, or change repository settings.
 * `api user` takes no other arguments, so it only reads. `pr create` takes only the listed options, each with a value.
 */
const prCreateOptions = new Set(['--repo', '--base', '--head', '--title', '--body-file']);
const ghCommands: Record<string, (args: string[]) => boolean> = {
  'repo view': (args) => args.length === 5 && args[3] === '--json',
  'api user': (args) => args.length === 2,
  'pr create': (args) => args.length % 2 === 0 && args.slice(2).every((arg, index) => index % 2 === 1 || prCreateOptions.has(arg))
};

/** Stop before gh starts when the arguments are not one of the permitted commands. */
export function checkGhCommand(args: string[]): void {
  const check = ghCommands[`${args[0] ?? ''} ${args[1] ?? ''}`];
  if (!check?.(args)) throw new Error(`Недопустимая команда gh: ${args.slice(0, 2).join(' ')}`);
}

export class GitHub {
  constructor(
    readonly gh: string,
    readonly cwd: string
  ) {}

  private run(args: string[], options: { input?: string; timeout: number }): string {
    checkGhCommand(args);
    return runTool(this.gh, args, { cwd: this.cwd, ...options }, 'gh').toString('utf8');
  }

  /** Read the repository through the authenticated gh. This also checks that gh is signed in. */
  repository(repo: Repository): RepositoryInfo {
    const json = this.run(['repo', 'view', `${repo.owner}/${repo.name}`, '--json', 'nameWithOwner,viewerPermission,isArchived,defaultBranchRef'], { timeout: 60000 });
    return parseRepositoryInfo(json, repo);
  }

  /** The login of the GitHub user that gh uses. The push uses the same account through `gh auth git-credential`. */
  currentUser(): string {
    return parseUser(this.run(['api', 'user'], { timeout: 60000 }));
  }

  /**
   * Open a pull request from a branch in the same repository. The body goes through stdin. Return the PR URL.
   * The program never completes the pull request. Only a person can do that on GitHub.
   */
  createPullRequest(info: RepositoryInfo, base: string, head: string, title: string, body: string): string {
    const output = this.run(['pr', 'create', '--repo', info.fullName, '--base', base, '--head', head, '--title', title, '--body-file', '-'], { input: body, timeout: 120000 });
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
