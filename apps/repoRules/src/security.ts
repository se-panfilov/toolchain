import { askTransfer, pick } from '@repoRules/flow';
import { type GitHubClient, repoPath } from '@repoRules/github';
import { category, type Context, type PlanItem, Stage } from '@repoRules/plan';
import type { RepoInfo } from '@repoRules/repo';
import { attempt, known, missing, type Read, rec, stateLabel, str } from '@repoRules/state';
import { onOff } from '@repoRules/ui';

const title = 'Безопасность';

type Feature = {
  id: string;
  label: string;
  /** Why enabling the feature needs an additional confirmation, for example a paid license or Actions minutes. */
  cost?: string;
  read(client: GitHubClient, repo: RepoInfo): Promise<Read<boolean>>;
  write(client: GitHubClient, repo: RepoInfo, on: boolean): Promise<void>;
};

/** Read a security_and_analysis status from GET /repos. GitHub returns it only to administrators. */
function analysis(key: string, label: string, cost?: string): Feature {
  return {
    id: key,
    label,
    ...(cost ? { cost } : {}),
    read: (_client, repo) => {
      const block = repo.raw.security_and_analysis;
      if (block === undefined || block === null) return Promise.resolve(missing(repo.permissions?.admin ? 'unsupported' : 'forbidden'));
      const status = str(rec(rec(block)[key]).status);
      return Promise.resolve(status === 'enabled' ? known(true) : status === 'disabled' ? known(false) : missing('unsupported'));
    },
    write: async (client, repo, on) => {
      await client.mutate('PATCH', repoPath(repo), { security_and_analysis: { [key]: { status: on ? 'enabled' : 'disabled' } } });
    }
  };
}

/** Features with their own endpoint and an `enabled` field, or 204/404 for Dependabot alerts. */
export const features: readonly Feature[] = [
  {
    id: 'vulnerability_alerts',
    label: 'Dependabot alerts',
    read: (client, repo) =>
      readState(async () => {
        const status = await client.status(repoPath(repo, 'vulnerability-alerts'));
        // GitHub answers 404 both for "disabled" and for "no access". Only an administrator can trust 404.
        if (status === 404) return repo.permissions?.admin ? false : undefined;
        return status === 204;
      }),
    write: async (client, repo, on) => {
      await client.mutate(on ? 'PUT' : 'DELETE', repoPath(repo, 'vulnerability-alerts'));
    }
  },
  {
    id: 'automated_security_fixes',
    label: 'Dependabot security updates',
    read: (client, repo) => readState(async () => enabledField(await client.getOptional(repoPath(repo, 'automated-security-fixes')))),
    write: async (client, repo, on) => {
      await client.mutate(on ? 'PUT' : 'DELETE', repoPath(repo, 'automated-security-fixes'));
    }
  },
  {
    id: 'private_vulnerability_reporting',
    label: 'Частные сообщения об уязвимостях',
    read: (client, repo) => readState(async () => enabledField(await client.getOptional(repoPath(repo, 'private-vulnerability-reporting')))),
    write: async (client, repo, on) => {
      await client.mutate(on ? 'PUT' : 'DELETE', repoPath(repo, 'private-vulnerability-reporting'));
    }
  },
  analysis('advanced_security', 'GitHub Advanced Security', 'может использовать платные лицензии GitHub Advanced Security'),
  analysis('code_security', 'GitHub Code Security', 'может использовать платные лицензии GitHub Code Security'),
  analysis('secret_scanning', 'Secret scanning'),
  analysis('secret_scanning_push_protection', 'Push protection'),
  analysis('secret_scanning_non_provider_patterns', 'Поиск секретов без провайдера'),
  analysis('secret_scanning_validity_checks', 'Проверка действительности секретов'),
  {
    id: 'code_scanning_default_setup',
    label: 'Code scanning (default setup)',
    cost: 'запускает анализ в GitHub Actions и расходует минуты',
    read: (client, repo) =>
      readState(async () => {
        const data = await client.getOptional(repoPath(repo, 'code-scanning', 'default-setup'));
        if (data === undefined) return undefined;
        const state = str(rec(data).state);
        return state === 'configured' ? true : state === 'not-configured' ? false : undefined;
      }),
    write: async (client, repo, on) => {
      await client.mutate('PATCH', repoPath(repo, 'code-scanning', 'default-setup'), { state: on ? 'configured' : 'not-configured' });
    }
  }
];

function enabledField(data: unknown): boolean | undefined {
  if (data === undefined) return undefined;
  const value = rec(data).enabled;
  return typeof value === 'boolean' ? value : undefined;
}

async function readState(read: () => Promise<boolean | undefined>): Promise<Read<boolean>> {
  const result = await attempt(read);
  if (!result.ok) return result;
  return result.value === undefined ? missing('unknown') : known(result.value);
}

type FeatureState = { feature: Feature; source: Read<boolean>; target: Read<boolean> };
export type SecurityData = FeatureState[];

export async function discoverSecurity(ctx: Context): Promise<SecurityData> {
  const out: SecurityData = [];
  for (const feature of features) out.push({ feature, source: await feature.read(ctx.client, ctx.source), target: await feature.read(ctx.client, ctx.target) });
  return out;
}

function show(read: Read<boolean>): string {
  return read.ok ? onOff(read.value) : stateLabel(read.state);
}

export const securityCategory = category<SecurityData>({
  id: 'security',
  title,
  discover: discoverSecurity,
  present(data, ctx) {
    ctx.ui.section('Источник (в скобках — цель):');
    ctx.ui.rows(data.map(({ feature, source, target }) => [feature.label, `${show(source)}   [цель: ${show(target)}]`] as const));
    ctx.ui.info('Недоступная настройка не считается выключенной. Оповещения и результаты сканирования не копируются.');
  },
  async plan(data, ctx) {
    const items: PlanItem[] = [];
    // Enable only when the source value is known to be on and the target is not known to be on.
    const enable = data.filter(({ source, target }) => source.ok && source.value && !(target.ok && target.value));
    // Disable only when both values are known: source off, target on. This always needs a separate confirmation.
    const disable = data.filter(({ source, target }) => source.ok && !source.value && target.ok && target.value);
    for (const { feature, source } of data)
      if (!source.ok) items.push({ category: title, kind: 'warn', title: `${feature.label}: ${stateLabel(source.state)} в источнике, не переносится`, stage: Stage.security });
    if (!enable.length && !disable.length) {
      ctx.ui.info('Нечего включать.');
      return items;
    }
    if (enable.length) {
      const mode = await askTransfer(ctx, 'Включить в цели функции, включённые в источнике?');
      const chosen = await pick(ctx, mode, 'Какие функции включить?', enable, ({ feature }) => feature.label);
      for (const { feature, target } of chosen) {
        const details = target.ok ? [] : [`Состояние в цели: ${stateLabel(target.state)}`];
        items.push({
          category: title,
          kind: 'update',
          title: `Включить: ${feature.label}`,
          details,
          stage: Stage.security,
          apply: (client) => feature.write(client, ctx.target, true),
          ...(feature.cost ? { risk: feature.cost } : {})
        });
      }
      if (mode === 'skip') items.push({ category: title, kind: 'skip', title: 'Включение функций безопасности пропущено', stage: Stage.security });
    }
    if (disable.length) {
      ctx.ui.warn(`В цели включены функции, выключенные в источнике: ${disable.map(({ feature }) => feature.label).join(', ')}.`);
      const chosen = await pick(
        ctx,
        'select',
        'Отключить в цели? Это ослабит защиту. По умолчанию ничего не отмечено',
        disable,
        ({ feature }) => feature.label,
        () => false
      );
      for (const { feature } of chosen) {
        if (!(await ctx.ask.confirm(`Точно отключить «${feature.label}» в ${ctx.target.fullName}?`, false))) {
          items.push({ category: title, kind: 'keep', title: `${feature.label}: остаётся включённым`, stage: Stage.security });
          continue;
        }
        items.push({
          category: title,
          kind: 'update',
          title: `Отключить: ${feature.label}`,
          risk: 'отключение функции безопасности',
          stage: Stage.security,
          apply: (client) => feature.write(client, ctx.target, false)
        });
      }
    }
    return items;
  }
});
