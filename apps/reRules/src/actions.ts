import { askTransfer, pick } from '@reRules/flow';
import { repoPath } from '@reRules/github';
import { category, type Context, type PlanItem, Stage } from '@reRules/plan';
import type { RepoInfo } from '@reRules/repo';
import { attempt, missing, type Read, rec, sameJson, stateLabel } from '@reRules/state';
import { plain } from '@reRules/ui';

const title = 'GitHub Actions';

type Side = {
  permissions: Read<Record<string, unknown>>;
  selected: Read<Record<string, unknown>> | undefined;
  workflow: Read<Record<string, unknown>>;
  access: Read<Record<string, unknown>> | undefined;
};
export type ActionsData = { source: Side; target: Side };

const permissionKeys = ['enabled', 'allowed_actions', 'sha_pinning_required'];
const selectedKeys = ['github_owned_allowed', 'verified_allowed', 'patterns_allowed'];
const workflowKeys = ['default_workflow_permissions', 'can_approve_pull_request_reviews'];

/** Keep only the writable keys that GitHub returned. Unknown keys are not invented. */
export function pickKeys(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (data[key] !== undefined) out[key] = data[key];
  return out;
}

async function side(ctx: Context, repo: RepoInfo): Promise<Side> {
  const { client } = ctx;
  const permissions = await attempt(async () => pickKeys(rec(await client.get(repoPath(repo, 'actions', 'permissions'))), permissionKeys));
  const selected =
    permissions.ok && permissions.value.allowed_actions === 'selected'
      ? await attempt(async () => pickKeys(rec(await client.get(repoPath(repo, 'actions', 'permissions', 'selected-actions'))), selectedKeys))
      : undefined;
  const workflow = await attempt(async () => pickKeys(rec(await client.get(repoPath(repo, 'actions', 'permissions', 'workflow'))), workflowKeys));
  // Access from other repositories applies only to private and internal repositories.
  const access = repo.private ? await attempt(async () => pickKeys(rec(await client.get(repoPath(repo, 'actions', 'permissions', 'access'))), ['access_level'])) : undefined;
  return { permissions, selected, workflow, access };
}

export async function discoverActions(ctx: Context): Promise<ActionsData> {
  return { source: await side(ctx, ctx.source), target: await side(ctx, ctx.target) };
}

function show(read: Read<Record<string, unknown>> | undefined): string {
  if (!read) return 'Не применяется';
  if (!read.ok) return stateLabel(read.state);
  return Object.entries(read.value)
    .map(([key, value]) => `${key}=${plain(value)}`)
    .join(', ');
}

type Part = { id: string; label: string; source: Read<Record<string, unknown>> | undefined; target: Read<Record<string, unknown>> | undefined; path: string[] };

function parts(data: ActionsData): Part[] {
  return [
    { id: 'permissions', label: 'Политика Actions (включение, разрешённые actions)', source: data.source.permissions, target: data.target.permissions, path: ['actions', 'permissions'] },
    { id: 'selected', label: 'Список разрешённых actions и reusable workflows', source: data.source.selected, target: data.target.selected, path: ['actions', 'permissions', 'selected-actions'] },
    { id: 'workflow', label: 'Права GITHUB_TOKEN по умолчанию и одобрение PR', source: data.source.workflow, target: data.target.workflow, path: ['actions', 'permissions', 'workflow'] },
    {
      id: 'access',
      label: 'Доступ workflow из других репозиториев',
      source: data.source.access,
      target: data.target.access ?? missing('unsupported', 'цель не является закрытым репозиторием'),
      path: ['actions', 'permissions', 'access']
    }
  ];
}

export const actionsCategory = category<ActionsData>({
  id: 'actions',
  title,
  discover: discoverActions,
  present(data, ctx) {
    ctx.ui.section('Источник (в скобках — цель):');
    ctx.ui.rows(parts(data).map((part) => [part.label, `${show(part.source)}   [цель: ${show(part.target)}]`] as const));
    ctx.ui.info('Политика организации может запрещать значения уровня репозитория; тогда GitHub отклонит изменение (HTTP 409).');
    ctx.ui.info('Файлы workflow не копируются: они приходят из шаблона.');
  },
  async plan(data, ctx) {
    const items: PlanItem[] = [];
    const candidates = parts(data).filter((part) => {
      if (!part.source) return false;
      if (!part.source.ok) {
        items.push({ category: title, kind: 'warn', title: `${part.label}: ${stateLabel(part.source.state)}`, stage: Stage.actions });
        return false;
      }
      if (part.target && !part.target.ok && part.id === 'access') {
        items.push({ category: title, kind: 'warn', title: `${part.label}: ${part.target.detail || stateLabel(part.target.state)}`, stage: Stage.actions });
        return false;
      }
      return !(part.target?.ok && sameJson(part.target.value, part.source.value));
    });
    if (!candidates.length) {
      ctx.ui.info('Отличий нет.');
      return items;
    }
    const mode = await askTransfer(ctx, 'Перенести настройки Actions?', { json: candidates.map((part) => ({ [part.id]: part.source?.ok ? part.source.value : null })) });
    if (mode === 'skip') return [...items, { category: title, kind: 'skip', title: 'Настройки Actions пропущены', stage: Stage.actions }];
    const chosen = await pick(ctx, mode, 'Какие настройки Actions перенести?', candidates, (part) => part.label);
    for (const part of chosen) {
      if (!part.source?.ok) continue;
      const body = part.source.value;
      items.push({
        category: title,
        kind: 'update',
        title: part.label,
        details: [show(part.source)],
        risk: 'изменение прав GitHub Actions',
        stage: Stage.actions,
        apply: async (client) => {
          await client.mutate('PUT', repoPath(ctx.target, ...part.path), body);
        }
      });
    }
    return items;
  }
});
