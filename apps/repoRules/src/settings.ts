import { askConflict, askTransfer, pick } from '@repoRules/flow';
import { type GitHubClient, repoPath } from '@repoRules/github';
import { category, type Context, type PlanItem, Stage } from '@repoRules/plan';
import { attempt, type Read, sameJson, strings } from '@repoRules/state';
import { plain } from '@repoRules/ui';

const title = 'Настройки репозитория';

type Field = { id: string; label: string; keys: readonly string[]; orgOnly?: boolean };

/** Settings that PATCH /repos/{owner}/{repo} accepts. Paired keys are transferred together, because GitHub checks their combination. */
export const fields: readonly Field[] = [
  { id: 'description', label: 'Описание', keys: ['description'] },
  { id: 'homepage', label: 'Домашняя страница', keys: ['homepage'] },
  { id: 'has_issues', label: 'Issues', keys: ['has_issues'] },
  { id: 'has_projects', label: 'Projects', keys: ['has_projects'] },
  { id: 'has_wiki', label: 'Wiki', keys: ['has_wiki'] },
  { id: 'has_discussions', label: 'Discussions', keys: ['has_discussions'] },
  { id: 'allow_merge_commit', label: 'Merge-коммиты', keys: ['allow_merge_commit'] },
  { id: 'merge_commit', label: 'Заголовок и текст merge-коммита', keys: ['merge_commit_title', 'merge_commit_message'] },
  { id: 'allow_squash_merge', label: 'Squash merge', keys: ['allow_squash_merge'] },
  { id: 'squash_commit', label: 'Заголовок и текст squash-коммита', keys: ['squash_merge_commit_title', 'squash_merge_commit_message'] },
  { id: 'allow_rebase_merge', label: 'Rebase merge', keys: ['allow_rebase_merge'] },
  { id: 'allow_auto_merge', label: 'Автоматический merge PR', keys: ['allow_auto_merge'] },
  { id: 'delete_branch_on_merge', label: 'Удалять ветку после merge', keys: ['delete_branch_on_merge'] },
  { id: 'allow_update_branch', label: 'Предлагать обновить ветку PR', keys: ['allow_update_branch'] },
  { id: 'web_commit_signoff_required', label: 'Sign-off для веб-коммитов', keys: ['web_commit_signoff_required'] },
  { id: 'allow_forking', label: 'Разрешить форки (организация)', keys: ['allow_forking'], orgOnly: true }
];

type FieldState = { field: Field; source: Record<string, unknown> | undefined; target: Record<string, unknown> | undefined };

export type SettingsData = {
  fields: FieldState[];
  topics: { source: string[] | undefined; target: string[] | undefined };
  defaultBranch: { source: string; target: string; exists: Read<boolean> | undefined };
};

/** Take the values of all keys of a field, or undefined when GitHub did not return one of them. */
export function fieldValue(raw: Record<string, unknown>, field: Field): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of field.keys) {
    const value = raw[key];
    if (value === undefined || (value !== null && typeof value !== 'string' && typeof value !== 'boolean')) return undefined;
    out[key] = value;
  }
  return out;
}

function format(value: Record<string, unknown> | undefined): string {
  if (!value) return 'Неизвестно';
  return Object.values(value)
    .map((item) => plain(item))
    .join(' / ');
}

function topicsOf(raw: Record<string, unknown>): string[] | undefined {
  return Array.isArray(raw.topics) ? strings(raw.topics) : undefined;
}

export async function discoverSettings(ctx: Context): Promise<SettingsData> {
  const { source, target, client } = ctx;
  const state = fields.map((field) => ({ field, source: fieldValue(source.raw, field), target: fieldValue(target.raw, field) }));
  let exists: Read<boolean> | undefined;
  if (source.defaultBranch && source.defaultBranch !== target.defaultBranch) {
    exists = await attempt(async () => (await client.getOptional(repoPath(target, 'branches', source.defaultBranch))) !== undefined);
  }
  return {
    fields: state,
    topics: { source: topicsOf(source.raw), target: topicsOf(target.raw) },
    defaultBranch: { source: source.defaultBranch, target: target.defaultBranch, exists }
  };
}

function compare(source: string, target: string, same: boolean): string {
  return same ? `${source}   [совпадает]` : `${source}   [цель: ${target}]`;
}

export const settingsCategory = category<SettingsData>({
  id: 'settings',
  title,
  discover: discoverSettings,
  present(data, ctx) {
    const { ui } = ctx;
    ui.section('Источник (в скобках — цель):');
    ui.rows([
      ['Ветка по умолчанию', compare(data.defaultBranch.source, data.defaultBranch.target, data.defaultBranch.source === data.defaultBranch.target)],
      ...data.fields.map(({ field, source, target }) => [field.label, compare(format(source), format(target), Boolean(source) && sameJson(source, target))] as const),
      [
        'Темы (topics)',
        compare(data.topics.source?.join(', ') || '(нет)', data.topics.target?.join(', ') || '(нет)', sameJson([...(data.topics.source ?? [])].sort(), [...(data.topics.target ?? [])].sort()))
      ]
    ]);
    ui.info(`Не переносится: имя, владелец, адрес, видимость (${ctx.source.visibility}), признак шаблона, архивирование.`);
  },
  async plan(data, ctx) {
    const items: PlanItem[] = [];
    const differing = data.fields.filter(({ source, target }) => source && !sameJson(source, target));
    for (const { field, source } of data.fields)
      if (!source) items.push({ category: title, kind: 'warn', title: `${field.label}: значение источника неизвестно, не переносится`, stage: Stage.settings });
    const usable = differing.filter(({ field }) => {
      if (field.orgOnly && ctx.target.ownerType !== 'Organization') {
        items.push({ category: title, kind: 'warn', title: `${field.label}: только для репозиториев организаций`, stage: Stage.settings });
        return false;
      }
      return true;
    });
    const branch = data.defaultBranch;
    const branchChange = branch.exists?.ok === true && branch.exists.value;
    if (branch.exists && !branchChange) {
      items.push({ category: title, kind: 'warn', title: `Ветка по умолчанию ${branch.source}: нет такой ветки в цели, не меняется`, stage: Stage.defaultBranch });
    }
    const topicsDiffer = data.topics.source !== undefined && !sameJson([...data.topics.source].sort(), [...(data.topics.target ?? [])].sort());
    if (!usable.length && !branchChange && !topicsDiffer) {
      ctx.ui.info('Отличий нет.');
      return items;
    }
    const mode = await askTransfer(ctx, 'Перенести настройки репозитория?', { json: Object.fromEntries(data.fields.map(({ field, source }) => [field.id, source ?? null])) });
    if (mode === 'skip') return [...items, { category: title, kind: 'skip', title: 'Настройки репозитория пропущены', stage: Stage.settings }];
    type Option = { label: string; id: string };
    const options: Option[] = usable.map(({ field }) => ({ label: field.label, id: field.id }));
    if (topicsDiffer) options.push({ label: 'Темы (topics)', id: 'topics' });
    if (branchChange) options.push({ label: `Ветка по умолчанию → ${branch.source}`, id: 'default_branch' });
    const chosen = new Set((await pick(ctx, mode, 'Какие настройки перенести?', options, (option) => option.label)).map((option) => option.id));
    const body: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const { field, source } of usable) {
      if (!chosen.has(field.id) || !source) continue;
      Object.assign(body, source);
      changed.push(`${field.label}: ${format(source)}`);
    }
    if (changed.length) {
      items.push({
        category: title,
        kind: 'update',
        title: 'Обновить настройки репозитория',
        details: changed,
        stage: Stage.settings,
        apply: async (client: GitHubClient) => {
          await client.mutate('PATCH', repoPath(ctx.target), body);
        }
      });
    }
    if (topicsDiffer && chosen.has('topics') && data.topics.source) items.push(...(await planTopics(ctx, data.topics.source, data.topics.target ?? [])));
    if (branchChange && chosen.has('default_branch')) {
      items.push({
        category: title,
        kind: 'update',
        title: `Сменить ветку по умолчанию на ${branch.source}`,
        risk: 'смена ветки по умолчанию влияет на pull request и правила',
        stage: Stage.defaultBranch,
        apply: async (client) => {
          await client.mutate('PATCH', repoPath(ctx.target), { default_branch: branch.source });
        }
      });
    }
    return items;
  }
});

async function planTopics(ctx: Context, source: string[], target: string[]): Promise<PlanItem[]> {
  let names = source;
  if (target.length) {
    const answer = await askConflict(ctx, 'В цели уже есть темы. Что сделать?', { merge: 'Объединить (добавить недостающие)', replace: 'Заменить списком источника' });
    if (answer === 'keep' || answer === 'skip') return [{ category: title, kind: answer, title: 'Темы (topics) оставлены как в цели', stage: Stage.settings }];
    names = answer === 'merge' ? [...new Set([...target, ...source])] : source;
  }
  return [
    {
      category: title,
      kind: target.length ? 'update' : 'create',
      title: `Темы: ${names.join(', ')}`,
      stage: Stage.settings,
      apply: async (client) => {
        await client.mutate('PUT', repoPath(ctx.target, 'topics'), { names });
      }
    }
  ];
}
