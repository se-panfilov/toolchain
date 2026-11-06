import { askConflict, askTransfer, pick } from '@reRules/flow';
import { type GitHubClient, repoPath } from '@reRules/github';
import { category, type Context, type PlanItem, Stage } from '@reRules/plan';
import type { RepoInfo } from '@reRules/repo';
import { attempt, type Read, rec, str } from '@reRules/state';
import { clip } from '@reRules/ui';

const title = 'Переменные Actions';

export type Variable = { scope: string | undefined; name: string; value: string };
export type VariablesData = { source: Read<Variable[]>; target: Read<Variable[]>; failedScopes: string[] };

/** Variable names: letters, digits, and `_`, not starting with a digit or GITHUB_. */
export function validVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name) && !name.toUpperCase().startsWith('GITHUB_');
}

function basePath(scope: string | undefined): string[] {
  return scope === undefined ? ['actions', 'variables'] : ['environments', scope, 'variables'];
}

async function readScope(client: GitHubClient, repo: RepoInfo, scope: string | undefined): Promise<Variable[]> {
  return (await client.paginate(repoPath(repo, ...basePath(scope)), { per_page: 30 }, 'variables')).map((item) => ({
    scope,
    name: str(rec(item).name) ?? '',
    value: str(rec(item).value) ?? ''
  }));
}

async function environmentNames(client: GitHubClient, repo: RepoInfo): Promise<string[]> {
  return (await client.paginate(repoPath(repo, 'environments'), {}, 'environments')).flatMap((item) => str(rec(item).name) ?? []);
}

async function readAll(client: GitHubClient, repo: RepoInfo, failed: string[]): Promise<Variable[]> {
  const out = await readScope(client, repo, undefined);
  const envs = await attempt(() => environmentNames(client, repo));
  if (!envs.ok) failed.push(`${repo.fullName}: окружения (${envs.detail})`);
  for (const env of envs.ok ? envs.value : []) {
    const scoped = await attempt(() => readScope(client, repo, env));
    if (scoped.ok) out.push(...scoped.value);
    else failed.push(`${repo.fullName}: окружение ${env} (${scoped.detail})`);
  }
  return out;
}

export async function discoverVariables(ctx: Context): Promise<VariablesData> {
  const failedScopes: string[] = [];
  const source = await attempt(() => readAll(ctx.client, ctx.source, failedScopes));
  const target = await attempt(() => readAll(ctx.client, ctx.target, failedScopes));
  return { source, target, failedScopes };
}

export function variableLabel(variable: Pick<Variable, 'scope' | 'name'>): string {
  return variable.scope === undefined ? variable.name : `${variable.scope} / ${variable.name}`;
}

export const variablesCategory = category<VariablesData>({
  id: 'variables',
  title,
  discover: discoverVariables,
  empty(data) {
    return data.source.ok && data.source.value.length === 0 && data.failedScopes.length === 0 ? 'В источнике нет переменных.' : undefined;
  },
  present(data, ctx) {
    if (!data.source.ok) {
      ctx.ui.warn(`Переменные источника: ${data.source.detail}`);
      return;
    }
    ctx.ui.section('Переменные источника (репозиторий / окружение):');
    ctx.ui.rows(data.source.value.map((variable) => [variableLabel(variable), clip(variable.value)] as const));
    for (const scope of data.failedScopes) ctx.ui.warn(`Не прочитано: ${scope}`);
    ctx.ui.info('Переменные организации не переносятся.');
  },
  async plan(data, ctx) {
    if (!data.source.ok) return [{ category: title, kind: 'warn', title: `Переменные не прочитаны: ${data.source.detail}`, stage: Stage.variables }];
    if (!data.target.ok) return [{ category: title, kind: 'warn', title: `Переменные цели не прочитаны: ${data.target.detail}`, stage: Stage.variables }];
    const targetVars = data.target.value;
    const find = (variable: Variable): Variable | undefined => targetVars.find((item) => item.scope === variable.scope && item.name.toUpperCase() === variable.name.toUpperCase());
    const items: PlanItem[] = [];
    const candidates = data.source.value.filter((variable) => {
      if (!validVariableName(variable.name)) {
        items.push({ category: title, kind: 'warn', title: `${variableLabel(variable)}: недопустимое имя`, stage: Stage.variables });
        return false;
      }
      if (variable.scope !== undefined && !ctx.targetEnvironments.has(variable.scope)) {
        items.push({ category: title, kind: 'warn', title: `${variableLabel(variable)}: окружения ${variable.scope} нет в цели и в плане`, stage: Stage.variables });
        return false;
      }
      if (find(variable)?.value === variable.value) {
        items.push({ category: title, kind: 'keep', title: `${variableLabel(variable)} уже совпадает`, stage: Stage.variables });
        return false;
      }
      return true;
    });
    if (!candidates.length) return items;
    const mode = await askTransfer(ctx, 'Перенести переменные?');
    if (mode === 'skip') return [...items, { category: title, kind: 'skip', title: 'Переменные пропущены', stage: Stage.variables }];
    const chosen = await pick(ctx, mode, 'Какие переменные перенести?', candidates, (variable) => `${variableLabel(variable)}${find(variable) ? ' (есть в цели)' : ''}`);
    for (const variable of chosen) {
      const existing = find(variable);
      const path = basePath(variable.scope);
      if (existing) {
        ctx.ui.warn(`${variableLabel(variable)}: в цели «${clip(existing.value, 80)}», в источнике «${clip(variable.value, 80)}».`);
        const answer = await askConflict(ctx, `Перезаписать ${variableLabel(variable)} в цели?`);
        if (answer !== 'replace') {
          items.push({ category: title, kind: answer === 'skip' ? 'skip' : 'keep', title: `${variableLabel(variable)} оставлена как в цели`, stage: Stage.variables });
          continue;
        }
        items.push({
          category: title,
          kind: 'update',
          title: `Перезаписать переменную ${variableLabel(variable)}`,
          risk: 'перезапись значения переменной',
          stage: Stage.variables,
          apply: async (client) => {
            await client.mutate('PATCH', repoPath(ctx.target, ...path, existing.name), { name: existing.name, value: variable.value });
          }
        });
        continue;
      }
      items.push({
        category: title,
        kind: 'create',
        title: `Создать переменную ${variableLabel(variable)}`,
        stage: Stage.variables,
        apply: async (client) => {
          await client.mutate('POST', repoPath(ctx.target, ...path), { name: variable.name, value: variable.value });
        }
      });
    }
    return items;
  }
});
