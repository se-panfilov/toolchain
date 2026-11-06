import { askConflict, askTransfer, pick } from '@reRules/flow';
import { repoPath } from '@reRules/github';
import { category, type Context, type PlanItem, Stage } from '@reRules/plan';
import type { RepoInfo } from '@reRules/repo';
import { attempt, list, num, type Read, rec, sameJson, str, strings } from '@reRules/state';
import { plain } from '@reRules/ui';

const title = 'Наборы правил';

export type Ruleset = Record<string, unknown>;

export type RulesetsData = {
  own: Read<Ruleset[]>;
  inherited: Ruleset[];
  target: Read<Ruleset[]>;
  targetBranches: Read<string[]>;
};

/** Server-generated fields. They are never sent back. */
const serverFields = ['id', 'node_id', 'source', 'source_type', '_links', 'created_at', 'updated_at', 'current_user_can_bypass'];

export type Transformed = { payload: Ruleset; warnings: string[]; invalid: string[] };

/**
 * Make a create/update payload from a full source ruleset for the target repository.
 * Bypass actors that cannot exist in the target are removed (a removed bypass makes the ruleset stricter).
 * Rules that reference resources of the source repository are reported as invalid; the caller decides.
 */
export function transformRuleset(source: Ruleset, from: RepoInfo, to: RepoInfo, environments: ReadonlySet<string>): Transformed {
  const warnings: string[] = [];
  const invalid: string[] = [];
  const payload: Ruleset = {};
  for (const [key, value] of Object.entries(source)) if (!serverFields.includes(key)) payload[key] = value;
  const sameOwner = from.owner.toLowerCase() === to.owner.toLowerCase();
  const org = to.ownerType === 'Organization';
  const actors: unknown[] = [];
  for (const raw of list(source.bypass_actors)) {
    const actor = rec(raw);
    const type = str(actor.actor_type) ?? 'unknown';
    const id = actor.actor_id;
    const keep = (() => {
      if (type === 'RepositoryRole' || type === 'DeployKey') return true;
      if (type === 'OrganizationAdmin') return org;
      if (type === 'Team') return org && sameOwner;
      if (type === 'Integration') {
        if (sameOwner) warnings.push(`Приложение (id ${plain(id)}) в списке обхода должно быть установлено в целевом репозитории.`);
        return sameOwner;
      }
      return false;
    })();
    if (keep) actors.push({ actor_id: id ?? null, actor_type: type, bypass_mode: actor.bypass_mode ?? 'always' });
    else warnings.push(`Исключён обход для ${type} (id ${plain(id)}): недоступен в целевом репозитории. Набор станет строже.`);
  }
  payload.bypass_actors = actors;
  const conditions = rec(source.conditions);
  // Repository rulesets use only ref_name. Other conditions belong to organization rulesets.
  payload.conditions = conditions.ref_name === undefined ? {} : { ref_name: conditions.ref_name };
  for (const key of Object.keys(conditions)) if (key !== 'ref_name') invalid.push(`Условие ${key} поддерживается только в наборах правил организации.`);
  const rules: unknown[] = [];
  for (const raw of list(source.rules)) {
    const rule = rec(raw);
    const type = str(rule.type) ?? 'unknown';
    const parameters = rec(rule.parameters);
    if (type === 'required_deployments') {
      const missingEnvs = strings(parameters.required_deployment_environments).filter((name) => !environments.has(name));
      if (missingEnvs.length) invalid.push(`Правило required_deployments: в цели нет окружений ${missingEnvs.join(', ')}.`);
    }
    if (type === 'required_status_checks') {
      for (const check of list(parameters.required_status_checks)) {
        const integration = num(rec(check).integration_id);
        if (integration !== undefined) warnings.push(`Проверка ${plain(rec(check).context)} ждёт приложение (id ${integration}); оно должно работать в цели.`);
      }
    }
    if (type === 'workflows') {
      for (const workflow of list(parameters.workflows)) {
        const repositoryId = num(rec(workflow).repository_id);
        if (repositoryId === from.id) invalid.push(`Правило workflows ссылается на файл в репозитории-источнике (${plain(rec(workflow).path)}).`);
        else if (repositoryId !== undefined) warnings.push(`Правило workflows ссылается на репозиторий id ${repositoryId}; у цели должен быть доступ к нему.`);
      }
    }
    if (type === 'pull_request') {
      const reviewers = list(parameters.required_reviewers);
      if (reviewers.length && !(org && sameOwner)) invalid.push('Правило pull_request содержит обязательных рецензентов-команды, недоступных в цели.');
    }
    rules.push(raw);
  }
  payload.rules = rules;
  return { payload, warnings, invalid };
}

/** Remove invalid rules from a payload. Only the rule types that the transformation marked are removed. */
export function withoutInvalid(payload: Ruleset, source: RepoInfo, environments: ReadonlySet<string>): Ruleset {
  const rules = list(payload.rules).filter((raw) => {
    const rule = rec(raw);
    const parameters = rec(rule.parameters);
    if (rule.type === 'required_deployments') return strings(parameters.required_deployment_environments).every((name) => environments.has(name));
    if (rule.type === 'workflows') return list(parameters.workflows).every((workflow) => num(rec(workflow).repository_id) !== source.id);
    if (rule.type === 'pull_request') return list(parameters.required_reviewers).length === 0;
    return true;
  });
  return { ...payload, conditions: { ref_name: rec(payload.conditions).ref_name ?? { include: [], exclude: [] } }, rules };
}

/** The part of a ruleset that the payload controls. It is used to detect an equal target ruleset. */
export function comparable(ruleset: Ruleset): Ruleset {
  const out: Ruleset = {};
  for (const key of ['name', 'target', 'enforcement', 'conditions', 'rules']) out[key] = ruleset[key];
  out.bypass_actors = list(ruleset.bypass_actors).map((raw) => {
    const actor = rec(raw);
    return { actor_id: actor.actor_id ?? null, actor_type: actor.actor_type, bypass_mode: actor.bypass_mode };
  });
  return out;
}

function isOwn(ruleset: Ruleset, repo: RepoInfo): boolean {
  return str(ruleset.source_type) === 'Repository' && (str(ruleset.source) ?? '').toLowerCase() === repo.fullName.toLowerCase();
}

async function details(ctx: Context, repo: RepoInfo, summaries: unknown[]): Promise<Ruleset[]> {
  const out: Ruleset[] = [];
  for (const summary of summaries) {
    const id = num(rec(summary).id);
    if (id === undefined) continue;
    out.push(rec(await ctx.client.get(repoPath(repo, 'rulesets', id))));
  }
  return out;
}

export async function discoverRulesets(ctx: Context): Promise<RulesetsData> {
  const { client, source, target } = ctx;
  const all = await attempt(() => client.paginate(repoPath(source, 'rulesets'), { includes_parents: true }), 'unsupported');
  const own = all.ok
    ? await attempt(() =>
        details(
          ctx,
          source,
          all.value.filter((item) => isOwn(rec(item), source))
        )
      )
    : all;
  const inherited = all.ok ? all.value.map(rec).filter((item) => !isOwn(item, source)) : [];
  const targetList = await attempt(() => client.paginate(repoPath(target, 'rulesets'), { includes_parents: false }), 'unsupported');
  const targetFull = targetList.ok
    ? await attempt(() =>
        details(
          ctx,
          target,
          targetList.value.filter((item) => isOwn(rec(item), target))
        )
      )
    : targetList;
  const targetBranches = await attempt(async () => (await client.paginate(repoPath(target, 'branches'))).map((item) => str(rec(item).name) ?? ''));
  return { own, inherited, target: targetFull, targetBranches };
}

function describeRules(ruleset: Ruleset): string[] {
  const lines: string[] = [];
  const ref = rec(rec(ruleset.conditions).ref_name);
  lines.push(`Цель: ${plain(ruleset.target)}`, `Режим: ${plain(ruleset.enforcement)}`);
  lines.push(`Включить: ${plain(strings(ref.include))}`);
  if (strings(ref.exclude).length) lines.push(`Исключить: ${plain(strings(ref.exclude))}`);
  for (const raw of list(ruleset.rules)) {
    const rule = rec(raw);
    const parameters = rec(rule.parameters);
    const type = str(rule.type) ?? '?';
    if (type === 'pull_request') {
      lines.push(`Pull request: да, одобрений ${plain(parameters.required_approving_review_count)}, code owners ${plain(parameters.require_code_owner_review)}`);
    } else if (type === 'required_status_checks') {
      lines.push(`Обязательные проверки: ${plain(list(parameters.required_status_checks).map((check) => rec(check).context))}`);
    } else if (type === 'non_fast_forward') lines.push('Запрет force push: да');
    else if (type === 'deletion') lines.push('Запрет удаления: да');
    else if (type === 'required_signatures') lines.push('Подписанные коммиты: да');
    else if (type === 'required_linear_history') lines.push('Линейная история: да');
    else lines.push(`Правило ${type}${Object.keys(parameters).length ? `: ${JSON.stringify(parameters)}` : ''}`);
  }
  const actors = list(ruleset.bypass_actors);
  if (actors.length) lines.push(`Обход: ${actors.map((raw) => `${plain(rec(raw).actor_type)}#${plain(rec(raw).actor_id)}`).join(', ')}`);
  return lines;
}

export const rulesetsCategory = category<RulesetsData>({
  id: 'rulesets',
  title,
  discover: discoverRulesets,
  empty(data) {
    if (data.own.ok && data.own.value.length === 0 && data.inherited.length === 0) return 'В источнике нет наборов правил.';
    return undefined;
  },
  present(data, ctx) {
    const { ui } = ctx;
    if (!data.own.ok) {
      ui.warn(`Наборы правил источника: ${data.own.detail || data.own.state}`);
      return;
    }
    ui.section(`Наборы правил репозитория: ${data.own.value.length}`);
    data.own.value.forEach((ruleset, index) => {
      ui.line();
      ui.text(`${index + 1}. ${plain(ruleset.name)}`);
      for (const line of describeRules(ruleset)) ui.text(line, 5);
    });
    if (data.inherited.length) {
      ui.section('Унаследованы от организации (не переносятся):');
      for (const ruleset of data.inherited) ui.text(`${plain(ruleset.name)} — ${plain(ruleset.source)}`, 4);
    }
  },
  async plan(data, ctx) {
    const items: PlanItem[] = [];
    if (!data.own.ok || data.own.value.length === 0) {
      if (!data.own.ok) items.push({ category: title, kind: 'warn', title: `Наборы правил не прочитаны: ${data.own.detail}`, stage: Stage.rulesets });
      return items;
    }
    if (!data.target.ok) {
      items.push({ category: title, kind: 'warn', title: `Наборы правил цели не прочитаны: ${data.target.detail}. Перенос невозможен без проверки дубликатов.`, stage: Stage.rulesets });
      return items;
    }
    const mode = await askTransfer(ctx, 'Перенести наборы правил?', { json: data.own.value });
    if (mode === 'skip') return [{ category: title, kind: 'skip', title: 'Наборы правил пропущены', stage: Stage.rulesets }];
    const chosen = await pick(ctx, mode, 'Какие наборы правил перенести?', data.own.value, (ruleset) => `${plain(ruleset.name)} (${plain(ruleset.target)})`);
    const existing = data.target.value;
    const branches = data.targetBranches.ok ? new Set(data.targetBranches.value) : undefined;
    for (const ruleset of chosen) {
      const name = str(ruleset.name) ?? '?';
      const result = transformRuleset(ruleset, ctx.source, ctx.target, ctx.targetEnvironments);
      let payload = result.payload;
      const details = [...result.warnings];
      if (branches && ruleset.target === 'branch') {
        for (const include of strings(rec(rec(ruleset.conditions).ref_name).include)) {
          const branch = include.startsWith('refs/heads/') ? include.slice('refs/heads/'.length) : undefined;
          if (branch && !/[*?[\]]/.test(branch) && !branches.has(branch)) details.push(`Ветки ${branch} нет в цели; правило начнёт действовать, когда она появится.`);
        }
      }
      if (result.invalid.length) {
        for (const reason of result.invalid) ctx.ui.warn(`${name}: ${reason}`);
        const drop = await ctx.ask.confirm(`Перенести «${name}» без недопустимых правил? Набор будет слабее источника.`, false);
        if (!drop) {
          items.push({ category: title, kind: 'warn', title: `Пропущен набор «${name}»: недопустимые правила`, details: result.invalid, stage: Stage.rulesets });
          continue;
        }
        payload = withoutInvalid(payload, ctx.source, ctx.targetEnvironments);
        details.push(...result.invalid.map((reason) => `Исключено: ${reason}`));
      }
      const match = existing.find((item) => item.name === ruleset.name && item.target === ruleset.target);
      if (match) {
        if (sameJson(comparable(match), comparable(payload))) {
          items.push({ category: title, kind: 'keep', title: `Набор «${name}» уже совпадает`, stage: Stage.rulesets });
          continue;
        }
        const answer = await askConflict(ctx, `В цели уже есть набор «${name}». Что сделать?`, { replace: 'Заменить настройками источника' });
        if (answer !== 'replace') {
          items.push({ category: title, kind: answer === 'skip' ? 'skip' : 'keep', title: `Набор «${name}» оставлен как в цели`, stage: Stage.rulesets });
          continue;
        }
        const id = num(match.id);
        items.push({
          category: title,
          kind: 'update',
          title: `Заменить набор правил «${name}»`,
          details,
          risk: 'замена может ослабить существующие правила цели',
          stage: Stage.rulesets,
          apply: async (client) => {
            if (id === undefined) throw new Error('Нет идентификатора набора правил в цели.');
            await client.mutate('PUT', repoPath(ctx.target, 'rulesets', id), payload);
          }
        });
        continue;
      }
      items.push({
        category: title,
        kind: 'create',
        title: `Создать набор правил «${name}»`,
        details,
        stage: Stage.rulesets,
        apply: async (client) => {
          // A rerun after a partial failure must not create a duplicate. Check the current list just before the write.
          const current = (await client.paginate(repoPath(ctx.target, 'rulesets'), { includes_parents: false })).map(rec);
          if (current.some((item) => item.name === ruleset.name && item.target === ruleset.target && isOwn(item, ctx.target))) {
            throw new Error('Набор с таким именем уже появился в цели. Запустите программу снова.');
          }
          await client.mutate('POST', repoPath(ctx.target, 'rulesets'), payload);
        }
      });
    }
    return items;
  }
});
