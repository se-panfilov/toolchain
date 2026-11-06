import { codeownersCategory, discoverCodeowners, findCodeowners, parseOwners } from '@repoRules/codeowners';
import { describe, expect, test } from 'vitest';

import { body, context, FakeApi, type Reply, repo } from './helpers.js';

function file(text: string, sha = 'abc'): Reply {
  const content = Buffer.from(text);
  return { status: 200, body: { type: 'file', encoding: 'base64', size: content.length, sha, content: content.toString('base64').replace(/(.{20})/g, '$1\n') } };
}

describe('CODEOWNERS discovery', () => {
  test('.github/CODEOWNERS comes before the root and docs files', async () => {
    const api = new FakeApi().on('GET', '/repos/me/template/contents/.github/CODEOWNERS', file('* @a\n')).on('GET', '/repos/me/template/contents/CODEOWNERS', file('* @b\n'));
    const found = await findCodeowners(api.client(), repo('me', 'template'));
    expect(found?.path).toBe('.github/CODEOWNERS');
    expect(found?.content.toString()).toBe('* @a\n');
    expect(new URL(api.requests[0]?.url ?? '').searchParams.get('ref')).toBe('main');
  });

  test('docs/CODEOWNERS is found when the other locations are empty', async () => {
    const api = new FakeApi().on('GET', '/repos/me/template/contents/docs/CODEOWNERS', file('* @c\n'));
    expect((await findCodeowners(api.client(), repo('me', 'template')))?.path).toBe('docs/CODEOWNERS');
  });

  test('a symbolic link is not read as CODEOWNERS', async () => {
    const api = new FakeApi().on('GET', '/repos/me/template/contents/.github/CODEOWNERS', { status: 200, body: { type: 'symlink', target: '../secret' } });
    await expect(findCodeowners(api.client(), repo('me', 'template'))).rejects.toThrow('не является обычным файлом');
  });

  test('owners are parsed from rules, not from comments', () => {
    expect(parseOwners('# owner @nobody\n*.js @me @acme/devs # trailing @x\n/docs/ dev@example.com\n\n')).toEqual(['@me', '@acme/devs', 'dev@example.com']);
  });
});

describe('CODEOWNERS plan', () => {
  test('an inherited, byte-equal file needs no write and no question', async () => {
    const api = new FakeApi()
      .on('GET', '/repos/me/template/contents/.github/CODEOWNERS', file('* @me\n'))
      .on('GET', '/repos/me/project/contents/.github/CODEOWNERS', file('* @me\n', 'def'))
      .on('GET', '/repos/me/project/collaborators/me', { status: 204 });
    const ctx = context(api);
    const items = await codeownersCategory.plan(await discoverCodeowners(ctx), ctx);
    expect(items).toEqual([expect.objectContaining({ kind: 'keep' })]);
    expect(ctx.ask.questions).toEqual([]);
  });

  test('a replace writes the exact source bytes to the effective target path with the old sha', async () => {
    const text = '* @me\r\n/docs/ @me\n';
    const api = new FakeApi()
      .on('GET', '/repos/me/template/contents/docs/CODEOWNERS', file(text))
      .on('GET', '/repos/me/project/contents/CODEOWNERS', file('* @old\n', 'old-sha'))
      .on('PUT', '/repos/me/project/contents/CODEOWNERS', { status: 200, body: {} });
    const ctx = context(api, ['Заменить содержимым источника']);
    const [item] = await codeownersCategory.plan(await discoverCodeowners(ctx), ctx);
    expect(item).toMatchObject({ kind: 'update', risk: 'перезапись файла конфигурации' });
    ctx.client.allowWrites(ctx.target);
    await item?.apply?.(ctx.client);
    const sent = body(api.mutations[0]) as { content: string; sha: string; branch: string };
    expect(Buffer.from(sent.content, 'base64').toString()).toBe(text);
    expect(sent).toMatchObject({ sha: 'old-sha', branch: 'main' });
  });

  test('owners without access to the target are reported', async () => {
    const api = new FakeApi().on('GET', '/repos/me/template/contents/.github/CODEOWNERS', file('* @ghost @other-org/team\n'));
    const data = await discoverCodeowners(context(api));
    expect(data.problems).toEqual([expect.stringContaining('@ghost'), expect.stringContaining('другой организации')]);
  });
});
