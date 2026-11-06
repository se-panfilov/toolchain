import { askConflict } from '@repoRules/flow';
import { ApiError, apiPath, type GitHubClient, repoPath } from '@repoRules/github';
import { category, type Context, type PlanItem, Stage } from '@repoRules/plan';
import type { RepoInfo } from '@repoRules/repo';
import { attempt, num, type Read, rec, str } from '@repoRules/state';

const title = 'CODEOWNERS';

/** GitHub uses the first file that it finds in this order. */
export const codeownersPaths = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
const maxBytes = 1024 * 1024;

export type CodeownersFile = { path: string; sha: string; content: Buffer };
export type CodeownersData = { source: Read<CodeownersFile | undefined>; target: Read<CodeownersFile | undefined>; problems: string[] };

/** Read one file through the Contents API. Only a regular file is accepted, not a link, a directory, or a submodule. */
export async function readFile(client: GitHubClient, repo: RepoInfo, path: string): Promise<CodeownersFile | undefined> {
  const data = await client.getOptional(repoPath(repo, 'contents', ...path.split('/')), { ref: repo.defaultBranch });
  if (data === undefined) return undefined;
  const file = rec(data);
  if (file.type !== 'file') throw new ApiError('invalid-response', 200, `${path} не является обычным файлом.`);
  const size = num(file.size) ?? 0;
  if (size > maxBytes) throw new ApiError('invalid-response', 200, `${path} больше 1 МБ.`);
  const sha = str(file.sha);
  const content = str(file.content);
  if (!sha || content === undefined || file.encoding !== 'base64') throw new ApiError('invalid-response', 200, `Нет содержимого ${path} в ответе API.`);
  const bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
  if (bytes.length !== size) throw new ApiError('invalid-response', 200, `Размер ${path} не совпадает с ответом API.`);
  return { path, sha, content: bytes };
}

/** Find the effective CODEOWNERS file by the GitHub location order. */
export async function findCodeowners(client: GitHubClient, repo: RepoInfo): Promise<CodeownersFile | undefined> {
  for (const path of codeownersPaths) {
    const file = await readFile(client, repo, path);
    if (file) return file;
  }
  return undefined;
}

/** Owners in CODEOWNERS lines: @user, @org/team, or e-mail addresses. Comments and patterns are ignored. */
export function parseOwners(text: string): string[] {
  const owners = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/(^|\s)#.*$/, '').trim();
    if (!content) continue;
    const [, ...rest] = content.split(/\s+/);
    for (const token of rest) if (token.startsWith('@') || /^[^@\s]+@[^@\s]+$/.test(token)) owners.add(token);
  }
  return [...owners];
}

/** Check owners against the target repository. Each problem is a warning; nothing is changed. */
export async function checkOwners(client: GitHubClient, target: RepoInfo, owners: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const owner of owners.slice(0, 50)) {
    if (!owner.startsWith('@')) {
      problems.push(`${owner}: адрес почты не проверяется; у владельца должен быть доступ к цели.`);
      continue;
    }
    const name = owner.slice(1);
    const team = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(name);
    try {
      if (team?.[1] && team[2]) {
        if (team[1].toLowerCase() !== target.owner.toLowerCase()) {
          problems.push(`${owner}: команда другой организации, в цели не действует.`);
          continue;
        }
        const status = await client.status(apiPath('orgs', team[1], 'teams', team[2], 'repos', target.owner, target.name));
        if (status === 404) problems.push(`${owner}: команда не найдена или не имеет доступа к цели.`);
      } else if (/^[A-Za-z0-9-]{1,39}$/.test(name)) {
        const status = await client.status(repoPath(target, 'collaborators', name));
        if (status === 404 && name.toLowerCase() !== target.owner.toLowerCase()) problems.push(`${owner}: не соавтор целевого репозитория.`);
      } else problems.push(`${owner}: некорректное имя владельца.`);
    } catch (error) {
      problems.push(`${owner}: проверка не выполнена (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  if (owners.length > 50) problems.push(`Проверены первые 50 владельцев из ${owners.length}.`);
  return problems;
}

export async function discoverCodeowners(ctx: Context): Promise<CodeownersData> {
  const source = await attempt(() => findCodeowners(ctx.client, ctx.source));
  const target = await attempt(() => findCodeowners(ctx.client, ctx.target));
  const problems = source.ok && source.value ? await checkOwners(ctx.client, ctx.target, parseOwners(source.value.content.toString('utf8'))) : [];
  return { source, target, problems };
}

function preview(content: Buffer, lines = 40): string {
  const text = content.toString('utf8').split(/\r?\n/);
  return text.length > lines ? `${text.slice(0, lines).join('\n')}\n… ещё ${text.length - lines} строк` : text.join('\n');
}

export const codeownersCategory = category<CodeownersData>({
  id: 'codeowners',
  title,
  discover: discoverCodeowners,
  empty(data) {
    return data.source.ok && !data.source.value ? 'В источнике нет файла CODEOWNERS.' : undefined;
  },
  present(data, ctx) {
    const { ui } = ctx;
    if (!data.source.ok) {
      ui.warn(`CODEOWNERS источника: ${data.source.detail}`);
      return;
    }
    if (!data.source.value) return;
    ui.section(`Источник: ${data.source.value.path} (${ctx.source.defaultBranch})`);
    ui.text(preview(data.source.value.content), 4);
    if (!data.target.ok) ui.warn(`Цель: ${data.target.detail}`);
    else ui.info(data.target.value ? `В цели есть ${data.target.value.path}.` : 'В цели нет CODEOWNERS.');
    for (const problem of data.problems) ui.warn(problem);
    ui.info('Копирование CODEOWNERS не включает обязательное ревью владельцев кода: это настраивается в правилах или защите веток.');
  },
  async plan(data, ctx) {
    const source = data.source.ok ? data.source.value : undefined;
    if (!data.source.ok) return [{ category: title, kind: 'warn', title: `CODEOWNERS не прочитан: ${data.source.detail}`, stage: Stage.files }];
    if (!source) return [];
    if (!data.target.ok) return [{ category: title, kind: 'warn', title: `CODEOWNERS цели не прочитан: ${data.target.detail}`, stage: Stage.files }];
    const target = data.target.value;
    if (target?.content.equals(source.content)) return [{ category: title, kind: 'keep', title: `CODEOWNERS уже совпадает (${target.path}), запись не нужна`, stage: Stage.files }];
    const branch = ctx.target.defaultBranch;
    if (target) {
      const answer = await askConflict(ctx, `В цели уже есть ${target.path} с другим содержимым. Что сделать?`, { replace: 'Заменить содержимым источника' });
      if (answer !== 'replace') return [{ category: title, kind: answer === 'skip' ? 'skip' : 'keep', title: 'CODEOWNERS оставлен как в цели', stage: Stage.files }];
    } else if (!(await ctx.ask.confirm(`Скопировать CODEOWNERS в ${source.path} цели?`, true))) {
      return [{ category: title, kind: 'skip', title: 'CODEOWNERS пропущен', stage: Stage.files }];
    }
    // Write to the effective target location, so the file is the one that GitHub uses.
    const path = target?.path ?? source.path;
    const item: PlanItem = {
      category: title,
      kind: target ? 'update' : 'create',
      title: `${target ? 'Заменить' : 'Создать'} ${path} в ветке ${branch}`,
      details: ['Коммит напрямую в ветку по умолчанию через Contents API. Содержимое копируется байт в байт.', ...data.problems],
      risk: target ? 'перезапись файла конфигурации' : 'коммит в ветку по умолчанию',
      stage: Stage.files,
      apply: async (client) => {
        const body: Record<string, unknown> = { message: `${target ? 'Update' : 'Add'} ${path}`, content: source.content.toString('base64'), branch };
        // The sha makes the write fail when the file changed after discovery.
        if (target) body.sha = target.sha;
        await client.mutate('PUT', repoPath(ctx.target, 'contents', ...path.split('/')), body);
      }
    };
    return [item];
  }
});
