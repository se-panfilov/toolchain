import { adaptActors, combine, discoverProtection, normalizeProtection, protectionBody, protectionCategory, unprotected, weakenedFields } from '@reRules/protection';
import { describe, expect, test } from 'vitest';

import { body, context, FakeApi, repo } from './helpers.js';

const sourceRaw = {
  required_status_checks: { strict: true, checks: [{ context: 'ci', app_id: null }] },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 2, require_last_push_approval: false },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_conversation_resolution: { enabled: true },
  required_signatures: { enabled: true }
};

const targetRaw = {
  required_pull_request_reviews: { dismiss_stale_reviews: false, require_code_owner_reviews: false, required_approving_review_count: 3, require_last_push_approval: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  lock_branch: { enabled: true }
};

describe('branch protection model', () => {
  test('the API response is normalized without invented values', () => {
    const value = normalizeProtection(sourceRaw);
    expect(value.checks).toEqual({ strict: true, checks: [{ context: 'ci', app_id: null }] });
    expect(value.reviews?.count).toBe(2);
    expect(value.restrictions).toBeNull();
    expect(value.signatures).toBe(true);
  });

  test('merge keeps the stricter value of each selected field', () => {
    const merged = combine(normalizeProtection(targetRaw), normalizeProtection(sourceRaw), new Set(['reviews', 'checks', 'lockBranch']), 'merge');
    expect(merged.reviews).toMatchObject({ count: 3, codeOwners: true, dismissStale: true, lastPush: true });
    expect(merged.checks?.checks.map((check) => check.context)).toEqual(['ci']);
    expect(merged.lockBranch).toBe(true);
    expect(weakenedFields(normalizeProtection(targetRaw), merged)).toEqual([]);
  });

  test('fields that are not selected keep the target value', () => {
    const next = combine(normalizeProtection(targetRaw), normalizeProtection(sourceRaw), new Set(['linearHistory']), 'replace');
    expect(next.reviews?.count).toBe(3);
    expect(next.lockBranch).toBe(true);
    expect(next.linearHistory).toBe(true);
  });

  test('replace reports each weakened field', () => {
    const current = normalizeProtection(targetRaw);
    const next = combine(current, normalizeProtection(sourceRaw), new Set(['reviews', 'lockBranch']), 'replace');
    expect(weakenedFields(current, next)).toEqual(['reviews', 'lockBranch']);
  });

  test('a personal target cannot keep push restrictions or review actor lists', () => {
    const value = { ...normalizeProtection(sourceRaw), restrictions: { users: ['a'], teams: ['t'], apps: [] } };
    const { protection, warnings } = adaptActors(value, repo('acme', 'template', { ownerType: 'Organization' }), repo('me', 'project'));
    expect(protection.restrictions).toBeNull();
    expect(warnings).toEqual([expect.stringContaining('только в репозиториях организаций')]);
  });

  test('another organization gets empty actor lists, which only administrators can pass', () => {
    const value = { ...normalizeProtection(sourceRaw), restrictions: { users: ['a'], teams: [], apps: [] } };
    const { protection } = adaptActors(value, repo('acme', 'template', { ownerType: 'Organization' }), repo('other', 'project', { ownerType: 'Organization' }));
    expect(protection.restrictions).toEqual({ users: [], teams: [], apps: [] });
  });

  test('the PUT body has every required key', () => {
    expect(Object.keys(protectionBody(unprotected, false)).sort()).toEqual(
      [
        'allow_deletions',
        'allow_force_pushes',
        'allow_fork_syncing',
        'block_creations',
        'enforce_admins',
        'lock_branch',
        'required_conversation_resolution',
        'required_linear_history',
        'required_pull_request_reviews',
        'required_status_checks',
        'restrictions'
      ].sort()
    );
  });
});

function api(targetBranch: { exists: boolean; protected?: boolean }): FakeApi {
  const fake = new FakeApi()
    .on('GET', '/repos/me/template/branches', { status: 200, body: [{ name: 'main', protected: true }] })
    .on('GET', '/repos/me/template/branches/main/protection', { status: 200, body: sourceRaw })
    .on('PUT', '/repos/me/project/branches/main/protection', { status: 200, body: {} })
    .on('POST', '/repos/me/project/branches/main/protection/required_signatures', { status: 200, body: {} });
  if (targetBranch.exists) fake.on('GET', '/repos/me/project/branches/main', { status: 200, body: { name: 'main', protected: targetBranch.protected === true } });
  if (targetBranch.protected) fake.on('GET', '/repos/me/project/branches/main/protection', { status: 200, body: targetRaw });
  return fake;
}

describe('branch protection plan', () => {
  test('a branch that is missing in the target gets a warning and no write', async () => {
    const ctx = context(api({ exists: false }), ['Да, всё']);
    const items = await protectionCategory.plan(await discoverProtection(ctx), ctx);
    expect(items.map((item) => item.kind)).toEqual(['warn']);
    expect(items[0]?.title).toContain('ветки нет в цели');
  });

  test('an unprotected target gets the full source protection and the signature requirement', async () => {
    const fake = api({ exists: true });
    const ctx = context(fake, ['Да, всё']);
    const [item] = await protectionCategory.plan(await discoverProtection(ctx), ctx);
    expect(item?.kind).toBe('create');
    ctx.client.allowWrites(ctx.target);
    await item?.apply?.(ctx.client);
    expect(fake.mutations.map((request) => request.method)).toEqual(['PUT', 'POST']);
    expect(body(fake.mutations[0])).toMatchObject({ enforce_admins: true, required_linear_history: true, restrictions: null });
  });

  test('a merge with an existing protection is not risky; a weakening replace is', async () => {
    const merge = context(api({ exists: true, protected: true }), ['Да, всё', 'Объединить, сохраняя более строгие значения']);
    const [merged] = await protectionCategory.plan(await discoverProtection(merge), merge);
    expect(merged?.risk).toBeUndefined();
    const replace = context(api({ exists: true, protected: true }), ['Да, всё', 'Заменить выбранные параметры значениями источника']);
    const [replaced] = await protectionCategory.plan(await discoverProtection(replace), replace);
    expect(replaced?.risk).toBe('ослабление защиты ветки');
  });
});
