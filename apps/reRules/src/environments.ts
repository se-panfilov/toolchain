import { askConflict, askTransfer, pick } from '@reRules/flow';
import { apiPath, type GitHubClient, repoPath } from '@reRules/github';
import { category, type Context, type PlanItem, Stage } from '@reRules/plan';
import type { RepoInfo } from '@reRules/repo';
import { attempt, bool, list, num, type Read, rec, sameJson, str } from '@reRules/state';
import { plain, yesNo } from '@reRules/ui';

const title = 'Окружения';

type Reviewer = { type: 'User' | 'Team'; id: number; name: string };
type BranchPolicy = { name: string; type: string };

export type Environment = {
  name: string;
  waitTimer: number | undefined;
  preventSelfReview: boolean | undefined;
  reviewers: Reviewer[];
  branchPolicy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
  customPolicies: BranchPolicy[];
  canAdminsBypass: boolean | undefined;
  /** Protection rules that this tool cannot reproduce, for example custom deployment protection rules of apps. */
  unsupported: string[];
};

export type EnvironmentsData = { source: Read<Environment[]>; target: Read<Environment[]> };

/** Normalize one environment from GET .../environments. */
export function normalizeEnvironment(raw: unknown): Environment {
  const data = rec(raw);
  const env: Environment = {
    name: str(data.name) ?? '',
    waitTimer: undefined,
    preventSelfReview: undefined,
    reviewers: [],
    branchPolicy: null,
    customPolicies: [],
    canAdminsBypass: bool(data.can_admins_bypass),
    unsupported: []
  };
  for (const ruleRaw of list(data.protection_rules)) {
    const rule = rec(ruleRaw);
    const type = str(rule.type);
    if (type === 'wait_timer') env.waitTimer = num(rule.wait_timer);
    else if (type === 'required_reviewers') {
      env.preventSelfReview = bool(rule.prevent_self_review);
      for (const item of list(rule.reviewers)) {
        const reviewerType = str(rec(item).type);
        const reviewer = rec(rec(item).reviewer);
        const id = num(reviewer.id);
        if ((reviewerType === 'User' || reviewerType === 'Team') && id !== undefined) {
          env.reviewers.push({ type: reviewerType, id, name: str(reviewer.login) ?? str(reviewer.slug) ?? String(id) });
        }
      }
    } else if (type === 'branch_policy') {
      /* Described by deployment_branch_policy. */
    } else env.unsupported.push(`правило защиты ${type ?? '?'}`);
  }
  const policy = data.deployment_branch_policy;
  if (policy !== null && policy !== undefined) {
    env.branchPolicy = { protected_branches: rec(policy).protected_branches === true, custom_branch_policies: rec(policy).custom_branch_policies === true };
  }
  return env;
}

async function readEnvironments(client: GitHubClient, repo: RepoInfo): Promise<Environment[]> {
  const items = await client.paginate(repoPath(repo, 'environments'), {}, 'environments');
  const out: Environment[] = [];
  for (const raw of items) {
    const env = normalizeEnvironment(raw);
    if (!env.name) continue;
    if (env.branchPolicy?.custom_branch_policies) {
      env.customPolicies = (await client.paginate(repoPath(repo, 'environments', env.name, 'deployment-branch-policies'), {}, 'branch_policies')).map((item) => ({
        name: str(rec(item).name) ?? '',
        type: str(rec(item).type) ?? 'branch'
      }));
    }
    const custom = await client.getOptional(repoPath(repo, 'environments', env.name, 'deployment_protection_rules'));
    for (const rule of list(rec(custom).custom_deployment_protection_rules)) {
      env.unsupported.push(`правило приложения ${plain(rec(rec(rule).app).slug)}`);
    }
    out.push(env);
  }
  return out;
}

export async function discoverEnvironments(ctx: Context): Promise<EnvironmentsData> {
  const source = await attempt(() => readEnvironments(ctx.client, ctx.source));
  const target = await attempt(() => readEnvironments(ctx.client, ctx.target));
  if (target.ok) for (const env of target.value) ctx.targetEnvironments.add(env.name);
  return { source, target };
}

/** Check that a reviewer can exist in the target: a user with access, or a team of the target organization. */
export async function reviewerValid(client: GitHubClient, target: RepoInfo, reviewer: Reviewer): Promise<boolean> {
  if (reviewer.type === 'User') {
    if (reviewer.name.toLowerCase() === target.owner.toLowerCase()) return true;
    return (await client.status(repoPath(target, 'collaborators', reviewer.name))) !== 404;
  }
  if (target.ownerType !== 'Organization') return false;
  const team = await client.getOptional(apiPath('orgs', target.owner, 'teams', reviewer.name));
  return num(rec(team).id) === reviewer.id;
}

/** The PUT body for an environment. */
export function environmentBody(env: Environment, reviewers: Reviewer[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    wait_timer: env.waitTimer ?? 0,
    reviewers: reviewers.map((reviewer) => ({ type: reviewer.type, id: reviewer.id })),
    deployment_branch_policy: env.branchPolicy
  };
  if (env.preventSelfReview !== undefined) body.prevent_self_review = env.preventSelfReview;
  if (env.canAdminsBypass !== undefined) body.can_admins_bypass = env.canAdminsBypass;
  return body;
}

function describe(env: Environment): string[] {
  return [
    `Рецензенты: ${env.reviewers.map((reviewer) => `${reviewer.name} (${reviewer.type})`).join(', ') || 'нет'}`,
    `Запрет одобрять свой деплой: ${yesNo(env.preventSelfReview)}`,
    `Таймер ожидания: ${env.waitTimer === undefined ? 'нет' : `${env.waitTimer} мин`}`,
    `Ветки для деплоя: ${env.branchPolicy ? (env.branchPolicy.protected_branches ? 'только защищённые' : `выбранные: ${env.customPolicies.map((policy) => `${policy.name} (${policy.type})`).join(', ') || 'нет'}`) : 'все'}`,
    `Обход администраторами: ${yesNo(env.canAdminsBypass)}`,
    ...env.unsupported.map((item) => `Не переносится: ${item}`)
  ];
}

export const environmentsCategory = category<EnvironmentsData>({
  id: 'environments',
  title,
  discover: discoverEnvironments,
  empty(data) {
    return data.source.ok && data.source.value.length === 0 ? 'В источнике нет окружений.' : undefined;
  },
  present(data, ctx) {
    if (!data.source.ok) {
      ctx.ui.warn(`Окружения источника: ${data.source.detail}`);
      return;
    }
    for (const env of data.source.value) {
      ctx.ui.section(`Окружение ${env.name}`);
      for (const line of describe(env)) ctx.ui.text(line, 4);
    }
    ctx.ui.info('Секреты и переменные окружений переносятся в отдельных категориях.');
  },
  async plan(data, ctx) {
    if (!data.source.ok) return [{ category: title, kind: 'warn', title: `Окружения не прочитаны: ${data.source.detail}`, stage: Stage.environments }];
    if (!data.target.ok) return [{ category: title, kind: 'warn', title: `Окружения цели не прочитаны: ${data.target.detail}`, stage: Stage.environments }];
    const mode = await askTransfer(ctx, 'Перенести окружения?', { json: data.source.value });
    if (mode === 'skip') return [{ category: title, kind: 'skip', title: 'Окружения пропущены', stage: Stage.environments }];
    const chosen = await pick(ctx, mode, 'Какие окружения перенести?', data.source.value, (env) => env.name);
    const items: PlanItem[] = [];
    for (const env of chosen)
      items.push(
        ...(await planEnvironment(
          ctx,
          env,
          data.target.value.find((item) => item.name.toLowerCase() === env.name.toLowerCase())
        ))
      );
    return items;
  }
});

async function planEnvironment(ctx: Context, env: Environment, existing: Environment | undefined): Promise<PlanItem[]> {
  const reviewers: Reviewer[] = [];
  const lost: string[] = [...env.unsupported];
  for (const reviewer of env.reviewers) {
    const valid = await attempt(() => reviewerValid(ctx.client, ctx.target, reviewer));
    if (valid.ok && valid.value) reviewers.push(reviewer);
    else lost.push(`рецензент ${reviewer.name} (${reviewer.type}) недоступен в цели`);
  }
  const body = environmentBody(env, reviewers);
  if (lost.length) {
    for (const reason of lost) ctx.ui.warn(`${env.name}: ${reason}`);
    if (!(await ctx.ask.confirm(`Создать «${env.name}» без этих правил? Окружение будет слабее источника.`, false))) {
      return [{ category: title, kind: 'warn', title: `Окружение ${env.name} пропущено: правила защиты нельзя воспроизвести`, details: lost, stage: Stage.environments }];
    }
  }
  const items: PlanItem[] = [];
  const details = lost.map((reason) => `Не воспроизводится: ${reason}`);
  if (existing) {
    const same = sameJson(environmentBody(existing, existing.reviewers), body) && env.customPolicies.every((policy) => existing.customPolicies.some((item) => sameJson(item, policy)));
    if (same) return [{ category: title, kind: 'keep', title: `Окружение ${env.name} уже совпадает`, stage: Stage.environments }];
    const answer = await askConflict(ctx, `Окружение ${env.name} уже есть в цели. Что сделать?`, { replace: 'Заменить правила защиты значениями источника' });
    if (answer !== 'replace') return [{ category: title, kind: answer === 'skip' ? 'skip' : 'keep', title: `Окружение ${env.name} оставлено как в цели`, stage: Stage.environments }];
  }
  ctx.targetEnvironments.add(env.name);
  items.push({
    category: title,
    kind: existing ? 'update' : 'create',
    title: `${existing ? 'Обновить' : 'Создать'} окружение ${env.name}`,
    details,
    ...(existing ? { risk: 'замена правил защиты окружения' } : {}),
    stage: Stage.environments,
    apply: async (client) => {
      await client.mutate('PUT', repoPath(ctx.target, 'environments', env.name), body);
    }
  });
  const missingPolicies = env.customPolicies.filter((policy) => !existing?.customPolicies.some((item) => item.name === policy.name && item.type === policy.type));
  for (const policy of missingPolicies) {
    items.push({
      category: title,
      kind: 'create',
      title: `Окружение ${env.name}: разрешить деплой из ${policy.type === 'tag' ? 'тега' : 'ветки'} ${policy.name}`,
      stage: Stage.environments,
      apply: async (client) => {
        await client.mutate('POST', repoPath(ctx.target, 'environments', env.name, 'deployment-branch-policies'), { name: policy.name, type: policy.type });
      }
    });
  }
  return items;
}
