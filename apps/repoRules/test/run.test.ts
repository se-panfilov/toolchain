import { execute } from '@repoRules/execute';
import { ApiError, repoPath } from '@repoRules/github';
import { category, type PlanItem, Stage, summary } from '@repoRules/plan';
import { collectPlan, confirmAndApply } from '@repoRules/run';
import { settingsCategory } from '@repoRules/settings';
import { describe, expect, test } from 'vitest';

import { context, FakeApi, repo } from './helpers.js';

function change(title: string, stage: number, apply: NonNullable<PlanItem['apply']>, risk?: string): PlanItem {
  return { category: 'Test', kind: 'create', title, stage, apply, ...(risk ? { risk } : {}) };
}

const settingsSource = repo('me', 'template', { raw: { description: 'Template', has_wiki: false, allow_squash_merge: true } });
const settingsTarget = repo('me', 'project', { raw: { description: '', has_wiki: true, allow_squash_merge: true } });

describe('plan and confirmation', () => {
  test('dry-run discovers, asks, and plans, but never mutates', async () => {
    const api = new FakeApi();
    const ctx = context(api, ['Да, всё'], { source: settingsSource, target: settingsTarget, dryRun: true });
    ctx.client.freezeWrites();
    const items = await collectPlan(ctx, [settingsCategory]);
    expect(summary(items).changes).toBe(1);
    const result = await confirmAndApply(ctx, items);
    expect(result.status).toBe('dry-run');
    expect(api.mutations).toEqual([]);
    expect(ctx.out.text).toContain('Пробный запуск');
  });

  test('cancel at the final question applies nothing', async () => {
    const api = new FakeApi();
    const ctx = context(api, ['Да, всё', 'Отмена'], { source: settingsSource, target: settingsTarget });
    const result = await confirmAndApply(ctx, await collectPlan(ctx, [settingsCategory]));
    expect(result.status).toBe('cancelled');
    expect(api.mutations).toEqual([]);
  });

  test('a declined risk confirmation applies nothing', async () => {
    const api = new FakeApi();
    const ctx = context(api, ['Применить изменения', false]);
    const items = [change('risky', Stage.access, () => Promise.resolve(), 'выдача доступа')];
    expect((await confirmAndApply(ctx, items)).status).toBe('cancelled');
  });

  test('settings with an unknown source value are never planned', async () => {
    const ctx = context(new FakeApi(), ['Да, всё'], { source: settingsSource, target: settingsTarget });
    const items = await collectPlan(ctx, [settingsCategory]);
    const update = items.find((item) => item.kind === 'update');
    expect(update?.details).toEqual(['Описание: Template', 'Wiki: Нет']);
    expect(items.some((item) => item.kind === 'warn' && item.title.includes('Homepage'.toLowerCase()))).toBe(false);
    expect(items.some((item) => item.kind === 'warn' && item.title.startsWith('Домашняя страница'))).toBe(true);
  });

  test('a category that fails to load is reported and the others continue', async () => {
    const broken = category<unknown>({
      id: 'broken',
      title: 'Broken',
      discover: () => Promise.reject(new ApiError('permission', 403, 'Resource not accessible')),
      present: () => undefined,
      plan: () => Promise.resolve([])
    });
    const ctx = context(new FakeApi(), ['Да, всё'], { source: settingsSource, target: settingsTarget });
    const items = await collectPlan(ctx, [broken, settingsCategory]);
    expect(items[0]).toMatchObject({ kind: 'warn', category: 'Broken' });
    expect(items.some((item) => item.kind === 'update')).toBe(true);
  });
});

describe('execution', () => {
  test('items run in stage order and a failure does not stop independent items', async () => {
    const api = new FakeApi()
      .on('POST', '/repos/me/project/labels', { status: 422, body: { message: 'Validation Failed' } })
      .on('PUT', '/repos/me/project/environments/prod', { status: 200, body: {} })
      .on('POST', '/repos/me/project/rulesets', { status: 201, body: {} });
    const ctx = context(api);
    const target = ctx.target;
    const items = [
      change('ruleset', Stage.rulesets, (client) => client.mutate('POST', repoPath(target, 'rulesets'), {}).then(() => undefined)),
      change('label', Stage.labels, (client) => client.mutate('POST', repoPath(target, 'labels'), {}).then(() => undefined)),
      change('environment', Stage.environments, (client) => client.mutate('PUT', repoPath(target, 'environments', 'prod'), {}).then(() => undefined))
    ];
    ctx.client.allowWrites(target);
    const outcomes = await execute(items, ctx.client, ctx.ui);
    expect(outcomes.map((outcome) => [outcome.item.title, outcome.status, outcome.kind])).toEqual([
      ['label', 'failed', 'validation'],
      ['environment', 'done', undefined],
      ['ruleset', 'done', undefined]
    ]);
  });

  test('an authorization failure stops the remaining items', async () => {
    const api = new FakeApi().on('POST', '/repos/me/project/labels', { status: 401, body: { message: 'Bad credentials' } });
    const ctx = context(api);
    const target = ctx.target;
    ctx.client.allowWrites(target);
    const outcomes = await execute(
      [change('a', 1, (client) => client.mutate('POST', repoPath(target, 'labels'), {}).then(() => undefined)), change('b', 2, () => Promise.resolve())],
      ctx.client,
      ctx.ui
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'not-run']);
  });

  test('Ctrl+C stops after the current item', async () => {
    let stop = false;
    const ctx = context(new FakeApi());
    const outcomes = await execute(
      [
        change('a', 1, () => {
          stop = true;
          return Promise.resolve();
        }),
        change('b', 2, () => Promise.resolve())
      ],
      ctx.client,
      ctx.ui,
      () => stop
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['done', 'not-run']);
  });

  test('keep, skip, and warn items never run', async () => {
    let runs = 0;
    const ctx = context(new FakeApi());
    const apply = (): Promise<void> => {
      runs++;
      return Promise.resolve();
    };
    const items: PlanItem[] = (['keep', 'skip', 'warn'] as const).map((kind) => ({ category: 'Test', kind, title: kind, stage: 1, apply }));
    expect(await execute(items, ctx.client, ctx.ui)).toEqual([]);
    expect(runs).toBe(0);
  });
});
