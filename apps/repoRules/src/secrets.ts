import { sealSecret } from '@repoRules/crypto';
import { pick } from '@repoRules/flow';
import { type GitHubClient, repoPath } from '@repoRules/github';
import { category, type Context, type PlanItem, Stage } from '@repoRules/plan';
import type { RepoInfo } from '@repoRules/repo';
import { attempt, type Read, rec, str } from '@repoRules/state';

const title = 'Секреты Actions';
const maxSecretBytes = 48 * 1024;

export type SecretName = { scope: string | undefined; name: string; updatedAt: string };
export type SecretsData = { source: Read<SecretName[]>; target: Read<SecretName[]>; failedScopes: string[] };

export function validSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name) && !name.toUpperCase().startsWith('GITHUB_');
}

function basePath(scope: string | undefined): string[] {
  return scope === undefined ? ['actions', 'secrets'] : ['environments', scope, 'secrets'];
}

async function readScope(client: GitHubClient, repo: RepoInfo, scope: string | undefined): Promise<SecretName[]> {
  return (await client.paginate(repoPath(repo, ...basePath(scope)), {}, 'secrets')).map((item) => ({
    scope,
    name: str(rec(item).name) ?? '',
    updatedAt: str(rec(item).updated_at) ?? ''
  }));
}

async function readAll(client: GitHubClient, repo: RepoInfo, failed: string[]): Promise<SecretName[]> {
  const out = await readScope(client, repo, undefined);
  const envs = await attempt(async () => (await client.paginate(repoPath(repo, 'environments'), {}, 'environments')).flatMap((item) => str(rec(item).name) ?? []));
  if (!envs.ok) failed.push(`${repo.fullName}: окружения (${envs.detail})`);
  for (const env of envs.ok ? envs.value : []) {
    const scoped = await attempt(() => readScope(client, repo, env));
    if (scoped.ok) out.push(...scoped.value);
    else failed.push(`${repo.fullName}: окружение ${env} (${scoped.detail})`);
  }
  return out;
}

export async function discoverSecrets(ctx: Context): Promise<SecretsData> {
  const failedScopes: string[] = [];
  const source = await attempt(() => readAll(ctx.client, ctx.source, failedScopes));
  const target = await attempt(() => readAll(ctx.client, ctx.target, failedScopes));
  return { source, target, failedScopes };
}

function label(secret: Pick<SecretName, 'scope' | 'name'>): string {
  return secret.scope === undefined ? secret.name : `${secret.scope} / ${secret.name}`;
}

/** Write one secret: read the target public key, encrypt locally, send only the encrypted value. */
export async function writeSecret(client: GitHubClient, target: RepoInfo, scope: string | undefined, name: string, value: string): Promise<void> {
  const key = rec(await client.get(repoPath(target, ...basePath(scope), 'public-key')));
  const keyId = str(key.key_id);
  const publicKey = str(key.key);
  if (!keyId || !publicKey) throw new Error('GitHub не вернул открытый ключ для секретов.');
  await client.mutate('PUT', repoPath(target, ...basePath(scope), name), { encrypted_value: await sealSecret(value, publicKey), key_id: keyId });
}

export const secretsCategory = category<SecretsData>({
  id: 'secrets',
  title,
  discover: discoverSecrets,
  empty(data) {
    return data.source.ok && data.source.value.length === 0 && data.failedScopes.length === 0 ? 'В источнике нет секретов.' : undefined;
  },
  present(data, ctx) {
    if (!data.source.ok) {
      ctx.ui.warn(`Секреты источника: ${data.source.detail}`);
      return;
    }
    ctx.ui.section('Секреты источника (только имена):');
    const targetNames = new Set(data.target.ok ? data.target.value.map((secret) => label(secret).toUpperCase()) : []);
    ctx.ui.rows(data.source.value.map((secret) => [label(secret), `обновлён ${secret.updatedAt || 'неизвестно'}${targetNames.has(label(secret).toUpperCase()) ? '; есть в цели' : ''}`] as const));
    for (const scope of data.failedScopes) ctx.ui.warn(`Не прочитано: ${scope}`);
    ctx.ui.info('GitHub не отдаёт значения секретов. Программа не копирует их: можно только ввести новые значения.');
  },
  async plan(data, ctx) {
    if (!data.source.ok) return [{ category: title, kind: 'warn', title: `Секреты не прочитаны: ${data.source.detail}`, stage: Stage.variables }];
    const items: PlanItem[] = [];
    const targetNames = new Set(data.target.ok ? data.target.value.map((secret) => label(secret).toUpperCase()) : []);
    const candidates = data.source.value.filter((secret) => {
      if (!validSecretName(secret.name)) {
        items.push({ category: title, kind: 'warn', title: `${label(secret)}: недопустимое имя`, stage: Stage.variables });
        return false;
      }
      if (secret.scope !== undefined && !ctx.targetEnvironments.has(secret.scope)) {
        items.push({ category: title, kind: 'warn', title: `${label(secret)}: окружения ${secret.scope} нет в цели и в плане`, stage: Stage.variables });
        return false;
      }
      return true;
    });
    if (!candidates.length) return items;
    if (!(await ctx.ask.confirm('Создать выбранные секреты в цели, введя новые значения?', false))) {
      return [...items, { category: title, kind: 'skip', title: 'Секреты не пересоздаются', stage: Stage.variables }];
    }
    const chosen = await pick(
      ctx,
      'select',
      'Какие секреты создать?',
      candidates,
      (secret) => `${label(secret)}${targetNames.has(label(secret).toUpperCase()) ? ' (есть в цели, будет перезаписан)' : ''}`,
      (secret) => !targetNames.has(label(secret).toUpperCase())
    );
    for (const secret of chosen) {
      const exists = targetNames.has(label(secret).toUpperCase());
      let value: string | undefined;
      if (!ctx.dryRun) {
        for (;;) {
          value = await ctx.ask.secret(`Значение ${label(secret)} (не отображается)`);
          if (value === '') ctx.ui.warn('Пустое значение не допускается.');
          else if (Buffer.byteLength(value, 'utf8') > maxSecretBytes) ctx.ui.warn('Значение больше 48 КБ.');
          else break;
        }
      }
      const item: PlanItem = {
        category: title,
        kind: exists ? 'update' : 'create',
        title: `${exists ? 'Перезаписать' : 'Создать'} секрет ${label(secret)}`,
        details: [ctx.dryRun ? 'В пробном запуске значение не запрашивается.' : 'Значение введено, хранится только в памяти до записи.'],
        stage: Stage.variables,
        apply: async (client) => {
          if (value === undefined) throw new Error('Значение секрета не введено.');
          await writeSecret(client, ctx.target, secret.scope, secret.name, value);
          value = undefined;
        }
      };
      if (exists) item.risk = 'перезапись секрета';
      items.push(item);
    }
    return items;
  }
});
