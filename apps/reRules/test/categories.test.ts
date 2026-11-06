import { accessCategory, discoverAccess } from '@reRules/access';
import { sealSecret } from '@reRules/crypto';
import { discoverEnvironments, environmentsCategory } from '@reRules/environments';
import { labelsCategory } from '@reRules/extras';
import { maskUrl } from '@reRules/integrations';
import { discoverSecrets, secretsCategory, writeSecret } from '@reRules/secrets';
import { discoverSecurity, securityCategory } from '@reRules/security';
import { discoverVariables, variablesCategory } from '@reRules/variables';
import sodium from 'libsodium-wrappers';
import { describe, expect, test } from 'vitest';

import { body, context, FakeApi, repo } from './helpers.js';

describe('security settings', () => {
  test('an unavailable source setting is not treated as disabled and creates no change', async () => {
    const source = repo('me', 'template', { permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } });
    const target = repo('me', 'project', { raw: { security_and_analysis: { secret_scanning: { status: 'enabled' } } } });
    const ctx = context(new FakeApi(), [], { source, target });
    const data = await discoverSecurity(ctx);
    const scanning = data.find((item) => item.feature.id === 'secret_scanning');
    expect(scanning?.source).toMatchObject({ ok: false, state: 'forbidden' });
    const items = await securityCategory.plan(data, ctx);
    expect(items.every((item) => item.kind === 'warn')).toBe(true);
  });

  test('disabling an enabled target feature needs a separate confirmation', async () => {
    const source = repo('me', 'template', { raw: { security_and_analysis: { secret_scanning: { status: 'disabled' } } } });
    const target = repo('me', 'project', { raw: { security_and_analysis: { secret_scanning: { status: 'enabled' } } } });
    const ctx = context(new FakeApi(), [[0], false], { source, target });
    const items = await securityCategory.plan(await discoverSecurity(ctx), ctx);
    expect(items.filter((item) => item.kind === 'update')).toEqual([]);
    expect(items.some((item) => item.kind === 'keep' && item.title.includes('Secret scanning'))).toBe(true);
  });

  test('a 404 for Dependabot alerts means "disabled" only for an administrator', async () => {
    const reader = repo('me', 'template', { permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } });
    const data = await discoverSecurity(context(new FakeApi(), [], { source: reader }));
    expect(data.find((item) => item.feature.id === 'vulnerability_alerts')?.source).toMatchObject({ ok: false, state: 'unknown' });
  });
});

describe('secrets', () => {
  test('an unreadable target secret list cannot produce a write plan or request values', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/actions/secrets', { status: 200, body: { secrets: [{ name: 'API_KEY' }] } })
      .on('GET', '/repos/me/template/environments', { status: 200, body: { environments: [] } })
      .on('GET', '/repos/me/project/actions/secrets', { status: 403 });
    const ctx = context(api, [true, [0], 'replacement-value']);
    const items = await secretsCategory.plan(await discoverSecrets(ctx), ctx);
    expect(items.every((item) => item.kind === 'warn' && !item.apply)).toBe(true);
    expect(ctx.ask.questions).toEqual([]);
    expect(api.mutations).toEqual([]);
  });

  test.each(['environments', 'environments/prod/secrets'])('a failed target %s read blocks secret writes', async (path) => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/actions/secrets', { status: 200, body: { secrets: [] } })
      .on('GET', '/repos/me/template/environments', { status: 200, body: { environments: [{ name: 'prod' }] } })
      .on('GET', '/repos/me/template/environments/prod/secrets', { status: 200, body: { secrets: [{ name: 'API_KEY' }] } })
      .on('GET', '/repos/me/project/actions/secrets', { status: 200, body: { secrets: [] } })
      .on('GET', '/repos/me/project/environments', { status: 200, body: { environments: [{ name: 'prod' }] } })
      .on('GET', `/repos/me/project/${path}`, { status: 403 });
    const ctx = context(api, [true, [0], 'replacement-value']);
    ctx.targetEnvironments.add('prod');
    const items = await secretsCategory.plan(await discoverSecrets(ctx), ctx);
    expect(items.every((item) => item.kind === 'warn' && !item.apply)).toBe(true);
    expect(ctx.ask.questions).toEqual([]);
  });

  test('a sealed value opens with the matching private key and differs from the plain text', async () => {
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const sealed = await sealSecret('s3cret-value', sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL));
    expect(sealed).not.toContain('s3cret');
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey);
    expect(Buffer.from(opened).toString()).toBe('s3cret-value');
  });

  test('only the encrypted value goes to GitHub', async () => {
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const api = new FakeApi()
      .on('GET', '/repos/me/project/actions/secrets/public-key', { status: 200, body: { key_id: 'k1', key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL) } })
      .on('PUT', '/repos/me/project/actions/secrets/API_KEY', { status: 201 });
    const client = api.client();
    client.allowWrites(repo('me', 'project'));
    await writeSecret(client, repo('me', 'project'), undefined, 'API_KEY', 'plain-value');
    const request = api.mutations[0];
    expect(request?.body).not.toContain('plain-value');
    expect(body(request)).toMatchObject({ key_id: 'k1' });
    expect(typeof (body(request) as { encrypted_value?: unknown }).encrypted_value).toBe('string');
  });

  test('dry-run does not ask for secret values', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/actions/secrets', { status: 200, body: { total_count: 1, secrets: [{ name: 'API_KEY', updated_at: 'x' }] } })
      .on('GET', '/repos/me/project/actions/secrets', { status: 200, body: { total_count: 0, secrets: [] } })
      .on('GET', '/repos/me/template/environments', { status: 200, body: { environments: [] } })
      .on('GET', '/repos/me/project/environments', { status: 200, body: { environments: [] } });
    const ctx = context(api, [true, [0]], { dryRun: true });
    const items = await secretsCategory.plan(await discoverSecrets(ctx), ctx);
    expect(items).toEqual([expect.objectContaining({ kind: 'create', title: 'Создать секрет API_KEY' })]);
    expect(ctx.ask.remaining).toBe(0);
  });

  test('a known target secret is an overwrite that needs the additional risk confirmation', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/actions/secrets', { status: 200, body: { secrets: [{ name: 'API_KEY' }] } })
      .on('GET', '/repos/me/project/actions/secrets', { status: 200, body: { secrets: [{ name: 'api_key' }] } })
      .on('GET', '/repos/me/template/environments', { status: 200, body: { environments: [] } })
      .on('GET', '/repos/me/project/environments', { status: 200, body: { environments: [] } });
    const ctx = context(api, [true, [0]], { dryRun: true });
    const items = await secretsCategory.plan(await discoverSecrets(ctx), ctx);
    expect(items).toEqual([expect.objectContaining({ kind: 'update', risk: 'перезапись секрета' })]);
  });
});

describe('variables', () => {
  test.each(['environments', 'environments/prod/variables'])('a failed target %s read blocks variable writes', async (path) => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/actions/variables', { status: 200, body: { variables: [] } })
      .on('GET', '/repos/me/template/environments', { status: 200, body: { environments: [{ name: 'prod' }] } })
      .on('GET', '/repos/me/template/environments/prod/variables', { status: 200, body: { variables: [{ name: 'URL', value: 'new' }] } })
      .on('GET', '/repos/me/project/actions/variables', { status: 200, body: { variables: [] } })
      .on('GET', '/repos/me/project/environments', { status: 200, body: { environments: [{ name: 'prod' }] } })
      .on('GET', `/repos/me/project/${path}`, { status: 403 });
    const ctx = context(api, ['Да, всё']);
    ctx.targetEnvironments.add('prod');
    const items = await variablesCategory.plan(await discoverVariables(ctx), ctx);
    expect(items.every((item) => item.kind === 'warn' && !item.apply)).toBe(true);
    expect(ctx.ask.questions).toEqual([]);
  });

  const api = (): FakeApi =>
    new FakeApi()
      .on('GET', '/repos/me/template/actions/variables', {
        status: 200,
        body: {
          variables: [
            { name: 'REGION', value: 'eu' },
            { name: 'MODE', value: 'a' },
            { name: 'SAME', value: '1' }
          ]
        }
      })
      .on('GET', '/repos/me/template/environments', { status: 200, body: { environments: [{ name: 'prod' }] } })
      .on('GET', '/repos/me/template/environments/prod/variables', { status: 200, body: { variables: [{ name: 'URL', value: 'https://x' }] } })
      .on('GET', '/repos/me/project/actions/variables', {
        status: 200,
        body: {
          variables: [
            { name: 'MODE', value: 'b' },
            { name: 'SAME', value: '1' }
          ]
        }
      })
      .on('GET', '/repos/me/project/environments', { status: 200, body: { environments: [] } });

  test('equal values are kept, overwrites need an answer, and a missing environment is a warning', async () => {
    const ctx = context(api(), ['Да, всё', 'Оставить как в цели']);
    const items = await variablesCategory.plan(await discoverVariables(ctx), ctx);
    expect(items.map((item) => [item.kind, item.title])).toEqual([
      ['keep', 'SAME уже совпадает'],
      ['warn', 'prod / URL: окружения prod нет в цели и в плане'],
      ['create', 'Создать переменную REGION'],
      ['keep', 'MODE оставлена как в цели']
    ]);
  });

  test('a variable of an environment that the plan creates is transferred', async () => {
    const ctx = context(api(), ['Да, всё', 'Заменить значением источника']);
    ctx.targetEnvironments.add('prod');
    const items = await variablesCategory.plan(await discoverVariables(ctx), ctx);
    expect(items.find((item) => item.title.includes('prod / URL'))?.kind).toBe('create');
    expect(items.find((item) => item.title.includes('MODE'))).toMatchObject({ kind: 'update', risk: 'перезапись значения переменной' });
  });
});

describe('environments', () => {
  test('an environment with an unreproducible reviewer is skipped unless the user accepts a weaker copy', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/environments', {
        status: 200,
        body: {
          environments: [
            {
              name: 'production',
              protection_rules: [
                { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'ghost', id: 5 } }] },
                { type: 'wait_timer', wait_timer: 10 }
              ],
              deployment_branch_policy: null
            }
          ]
        }
      })
      .on('GET', '/repos/me/project/environments', { status: 200, body: { environments: [] } });
    const ctx = context(api, ['Да, всё', false]);
    const items = await environmentsCategory.plan(await discoverEnvironments(ctx), ctx);
    expect(items).toEqual([expect.objectContaining({ kind: 'warn' })]);
    expect(ctx.targetEnvironments.has('production')).toBe(false);
  });

  test('a valid environment is created with reviewers and the timer', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/environments', {
        status: 200,
        body: {
          environments: [
            {
              name: 'production',
              protection_rules: [
                { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { login: 'alice', id: 5 } }] },
                { type: 'wait_timer', wait_timer: 10 }
              ],
              deployment_branch_policy: null
            }
          ]
        }
      })
      .on('GET', '/repos/me/project/environments', { status: 200, body: { environments: [] } })
      .on('GET', '/repos/me/project/collaborators/alice', { status: 204 })
      .on('PUT', '/repos/me/project/environments/production', { status: 200, body: {} });
    const ctx = context(api, ['Да, всё']);
    const [item] = await environmentsCategory.plan(await discoverEnvironments(ctx), ctx);
    ctx.client.allowWrites(ctx.target);
    await item?.apply?.(ctx.client);
    expect(body(api.mutations[0])).toEqual({ wait_timer: 10, prevent_self_review: true, reviewers: [{ type: 'User', id: 5 }], deployment_branch_policy: null });
    expect(ctx.targetEnvironments.has('production')).toBe(true);
  });
});

describe('access', () => {
  const organization = repo('acme', 'project', { ownerType: 'Organization' });
  const membershipApi = (): FakeApi =>
    new FakeApi()
      .on('GET', '/repos/me/template/collaborators', { status: 200, body: [{ login: 'alice', role_name: 'write' }] })
      .on('GET', '/repos/acme/project/collaborators', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/invitations', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/teams', { status: 200, body: [] })
      .on('GET', '/orgs/acme/members/alice', { status: 403 });

  test('unknown membership is unchecked in manual selection', async () => {
    const ctx = context(membershipApi(), ['Выбрать отдельные', 'defaults'], { target: organization });
    const items = await accessCategory.plan(await discoverAccess(ctx), ctx);
    expect(items.some((item) => item.apply)).toBe(false);
    expect(ctx.ask.remaining).toBe(0);
  });

  test('an explicitly selected unknown member has a warning in the grant question', async () => {
    const api = membershipApi().on('PUT', '/repos/acme/project/collaborators/alice', { status: 201 });
    const ctx = context(api, ['Выбрать отдельные', [0], true], { target: organization });
    const items = await accessCategory.plan(await discoverAccess(ctx), ctx);
    expect(ctx.ask.questions.at(-1)).toContain('членство в организации неизвестно');
    ctx.client.allowWrites(ctx.target);
    await items.find((item) => item.apply)?.apply?.(ctx.client);
    expect(body(api.mutations[0])).toEqual({ permission: 'push' });
  });

  test('unknown organization membership is not selected automatically', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/collaborators', { status: 200, body: [{ login: 'alice', role_name: 'write' }] })
      .on('GET', '/repos/acme/project/collaborators', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/invitations', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/teams', { status: 200, body: [] })
      .on('GET', '/orgs/acme/members/alice', { status: 403 });
    const ctx = context(api, ['Да, всё', true], { target: repo('acme', 'project', { ownerType: 'Organization' }) });
    const items = await accessCategory.plan(await discoverAccess(ctx), ctx);
    expect(items.some((item) => item.apply)).toBe(false);
    expect(ctx.ask.remaining).toBe(1);
  });

  test('an unreadable target team list cannot produce a team grant', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/acme/template/collaborators', { status: 200, body: [] })
      .on('GET', '/repos/acme/template/teams', { status: 200, body: [{ slug: 'devs', permission: 'push' }] })
      .on('GET', '/repos/acme/project/collaborators', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/invitations', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/teams', { status: 403 });
    const ctx = context(api, ['Да, всё', true], {
      source: repo('acme', 'template', { ownerType: 'Organization' }),
      target: repo('acme', 'project', { ownerType: 'Organization' })
    });
    const items = await accessCategory.plan(await discoverAccess(ctx), ctx);
    expect(items.some((item) => item.apply)).toBe(false);
    expect(items.some((item) => item.kind === 'warn')).toBe(true);
    expect(ctx.ask.questions).toEqual([]);
  });

  test('an existing custom role is not replaced with an incomparable standard role', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/collaborators', { status: 200, body: [{ login: 'alice', role_name: 'write' }] })
      .on('GET', '/repos/acme/project/collaborators', { status: 200, body: [{ login: 'alice', role_name: 'custom-security-role' }] })
      .on('GET', '/repos/acme/project/invitations', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/teams', { status: 200, body: [] })
      .on('GET', '/orgs/acme/members/alice', { status: 204 });
    const ctx = context(api, ['Да, всё', true], { target: repo('acme', 'project', { ownerType: 'Organization' }) });
    const items = await accessCategory.plan(await discoverAccess(ctx), ctx);
    expect(items.some((item) => item.apply)).toBe(false);
    expect(items.some((item) => item.kind === 'warn')).toBe(true);
  });

  test('each access grant needs its own confirmation, and outside collaborators are not preselected', async () => {
    const target = repo('acme', 'project', { ownerType: 'Organization' });
    const api = new FakeApi()
      .on('GET', '/repos/me/template/collaborators', {
        status: 200,
        body: [
          { login: 'me', role_name: 'admin' },
          { login: 'alice', role_name: 'write' },
          { login: 'bob', role_name: 'read' }
        ]
      })
      .on('GET', '/repos/acme/project/collaborators', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/invitations', { status: 200, body: [] })
      .on('GET', '/repos/acme/project/teams', { status: 200, body: [] })
      .on('GET', '/orgs/acme/members/alice', { status: 204 })
      .on('GET', '/orgs/acme/members/bob', { status: 404 });
    const ctx = context(api, ['Да, всё', true], { target });
    const data = await discoverAccess(ctx);
    const items = await accessCategory.plan(data, ctx);
    expect(items.map((item) => [item.kind, item.title])).toEqual([
      ['skip', 'bob: внешний соавтор, выберите вручную'],
      ['create', 'Пользователь alice: доступ write']
    ]);
    expect(items[1]?.risk).toBe('выдача доступа к репозиторию');
    expect(ctx.ask.questions.at(-1)).toContain('alice');
  });
});

describe('labels and webhooks', () => {
  test('labels match without letter case and are never deleted', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/labels', {
        status: 200,
        body: [
          { name: 'Bug', color: 'ff0000', description: '' },
          { name: 'docs', color: '00ff00', description: 'Docs' }
        ]
      })
      .on('GET', '/repos/me/project/labels', {
        status: 200,
        body: [
          { name: 'bug', color: 'ff0000', description: '' },
          { name: 'extra', color: '000000', description: '' }
        ]
      });
    const ctx = context(api, ['Да, всё', 'Обновить значениями источника']);
    const data = await labelsCategory.discover(ctx);
    const items = await labelsCategory.plan(data, ctx);
    expect(items.map((item) => item.kind)).toEqual(['update', 'create']);
    expect(items.some((item) => item.kind === 'delete')).toBe(false);
  });

  test('webhook addresses hide user data and query values', () => {
    expect(maskUrl('https://user:pass@hooks.example/path?token=abc&x=1')).toBe('https://***@hooks.example/path?token=***&x=***');
    expect(maskUrl('not a url')).toBe('(некорректный адрес)');
  });
});
