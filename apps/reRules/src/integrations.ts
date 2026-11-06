import { askConflict, askTransfer, pick } from '@reRules/flow';
import { repoPath } from '@reRules/github';
import { category, type Context, type PlanItem, Stage } from '@reRules/plan';
import { attempt, bool, known, missing, num, type Read, rec, sameJson, str, strings } from '@reRules/state';
import { plain, yesNo } from '@reRules/ui';

export type Webhook = { id: number | undefined; url: string; contentType: string; insecureSsl: string; hasSecret: boolean; events: string[]; active: boolean };
export type WebhooksData = { source: Read<Webhook[]>; target: Read<Webhook[]>; skipped: string[] };

/** Show a webhook address without user data and query values. They can contain credentials. */
export function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    const query = [...url.searchParams.keys()].map((key) => `${key}=***`).join('&');
    return `${url.protocol}//${url.username || url.password ? '***@' : ''}${url.host}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return '(некорректный адрес)';
  }
}

function normalizeHook(raw: unknown): Webhook | undefined {
  const item = rec(raw);
  if (item.name !== 'web') return undefined;
  const config = rec(item.config);
  const url = str(config.url) ?? '';
  return {
    id: num(item.id),
    url,
    contentType: str(config.content_type) ?? 'form',
    insecureSsl: str(config.insecure_ssl) ?? (num(config.insecure_ssl) === 1 ? '1' : '0'),
    hasSecret: typeof config.secret === 'string' && config.secret !== '',
    events: strings(item.events),
    active: bool(item.active) ?? true
  };
}

export const webhooksCategory = category<WebhooksData>({
  id: 'webhooks',
  title: 'Вебхуки',
  async discover(ctx) {
    const skipped: string[] = [];
    const read = async (repo: Context['source']): Promise<Webhook[]> =>
      (await ctx.client.paginate(repoPath(repo, 'hooks'))).flatMap((raw) => {
        const hook = normalizeHook(raw);
        if (!hook) skipped.push(`${repo.fullName}: вебхук типа ${plain(rec(raw).name)} не поддерживается`);
        return hook ? [hook] : [];
      });
    return { source: await attempt(() => read(ctx.source)), target: await attempt(() => read(ctx.target)), skipped };
  },
  empty(data) {
    return data.source.ok && data.source.value.length === 0 ? 'В источнике нет вебхуков.' : undefined;
  },
  present(data, ctx) {
    if (!data.source.ok) {
      ctx.ui.warn(`Вебхуки источника: ${data.source.detail}`);
      return;
    }
    for (const hook of data.source.value) {
      ctx.ui.section(`Вебхук ${maskUrl(hook.url)}`);
      ctx.ui.rows(
        [
          ['События', hook.events.join(', ')],
          ['Формат', hook.contentType],
          ['Активен', yesNo(hook.active)],
          ['Проверка TLS', hook.insecureSsl === '1' ? 'ВЫКЛЮЧЕНА' : 'включена'],
          ['Секрет', hook.hasSecret ? 'задан (значение недоступно)' : 'нет']
        ],
        4
      );
    }
    for (const item of data.skipped) ctx.ui.warn(item);
    ctx.ui.info('Секрет вебхука GitHub не отдаёт: для копии можно ввести новый.');
  },
  async plan(data, ctx) {
    const title = 'Вебхуки';
    const stage = Stage.integrations;
    if (!data.source.ok) return [{ category: title, kind: 'warn', title: `Не прочитано: ${data.source.detail}`, stage }];
    if (!data.target.ok) return [{ category: title, kind: 'warn', title: `Вебхуки цели не прочитаны: ${data.target.detail}`, stage }];
    const targetHooks = data.target.value;
    const mode = await askTransfer(ctx, 'Перенести вебхуки? События цели будут отправляться на эти адреса', { defaultSkip: true });
    if (mode === 'skip') return [{ category: title, kind: 'skip', title: 'Вебхуки пропущены', stage }];
    const chosen = await pick(ctx, mode, 'Какие вебхуки перенести?', data.source.value, (hook) => maskUrl(hook.url));
    const items: PlanItem[] = [];
    for (const hook of chosen) {
      const label = maskUrl(hook.url);
      if (!/^https?:\/\//.test(hook.url)) {
        items.push({ category: title, kind: 'warn', title: `${label}: некорректный адрес`, stage });
        continue;
      }
      const existing = targetHooks.find((item) => item.url === hook.url);
      const config: Record<string, unknown> = { url: hook.url, content_type: hook.contentType, insecure_ssl: hook.insecureSsl };
      const same = existing && sameJson({ ...existing, id: undefined, hasSecret: undefined }, { ...hook, id: undefined, hasSecret: undefined });
      if (same && !hook.hasSecret) {
        items.push({ category: title, kind: 'keep', title: `${label}: уже совпадает`, stage });
        continue;
      }
      if (existing) {
        const answer = await askConflict(ctx, `Вебхук ${label} уже есть в цели. Что сделать?`, { replace: 'Заменить настройки вебхука' });
        if (answer !== 'replace') {
          items.push({ category: title, kind: answer === 'skip' ? 'skip' : 'keep', title: `${label}: оставлен как в цели`, stage });
          continue;
        }
      }
      const details: string[] = [];
      if (hook.insecureSsl === '1') details.push('Проверка TLS выключена, как в источнике.');
      if (hook.hasSecret && !ctx.dryRun) {
        const secret = await ctx.ask.secret(`Новый секрет для ${label} (пусто — без секрета)`);
        if (secret) config.secret = secret;
        else details.push('Без секрета: получатель не сможет проверить подпись.');
      } else if (hook.hasSecret) details.push('В пробном запуске секрет не запрашивается.');
      const body = { name: 'web', active: hook.active, events: hook.events, config };
      const existingId = existing?.id;
      items.push({
        category: title,
        kind: existing ? 'update' : 'create',
        title: `${existing ? 'Заменить' : 'Создать'} вебхук ${label}`,
        details,
        risk: existing ? 'замена вебхука' : 'отправка событий цели на внешний адрес',
        stage,
        apply: async (client) => {
          if (existing) {
            if (existingId === undefined) throw new Error('Нет идентификатора вебхука в цели.');
            await client.mutate('PATCH', repoPath(ctx.target, 'hooks', existingId), { active: body.active, events: body.events, config });
          } else await client.mutate('POST', repoPath(ctx.target, 'hooks'), body);
        }
      });
    }
    return items;
  }
});

type Pages = { buildType: string; branch: string | undefined; path: string | undefined; cname: string | undefined; httpsEnforced: boolean | undefined };
export type PagesData = { source: Read<Pages | undefined>; target: Read<Pages | undefined>; branchExists: Read<boolean> | undefined };

function normalizePages(raw: unknown): Pages {
  const data = rec(raw);
  const source = rec(data.source);
  return { buildType: str(data.build_type) ?? 'legacy', branch: str(source.branch), path: str(source.path), cname: str(data.cname), httpsEnforced: bool(data.https_enforced) };
}

export const pagesCategory = category<PagesData>({
  id: 'pages',
  title: 'GitHub Pages',
  async discover(ctx) {
    // 404 means "not configured" only for an administrator; otherwise the state is unknown.
    const read = async (repo: Context['source']): Promise<Read<Pages | undefined>> => {
      const result = await attempt(() => ctx.client.getOptional(repoPath(repo, 'pages')));
      if (!result.ok) return result;
      if (result.value === undefined) return repo.permissions?.admin ? known(undefined) : missing('unknown', 'нет прав администратора для проверки');
      return known(normalizePages(result.value));
    };
    const source = await read(ctx.source);
    const target = await read(ctx.target);
    const branch = source.ok && source.value?.buildType === 'legacy' ? source.value.branch : undefined;
    const branchExists = branch ? await attempt(async () => (await ctx.client.getOptional(repoPath(ctx.target, 'branches', branch))) !== undefined) : undefined;
    return { source, target, branchExists };
  },
  empty(data) {
    return data.source.ok && !data.source.value ? 'В источнике GitHub Pages не настроен.' : undefined;
  },
  present(data, ctx) {
    if (!data.source.ok) {
      ctx.ui.warn(`GitHub Pages источника: ${data.source.detail}`);
      return;
    }
    const pages = data.source.value;
    if (!pages) return;
    ctx.ui.rows([
      ['Способ сборки', pages.buildType === 'workflow' ? 'GitHub Actions' : 'из ветки'],
      ['Ветка и каталог', pages.branch ? `${pages.branch} ${pages.path ?? '/'}` : 'не используется'],
      ['Свой домен', pages.cname ?? 'нет'],
      ['Только HTTPS', yesNo(pages.httpsEnforced)],
      ['В цели', data.target.ok ? (data.target.value ? 'настроен' : 'не настроен') : data.target.detail]
    ]);
    ctx.ui.info('Свой домен не переносится: домен может принадлежать только одному сайту.');
  },
  async plan(data, ctx) {
    const title = 'GitHub Pages';
    const stage = Stage.integrations;
    if (!data.source.ok) return [{ category: title, kind: 'warn', title: `Не прочитано: ${data.source.detail}`, stage }];
    const pages = data.source.value;
    if (!pages) return [];
    if (!data.target.ok) return [{ category: title, kind: 'warn', title: `Состояние Pages в цели неизвестно: ${data.target.detail}`, stage }];
    if (pages.buildType === 'legacy' && !(data.branchExists?.ok && data.branchExists.value)) {
      return [{ category: title, kind: 'warn', title: `Ветки ${pages.branch ?? '?'} нет в цели: Pages не настраивается`, stage }];
    }
    const body: Record<string, unknown> = { build_type: pages.buildType };
    if (pages.buildType === 'legacy') body.source = { branch: pages.branch, path: pages.path ?? '/' };
    const existing = data.target.value;
    if (existing && existing.buildType === pages.buildType && existing.branch === pages.branch && existing.path === pages.path) {
      return [{ category: title, kind: 'keep', title: 'Pages уже совпадает', stage }];
    }
    const items: PlanItem[] = [];
    if (existing) {
      const answer = await askConflict(ctx, 'GitHub Pages уже настроен в цели. Что сделать?', { replace: 'Заменить способ сборки и источник' });
      if (answer !== 'replace') return [{ category: title, kind: answer === 'skip' ? 'skip' : 'keep', title: 'Pages оставлен как в цели', stage }];
    } else if (!(await ctx.ask.confirm('Настроить GitHub Pages в цели как в источнике?', false))) {
      return [{ category: title, kind: 'skip', title: 'Pages пропущен', stage }];
    }
    items.push({
      category: title,
      kind: existing ? 'update' : 'create',
      title: `${existing ? 'Изменить' : 'Включить'} GitHub Pages (${pages.buildType === 'workflow' ? 'GitHub Actions' : `${pages.branch ?? ''} ${pages.path ?? '/'}`})`,
      risk: existing ? 'замена настроек опубликованного сайта' : 'публикация сайта из содержимого репозитория',
      stage,
      apply: async (client) => {
        await client.mutate(existing ? 'PUT' : 'POST', repoPath(ctx.target, 'pages'), body);
      }
    });
    return items;
  }
});
