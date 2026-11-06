import type { RepoInfo } from '@reRules/repo';
import { comparable, discoverRulesets, rulesetsCategory, transformRuleset, withoutInvalid } from '@reRules/rulesets';
import { describe, expect, test } from 'vitest';

import { body, context, FakeApi, repo } from './helpers.js';

const source = repo('me', 'template');
const personal = repo('me', 'project');
const org = (owner: string): RepoInfo => repo(owner, 'project', { ownerType: 'Organization' });

const protectMain = {
  id: 11,
  node_id: 'RRS_x',
  name: 'Protect main',
  target: 'branch',
  source_type: 'Repository',
  source: 'me/template',
  enforcement: 'active',
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
  current_user_can_bypass: 'always',
  _links: { self: { href: 'x' } },
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  bypass_actors: [
    { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    { actor_id: 77, actor_type: 'Team', bypass_mode: 'pull_request' },
    { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
    { actor_id: 99, actor_type: 'Integration', bypass_mode: 'always' }
  ],
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: false } },
    { type: 'required_deployments', parameters: { required_deployment_environments: ['production'] } }
  ]
};

describe('ruleset payload', () => {
  test('server-generated metadata is removed', () => {
    const { payload } = transformRuleset(protectMain, source, personal, new Set(['production']));
    for (const key of ['id', 'node_id', 'source', 'source_type', '_links', 'created_at', 'updated_at', 'current_user_can_bypass']) expect(payload).not.toHaveProperty(key);
    expect(payload).toMatchObject({ name: 'Protect main', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } } });
    expect(payload.rules).toEqual(protectMain.rules);
  });

  test('a personal target loses team and organization bypass actors and keeps apps of the same owner', () => {
    const { payload, warnings } = transformRuleset(protectMain, source, personal, new Set(['production']));
    expect((payload.bypass_actors as { actor_type: string }[]).map((actor) => actor.actor_type)).toEqual(['RepositoryRole', 'Integration']);
    expect(warnings.filter((warning) => warning.includes('Исключён обход'))).toHaveLength(2);
    expect(warnings.some((warning) => warning.includes('должно быть установлено'))).toBe(true);
  });

  test('apps of another owner are removed', () => {
    const { payload } = transformRuleset(protectMain, source, repo('other', 'project'), new Set(['production']));
    expect(payload.bypass_actors).toEqual([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
  });

  test('the same organization keeps teams, org admins, and apps with a warning', () => {
    const { payload, warnings } = transformRuleset(protectMain, repo('acme', 'template', { ownerType: 'Organization', id: 1 }), org('acme'), new Set(['production']));
    expect(payload.bypass_actors).toHaveLength(4);
    expect(warnings.some((warning) => warning.includes('должно быть установлено'))).toBe(true);
  });

  test('another organization loses teams and apps but keeps org admins', () => {
    const { payload } = transformRuleset(protectMain, repo('acme', 'template', { ownerType: 'Organization', id: 1 }), org('other'), new Set(['production']));
    expect((payload.bypass_actors as { actor_type: string }[]).map((actor) => actor.actor_type)).toEqual(['RepositoryRole', 'OrganizationAdmin']);
  });

  test('a required deployment of a missing environment is invalid, not silently dropped', () => {
    const result = transformRuleset(protectMain, source, personal, new Set());
    expect(result.invalid).toEqual([expect.stringContaining('production')]);
    const reduced = withoutInvalid(result.payload, source, new Set());
    expect((reduced.rules as { type: string }[]).map((rule) => rule.type)).toEqual(['deletion', 'non_fast_forward', 'pull_request']);
  });

  test('a workflow rule that points to the source repository is invalid', () => {
    const ruleset = { ...protectMain, rules: [{ type: 'workflows', parameters: { workflows: [{ path: '.github/workflows/ci.yml', repository_id: source.id }] } }] };
    expect(transformRuleset(ruleset, source, personal, new Set()).invalid).toEqual([expect.stringContaining('ci.yml')]);
  });
});

function rulesetApi(targetRulesets: unknown[] = []): FakeApi {
  return new FakeApi()
    .on('GET', '/repos/me/template/rulesets', {
      status: 200,
      body: [
        { id: 11, name: 'Protect main', source_type: 'Repository', source: 'me/template' },
        { id: 12, name: 'Org policy', source_type: 'Organization', source: 'acme' }
      ]
    })
    .on('GET', '/repos/me/template/rulesets/11', { status: 200, body: protectMain })
    .on('GET', '/repos/me/project/rulesets', {
      status: 200,
      body: targetRulesets.map((item) => ({ id: (item as { id: number }).id, name: (item as { name: string }).name, target: 'branch', source_type: 'Repository', source: 'me/project' }))
    })
    .on('GET', '/repos/me/project/rulesets/21', { status: 200, body: targetRulesets[0] ?? {} })
    .on('GET', '/repos/me/project/branches', { status: 200, body: [{ name: 'main' }] })
    .on('POST', '/repos/me/project/rulesets', { status: 201, body: { id: 30 } })
    .on('PUT', '/repos/me/project/rulesets/21', { status: 200, body: {} });
}

describe('ruleset plan', () => {
  test('inherited organization rulesets are informational only', async () => {
    const ctx = context(rulesetApi());
    const data = await discoverRulesets(ctx);
    expect(data.own.ok && data.own.value.map((item) => item.name)).toEqual(['Protect main']);
    expect(data.inherited.map((item) => item.name)).toEqual(['Org policy']);
  });

  test('a new ruleset is created only after apply and checks for duplicates first', async () => {
    const api = rulesetApi();
    const ctx = context(api, ['Да, всё'], {});
    ctx.targetEnvironments.add('production');
    const data = await discoverRulesets(ctx);
    const items = await rulesetsCategory.plan(data, ctx);
    expect(items.map((item) => item.kind)).toEqual(['create']);
    expect(api.mutations).toHaveLength(0);
    const client = ctx.client;
    client.allowWrites(ctx.target);
    await items[0]?.apply?.(client);
    expect(api.mutations).toHaveLength(1);
    expect(body(api.mutations[0])).not.toHaveProperty('id');
  });

  test('an equal target ruleset is kept without a question; a rerun creates no duplicate', async () => {
    const existing = {
      ...protectMain,
      id: 21,
      source: 'me/project',
      bypass_actors: [
        { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
        { actor_id: 99, actor_type: 'Integration', bypass_mode: 'always' }
      ]
    };
    const ctx = context(rulesetApi([existing]), ['Да, всё']);
    ctx.targetEnvironments.add('production');
    const items = await rulesetsCategory.plan(await discoverRulesets(ctx), ctx);
    expect(items.map((item) => item.kind)).toEqual(['keep']);
    expect(ctx.ask.remaining).toBe(0);
  });

  test('replacing a different target ruleset is a risky update of the same id', async () => {
    const existing = { ...protectMain, id: 21, source: 'me/project', enforcement: 'disabled', bypass_actors: [] };
    const api = rulesetApi([existing]);
    const ctx = context(api, ['Да, всё', 'Заменить настройками источника']);
    ctx.targetEnvironments.add('production');
    const [item] = await rulesetsCategory.plan(await discoverRulesets(ctx), ctx);
    expect(item).toMatchObject({ kind: 'update', risk: 'замена может ослабить существующие правила цели' });
    ctx.client.allowWrites(ctx.target);
    await item?.apply?.(ctx.client);
    expect(api.mutations.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(['PUT /repos/me/project/rulesets/21']);
  });

  test('invalid rules skip the ruleset unless the user accepts a weaker copy', async () => {
    const ctx = context(rulesetApi(), ['Да, всё', false]);
    const items = await rulesetsCategory.plan(await discoverRulesets(ctx), ctx);
    expect(items.map((item) => item.kind)).toEqual(['warn']);
    expect(items[0]?.title).toContain('недопустимые правила');
  });

  test('a plan restriction is shown as unsupported', async () => {
    const api = new FakeApi().on('GET', '/repos/me/template/rulesets', { status: 403, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } });
    const data = await discoverRulesets(context(api));
    expect(data.own).toMatchObject({ ok: false, state: 'unsupported' });
  });

  test('comparison ignores server metadata', () => {
    expect(comparable({ ...protectMain, id: 1 })).toEqual(comparable({ ...protectMain, id: 2, created_at: 'x' }));
  });
});
