import { askConflict, askTransfer, pick } from '@reRules/flow';
import { repoPath } from '@reRules/github';
import { type AnyCategory, category, type Context, type PlanItem, Stage } from '@reRules/plan';
import { attempt, bool, num, type Read, rec, sameJson, str } from '@reRules/state';
import { plain } from '@reRules/ui';

/** A named object that is matched by name between source and target. */
type Named = { key: string; label: string; body: Record<string, unknown>; ref: string | number | undefined };
export type NamedData = { source: Read<Named[]>; target: Read<Named[]> };

type NamedSpec = {
  id: string;
  title: string;
  noun: string;
  read(ctx: Context, repo: Context['source']): Promise<Named[]>;
  /** Path segments for a new object. */
  createPath: string[];
  /** Path segments to update an existing object, or undefined when GitHub has no update operation. */
  updatePath?: (existing: Named) => (string | number)[];
  updateBody?: (source: Named, existing: Named) => Record<string, unknown>;
  limitation?: string;
};

/** Make a category for labels, milestones, and autolinks: create missing objects, update only after a question, never delete. */
function namedCategory(spec: NamedSpec): AnyCategory {
  const stage = Stage.labels;
  return category<NamedData>({
    id: spec.id,
    title: spec.title,
    async discover(ctx) {
      return { source: await attempt(() => spec.read(ctx, ctx.source)), target: await attempt(() => spec.read(ctx, ctx.target)) };
    },
    empty(data) {
      return data.source.ok && data.source.value.length === 0 ? `В источнике нет объектов: ${spec.noun}.` : undefined;
    },
    present(data, ctx) {
      if (!data.source.ok) {
        ctx.ui.warn(`${spec.title}: ${data.source.detail}`);
        return;
      }
      ctx.ui.section(`${spec.title} источника: ${data.source.value.length}`);
      for (const item of data.source.value) ctx.ui.text(item.label, 4);
      if (spec.limitation) ctx.ui.info(spec.limitation);
    },
    async plan(data, ctx) {
      if (!data.source.ok) return [{ category: spec.title, kind: 'warn', title: `Не прочитано: ${data.source.detail}`, stage }];
      if (!data.target.ok) return [{ category: spec.title, kind: 'warn', title: `Цель не прочитана: ${data.target.detail}`, stage }];
      const target = data.target.value;
      const find = (item: Named): Named | undefined => target.find((other) => other.key === item.key);
      const items: PlanItem[] = [];
      const candidates = data.source.value.filter((item) => {
        const existing = find(item);
        if (existing && sameJson(existing.body, item.body)) {
          items.push({ category: spec.title, kind: 'keep', title: `${item.label}: уже совпадает`, stage });
          return false;
        }
        return true;
      });
      if (!candidates.length) return items;
      const mode = await askTransfer(ctx, `Перенести: ${spec.noun}?`);
      if (mode === 'skip') return [...items, { category: spec.title, kind: 'skip', title: `${spec.title} пропущены`, stage }];
      const chosen = await pick(ctx, mode, 'Что перенести?', candidates, (item) => `${item.label}${find(item) ? ' (есть в цели, отличается)' : ''}`);
      for (const item of chosen) {
        const existing = find(item);
        if (!existing) {
          items.push({
            category: spec.title,
            kind: 'create',
            title: `Создать: ${item.label}`,
            stage,
            apply: async (client) => {
              await client.mutate('POST', repoPath(ctx.target, ...spec.createPath), item.body);
            }
          });
          continue;
        }
        if (!spec.updatePath || !spec.updateBody) {
          items.push({ category: spec.title, kind: 'warn', title: `${item.label}: есть в цели с другими значениями; GitHub не позволяет изменить без удаления`, stage });
          continue;
        }
        const answer = await askConflict(ctx, `${item.label} уже есть в цели. Что сделать?`, { replace: 'Обновить значениями источника' });
        if (answer !== 'replace') {
          items.push({ category: spec.title, kind: answer === 'skip' ? 'skip' : 'keep', title: `${item.label}: оставлено как в цели`, stage });
          continue;
        }
        const path = spec.updatePath(existing);
        const body = spec.updateBody(item, existing);
        items.push({
          category: spec.title,
          kind: 'update',
          title: `Обновить: ${item.label}`,
          stage,
          apply: async (client) => {
            await client.mutate('PATCH', repoPath(ctx.target, ...path), body);
          }
        });
      }
      return items;
    }
  });
}

export const labelsCategory = namedCategory({
  id: 'labels',
  title: 'Метки issues',
  noun: 'метки',
  createPath: ['labels'],
  async read(ctx, repo) {
    return (await ctx.client.paginate(repoPath(repo, 'labels'))).map((raw) => {
      const item = rec(raw);
      const name = str(item.name) ?? '';
      const body = { name, color: str(item.color) ?? '', description: str(item.description) ?? '' };
      // GitHub compares label names without letter case.
      return { key: name.toLowerCase(), label: `${name} (#${body.color}${body.description ? `, ${body.description}` : ''})`, body, ref: name };
    });
  },
  updatePath: (existing) => ['labels', String(existing.ref)],
  updateBody: (source) => ({ new_name: source.body.name, color: source.body.color, description: source.body.description })
});

export const milestonesCategory = namedCategory({
  id: 'milestones',
  title: 'Вехи (milestones)',
  noun: 'вехи',
  createPath: ['milestones'],
  limitation: 'Переносятся только название, описание, срок и состояние. Issues не переносятся.',
  async read(ctx, repo) {
    return (await ctx.client.paginate(repoPath(repo, 'milestones'), { state: 'all' })).map((raw) => {
      const item = rec(raw);
      const titleText = str(item.title) ?? '';
      const body: Record<string, unknown> = { title: titleText, state: str(item.state) ?? 'open', description: str(item.description) ?? '' };
      if (str(item.due_on)) body.due_on = str(item.due_on);
      return { key: titleText, label: `${titleText} (${plain(body.state)}${body.due_on ? `, срок ${plain(body.due_on)}` : ''})`, body, ref: num(item.number) };
    });
  },
  updatePath: (existing) => ['milestones', existing.ref ?? 0],
  updateBody: (source) => source.body
});

export const autolinksCategory = namedCategory({
  id: 'autolinks',
  title: 'Автоссылки',
  noun: 'автоссылки',
  createPath: ['autolinks'],
  limitation: 'GitHub не умеет изменять автоссылку: существующая с другим шаблоном остаётся.',
  async read(ctx, repo) {
    return (await ctx.client.paginate(repoPath(repo, 'autolinks'))).map((raw) => {
      const item = rec(raw);
      const prefix = str(item.key_prefix) ?? '';
      const body = { key_prefix: prefix, url_template: str(item.url_template) ?? '', is_alphanumeric: bool(item.is_alphanumeric) ?? true };
      return { key: prefix.toLowerCase(), label: `${prefix} → ${body.url_template}`, body, ref: num(item.id) };
    });
  }
});
