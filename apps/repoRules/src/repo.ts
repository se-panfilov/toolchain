import { ApiError, type GitHubClient, repoPath, type RepoRef } from '@repoRules/github';
import { bool, num, rec, str } from '@repoRules/state';

const ownerPattern = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const namePattern = '[A-Za-z0-9._-]{1,100}';
const shortForm = new RegExp(`^(${ownerPattern})/(${namePattern})$`);
const httpsForm = new RegExp(`^https://(?:www\\.)?github\\.com/(${ownerPattern})/(${namePattern})/?$`);
const sshForm = new RegExp(`^git@github\\.com:(${ownerPattern})/(${namePattern})$`);

/** Parse `owner/repo`, `https://github.com/owner/repo[.git]`, or `git@github.com:owner/repo.git`. Other hosts are rejected. */
export function parseRepo(input: string): RepoRef {
  const value = input.trim();
  const match = shortForm.exec(value) ?? httpsForm.exec(value) ?? sshForm.exec(value);
  const owner = match?.[1];
  let name = match?.[2];
  if (name?.endsWith('.git')) name = name.slice(0, -4);
  if (!owner || !name || name === '.' || name === '..' || name.endsWith('.git') || owner.endsWith('-') || owner.includes('--')) {
    throw new Error('Нужен репозиторий GitHub: owner/repo или https://github.com/owner/repo');
  }
  return { owner, name };
}

export function sameRef(a: RepoRef, b: RepoRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

export type Permissions = { admin: boolean; maintain: boolean; push: boolean; triage: boolean; pull: boolean };

export type RepoInfo = RepoRef & {
  fullName: string;
  id: number;
  ownerType: 'User' | 'Organization';
  private: boolean;
  visibility: string;
  archived: boolean;
  defaultBranch: string;
  permissions: Permissions | undefined;
  /** The full GET /repos response. Settings categories read their values from it. */
  raw: Record<string, unknown>;
};

/** Read repository data and check that GitHub returned the requested repository, not a renamed or moved one. */
export async function loadRepo(client: GitHubClient, ref: RepoRef): Promise<RepoInfo> {
  let data: Record<string, unknown>;
  try {
    data = rec(await client.get(repoPath(ref)));
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'not-found') throw new Error(`Репозиторий ${ref.owner}/${ref.name} не найден или нет доступа.`, { cause: error });
    if (error instanceof ApiError && error.kind === 'redirect') throw new Error(`Репозиторий ${ref.owner}/${ref.name} переименован или перенесён. Укажите новое имя.`, { cause: error });
    throw error;
  }
  const owner = rec(data.owner);
  const fullName = str(data.full_name) ?? '';
  const id = num(data.id);
  const login = str(owner.login);
  const name = str(data.name);
  const ownerType = str(owner.type);
  const defaultBranch = str(data.default_branch) ?? '';
  if (!id || !login || !name || fullName.toLowerCase() !== `${ref.owner}/${ref.name}`.toLowerCase()) {
    throw new Error(`GitHub вернул другой репозиторий вместо ${ref.owner}/${ref.name}. Укажите актуальное имя.`);
  }
  if (ownerType !== 'User' && ownerType !== 'Organization') throw new Error(`Неподдерживаемый тип владельца репозитория ${fullName}.`);
  const perms = rec(data.permissions);
  const permissions =
    data.permissions === undefined
      ? undefined
      : { admin: perms.admin === true, maintain: perms.maintain === true, push: perms.push === true, triage: perms.triage === true, pull: perms.pull === true };
  return {
    owner: login,
    name,
    fullName,
    id,
    ownerType,
    private: bool(data.private) ?? true,
    visibility: str(data.visibility) ?? 'unknown',
    archived: data.archived === true,
    defaultBranch,
    permissions,
    raw: data
  };
}

/** Check the repository pair before discovery. Return warnings; throw when the run cannot continue safely. */
export function checkPair(source: RepoInfo, target: RepoInfo): string[] {
  if (source.id === target.id || sameRef(source, target)) throw new Error('Источник и цель — один и тот же репозиторий.');
  if (!source.permissions?.pull) throw new Error(`Нет доступа на чтение к ${source.fullName}.`);
  if (target.archived) throw new Error(`Целевой репозиторий ${target.fullName} в архиве. Изменения невозможны.`);
  if (!target.permissions?.push) throw new Error(`Нет прав на запись в ${target.fullName}.`);
  const warnings: string[] = [];
  if (!target.permissions.admin) warnings.push(`Нет прав администратора в ${target.fullName}. Большинство категорий будут недоступны для изменения.`);
  if (!source.permissions.admin) warnings.push(`Нет прав администратора в ${source.fullName}. Часть настроек источника будет показана как «Недостаточно прав».`);
  return warnings;
}
