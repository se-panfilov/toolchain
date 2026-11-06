import { askConflict, askTransfer, pick } from '@repoRules/flow';
import { type GitHubClient, repoPath } from '@repoRules/github';
import { category, type Context, type PlanItem, Stage } from '@repoRules/plan';
import type { RepoInfo } from '@repoRules/repo';
import { attempt, list, num, type Read, rec, sameJson, str } from '@repoRules/state';
import { yesNo } from '@repoRules/ui';

const title = 'Защита веток';

type Actors = { users: string[]; teams: string[]; apps: string[] };
type Reviews = { dismissStale: boolean; codeOwners: boolean; count: number; lastPush: boolean; dismissal: Actors | null; bypass: Actors | null };

/** A normalized legacy branch protection. Null means "not required". */
export type Protection = {
  checks: { strict: boolean; checks: { context: string; app_id: number | null }[] } | null;
  enforceAdmins: boolean;
  reviews: Reviews | null;
  restrictions: Actors | null;
  linearHistory: boolean;
  allowForcePushes: boolean;
  allowDeletions: boolean;
  blockCreations: boolean;
  conversationResolution: boolean;
  lockBranch: boolean;
  allowForkSyncing: boolean;
  signatures: boolean;
};

export type ProtectionKey = keyof Protection;

export const protectionFields: readonly { key: ProtectionKey; label: string }[] = [
  { key: 'reviews', label: 'Обязательные ревью pull request' },
  { key: 'checks', label: 'Обязательные проверки статуса' },
  { key: 'enforceAdmins', label: 'Правила и для администраторов' },
  { key: 'restrictions', label: 'Ограничение push (пользователи, команды, приложения)' },
  { key: 'linearHistory', label: 'Линейная история' },
  { key: 'allowForcePushes', label: 'Разрешить force push' },
  { key: 'allowDeletions', label: 'Разрешить удаление ветки' },
  { key: 'blockCreations', label: 'Запретить создание подходящих веток' },
  { key: 'conversationResolution', label: 'Обязательное разрешение обсуждений' },
  { key: 'lockBranch', label: 'Ветка только для чтения' },
  { key: 'allowForkSyncing', label: 'Синхронизация форков для закрытой ветки' },
  { key: 'signatures', label: 'Подписанные коммиты' }
];

export const unprotected: Protection = {
  checks: null,
  enforceAdmins: false,
  reviews: null,
  restrictions: null,
  linearHistory: false,
  allowForcePushes: false,
  allowDeletions: false,
  blockCreations: false,
  conversationResolution: false,
  lockBranch: false,
  allowForkSyncing: false,
  signatures: false
};

function enabled(value: unknown): boolean {
  return rec(value).enabled === true;
}

function actors(value: unknown): Actors | null {
  if (value === undefined || value === null) return null;
  const data = rec(value);
  return {
    users: list(data.users).flatMap((item) => str(rec(item).login) ?? []),
    teams: list(data.teams).flatMap((item) => str(rec(item).slug) ?? []),
    apps: list(data.apps).flatMap((item) => str(rec(item).slug) ?? [])
  };
}

/** Normalize the GET .../branches/{branch}/protection response. */
export function normalizeProtection(raw: unknown): Protection {
  const data = rec(raw);
  const checks = data.required_status_checks === undefined ? null : rec(data.required_status_checks);
  const reviews = data.required_pull_request_reviews === undefined ? null : rec(data.required_pull_request_reviews);
  return {
    checks: checks
      ? {
          strict: checks.strict === true,
          checks: list(checks.checks).length
            ? list(checks.checks).map((item) => ({ context: str(rec(item).context) ?? '', app_id: num(rec(item).app_id) ?? null }))
            : list(checks.contexts).flatMap((context) => (typeof context === 'string' ? [{ context, app_id: null }] : []))
        }
      : null,
    enforceAdmins: enabled(data.enforce_admins),
    reviews: reviews
      ? {
          dismissStale: reviews.dismiss_stale_reviews === true,
          codeOwners: reviews.require_code_owner_reviews === true,
          count: num(reviews.required_approving_review_count) ?? 0,
          lastPush: reviews.require_last_push_approval === true,
          dismissal: actors(reviews.dismissal_restrictions),
          bypass: actors(reviews.bypass_pull_request_allowances)
        }
      : null,
    restrictions: actors(data.restrictions),
    linearHistory: enabled(data.required_linear_history),
    allowForcePushes: enabled(data.allow_force_pushes),
    allowDeletions: enabled(data.allow_deletions),
    blockCreations: enabled(data.block_creations),
    conversationResolution: enabled(data.required_conversation_resolution),
    lockBranch: enabled(data.lock_branch),
    allowForkSyncing: enabled(data.allow_fork_syncing),
    signatures: enabled(data.required_signatures)
  };
}

const looser: Record<ProtectionKey, 'trueIsLooser' | 'trueIsStricter' | 'object'> = {
  checks: 'object',
  enforceAdmins: 'trueIsStricter',
  reviews: 'object',
  restrictions: 'object',
  linearHistory: 'trueIsStricter',
  allowForcePushes: 'trueIsLooser',
  allowDeletions: 'trueIsLooser',
  blockCreations: 'trueIsStricter',
  conversationResolution: 'trueIsStricter',
  lockBranch: 'trueIsStricter',
  allowForkSyncing: 'trueIsLooser',
  signatures: 'trueIsStricter'
};

/** The stricter of two values for one field. */
function stricter<K extends ProtectionKey>(key: K, a: Protection[K], b: Protection[K]): Protection[K] {
  const kind = looser[key];
  if (kind === 'trueIsStricter') return (Boolean(a) || Boolean(b)) as Protection[K];
  if (kind === 'trueIsLooser') return (Boolean(a) && Boolean(b)) as Protection[K];
  if (a === null) return b;
  if (b === null) return a;
  if (key === 'checks') {
    const x = a as Protection['checks'];
    const y = b as Protection['checks'];
    if (!x || !y) return a;
    const contexts = new Map([...x.checks, ...y.checks].map((check) => [check.context, check]));
    return { strict: x.strict || y.strict, checks: [...contexts.values()] } as Protection[K];
  }
  if (key === 'reviews') {
    const x = a as Reviews;
    const y = b as Reviews;
    // Actor lists of the target stay: a merge must not give new people the right to dismiss or bypass reviews.
    return {
      dismissStale: x.dismissStale || y.dismissStale,
      codeOwners: x.codeOwners || y.codeOwners,
      count: Math.max(x.count, y.count),
      lastPush: x.lastPush || y.lastPush,
      dismissal: x.dismissal,
      bypass: x.bypass
    } as Protection[K];
  }
  // Push restrictions: keep the target list, so the set of people who can push does not grow.
  return a;
}

/** Fields where the result is weaker than the current target protection. */
export function weakenedFields(current: Protection, next: Protection): ProtectionKey[] {
  return protectionFields
    .map(({ key }) => key)
    .filter((key) => {
      const a = current[key];
      const b = next[key];
      if (sameJson(a, b)) return false;
      if (looser[key] === 'trueIsStricter') return a === true && b === false;
      if (looser[key] === 'trueIsLooser') return a === false && b === true;
      if (b === null) return a !== null;
      if (a === null) return false;
      if (key === 'checks') {
        const x = a as NonNullable<Protection['checks']>;
        const y = b as NonNullable<Protection['checks']>;
        return (x.strict && !y.strict) || x.checks.some((check) => !y.checks.some((other) => other.context === check.context));
      }
      if (key === 'reviews') {
        const x = a as Reviews;
        const y = b as Reviews;
        return (
          (x.dismissStale && !y.dismissStale) ||
          (x.codeOwners && !y.codeOwners) ||
          x.count > y.count ||
          (x.lastPush && !y.lastPush) ||
          !sameJson(x.bypass, y.bypass) ||
          !sameJson(x.dismissal, y.dismissal)
        );
      }
      return !sameJson(a, b);
    });
}

/**
 * Combine the target protection with the selected source fields.
 * `replace` takes the source value; `merge` takes the stricter value. Fields that are not selected keep the target value.
 */
export function combine(current: Protection, source: Protection, selected: ReadonlySet<ProtectionKey>, mode: 'merge' | 'replace'): Protection {
  const next: Protection = { ...current };
  for (const { key } of protectionFields) {
    if (!selected.has(key)) continue;
    (next as Record<ProtectionKey, unknown>)[key] = mode === 'replace' ? source[key] : stricter(key, current[key], source[key]);
  }
  return next;
}

/** Adapt actor lists to the target. Personal repositories cannot have them; another owner does not have the same users and teams. */
export function adaptActors(protection: Protection, from: RepoInfo, to: RepoInfo): { protection: Protection; warnings: string[] } {
  const warnings: string[] = [];
  const next: Protection = { ...protection, reviews: protection.reviews ? { ...protection.reviews } : null };
  const sameOrg = to.ownerType === 'Organization' && from.owner.toLowerCase() === to.owner.toLowerCase();
  const empty: Actors = { users: [], teams: [], apps: [] };
  const hasActors = (value: Actors | null): boolean => Boolean(value && (value.users.length || value.teams.length || value.apps.length));
  if (to.ownerType !== 'Organization') {
    if (next.restrictions) warnings.push('Ограничение push доступно только в репозиториях организаций: не переносится.');
    next.restrictions = null;
    if (next.reviews) {
      if (hasActors(next.reviews.dismissal) || hasActors(next.reviews.bypass)) warnings.push('Списки тех, кто может отклонять или обходить ревью, есть только в организациях: не переносятся.');
      next.reviews.dismissal = null;
      next.reviews.bypass = null;
    }
  } else if (!sameOrg) {
    if (hasActors(next.restrictions)) warnings.push('Пользователи и команды из ограничения push не переносятся в другую организацию: push разрешён только администраторам.');
    if (next.restrictions) next.restrictions = empty;
    if (next.reviews && (hasActors(next.reviews.dismissal) || hasActors(next.reviews.bypass))) {
      warnings.push('Списки отклонения и обхода ревью не переносятся в другую организацию.');
      next.reviews.dismissal = next.reviews.dismissal ? empty : null;
      next.reviews.bypass = next.reviews.bypass ? empty : null;
    }
  }
  for (const check of next.checks?.checks ?? []) {
    if (check.app_id !== null && check.app_id !== -1) warnings.push(`Проверка ${check.context} ждёт приложение (id ${check.app_id}); оно должно работать в цели.`);
  }
  return { protection: next, warnings };
}

/** The body for PUT .../branches/{branch}/protection. Signatures use a separate endpoint. */
export function protectionBody(protection: Protection, org: boolean): Record<string, unknown> {
  const reviews = protection.reviews;
  const reviewsBody: Record<string, unknown> | null = reviews
    ? {
        dismiss_stale_reviews: reviews.dismissStale,
        require_code_owner_reviews: reviews.codeOwners,
        required_approving_review_count: reviews.count,
        require_last_push_approval: reviews.lastPush
      }
    : null;
  if (reviewsBody && org && reviews?.dismissal) reviewsBody.dismissal_restrictions = reviews.dismissal;
  if (reviewsBody && org && reviews?.bypass) reviewsBody.bypass_pull_request_allowances = reviews.bypass;
  return {
    required_status_checks: protection.checks
      ? { strict: protection.checks.strict, checks: protection.checks.checks.map((check) => (check.app_id === null ? { context: check.context } : check)) }
      : null,
    enforce_admins: protection.enforceAdmins,
    required_pull_request_reviews: reviewsBody,
    restrictions: org ? protection.restrictions : null,
    required_linear_history: protection.linearHistory,
    allow_force_pushes: protection.allowForcePushes,
    allow_deletions: protection.allowDeletions,
    block_creations: protection.blockCreations,
    required_conversation_resolution: protection.conversationResolution,
    lock_branch: protection.lockBranch,
    allow_fork_syncing: protection.allowForkSyncing
  };
}

type BranchState = { name: string; source: Protection; target: Read<{ exists: boolean; protection: Protection | null }> };
export type ProtectionData = Read<BranchState[]>;

async function targetState(client: GitHubClient, target: RepoInfo, branch: string): Promise<{ exists: boolean; protection: Protection | null }> {
  const info = await client.getOptional(repoPath(target, 'branches', branch));
  if (info === undefined) return { exists: false, protection: null };
  if (rec(info).protected !== true) return { exists: true, protection: null };
  return { exists: true, protection: normalizeProtection(await client.get(repoPath(target, 'branches', branch, 'protection'))) };
}

export async function discoverProtection(ctx: Context): Promise<ProtectionData> {
  const { client, source, target } = ctx;
  return attempt(async () => {
    const branches = (await client.paginate(repoPath(source, 'branches'), { protected: true })).flatMap((item) => str(rec(item).name) ?? []);
    const out: BranchState[] = [];
    for (const name of branches) {
      const protection = normalizeProtection(await client.get(repoPath(source, 'branches', name, 'protection')));
      out.push({ name, source: protection, target: await attempt(() => targetState(client, target, name)) });
    }
    return out;
  }, 'unsupported');
}

function describe(protection: Protection): [string, string][] {
  const reviews = protection.reviews;
  return [
    ['Обязательные ревью', reviews ? `да, одобрений ${reviews.count}, code owners ${yesNo(reviews.codeOwners)}, сброс при push ${yesNo(reviews.dismissStale)}` : 'нет'],
    ['Проверки статуса', protection.checks ? `${protection.checks.checks.map((check) => check.context).join(', ') || '(без списка)'}; ветка актуальна: ${yesNo(protection.checks.strict)}` : 'нет'],
    ['Для администраторов', yesNo(protection.enforceAdmins)],
    ['Ограничение push', protection.restrictions ? [...protection.restrictions.users, ...protection.restrictions.teams, ...protection.restrictions.apps].join(', ') || 'только администраторы' : 'нет'],
    ['Линейная история', yesNo(protection.linearHistory)],
    ['Force push разрешён', yesNo(protection.allowForcePushes)],
    ['Удаление разрешено', yesNo(protection.allowDeletions)],
    ['Разрешение обсуждений', yesNo(protection.conversationResolution)],
    ['Подписанные коммиты', yesNo(protection.signatures)],
    ['Только чтение', yesNo(protection.lockBranch)]
  ];
}

export const protectionCategory = category<ProtectionData>({
  id: 'protection',
  title,
  discover: discoverProtection,
  empty(data) {
    return data.ok && data.value.length === 0 ? 'В источнике нет защищённых веток (классическая защита).' : undefined;
  },
  present(data, ctx) {
    const { ui } = ctx;
    if (!data.ok) {
      ui.warn(`Защита веток источника: ${data.detail || data.state}`);
      return;
    }
    for (const branch of data.value) {
      ui.section(`Ветка ${branch.name}`);
      ui.rows(describe(branch.source), 4);
      if (!branch.target.ok) ui.warn(`Цель: ${branch.target.detail}`);
      else if (!branch.target.value.exists) ui.warn(`В цели нет ветки ${branch.name}.`);
      else ui.info(branch.target.value.protection ? 'В цели ветка уже защищена.' : 'В цели ветка не защищена.');
    }
    ui.info('Защита по шаблонам имён видна только через совпадающие ветки; переносится как защита конкретной ветки.');
  },
  async plan(data, ctx) {
    if (!data.ok) return [{ category: title, kind: 'warn', title: `Защита веток не прочитана: ${data.detail}`, stage: Stage.protection }];
    const mode = await askTransfer(ctx, 'Перенести защиту веток?', { json: data.value.map((branch) => ({ branch: branch.name, protection: branch.source })) });
    if (mode === 'skip') return [{ category: title, kind: 'skip', title: 'Защита веток пропущена', stage: Stage.protection }];
    const items: PlanItem[] = [];
    const branches = await pick(ctx, mode, 'Какие ветки?', data.value, (branch) => branch.name);
    for (const branch of branches) items.push(...(await planBranch(ctx, branch, mode === 'select')));
    return items;
  }
});

async function planBranch(ctx: Context, branch: BranchState, chooseFields: boolean): Promise<PlanItem[]> {
  const label = `Ветка ${branch.name}`;
  if (!branch.target.ok) return [{ category: title, kind: 'warn', title: `${label}: состояние в цели неизвестно (${branch.target.detail})`, stage: Stage.protection }];
  if (!branch.target.value.exists) return [{ category: title, kind: 'warn', title: `${label}: ветки нет в цели, защита не создаётся`, stage: Stage.protection }];
  const current = branch.target.value.protection;
  const fields = chooseFields ? await pick(ctx, 'select', `${label}: какие параметры перенести?`, protectionFields, (field) => field.label) : protectionFields;
  const selected = new Set(fields.map((field) => field.key));
  if (!selected.size) return [{ category: title, kind: 'skip', title: `${label}: параметры не выбраны`, stage: Stage.protection }];
  let modeChoice: 'merge' | 'replace' = 'replace';
  if (current) {
    const answer = await askConflict(ctx, `${label}: в цели уже есть защита. Что сделать?`, {
      merge: 'Объединить, сохраняя более строгие значения',
      replace: 'Заменить выбранные параметры значениями источника'
    });
    if (answer === 'keep' || answer === 'skip') return [{ category: title, kind: answer, title: `${label}: защита оставлена как в цели`, stage: Stage.protection }];
    modeChoice = answer === 'merge' ? 'merge' : 'replace';
  }
  const { protection: adapted, warnings } = adaptActors(branch.source, ctx.source, ctx.target);
  const base = current ?? unprotected;
  const next = combine(base, adapted, selected, modeChoice);
  if (current && sameJson(current, next)) return [{ category: title, kind: 'keep', title: `${label}: защита уже совпадает`, stage: Stage.protection }];
  const weakened = current ? weakenedFields(current, next) : [];
  const details = [...warnings];
  if (weakened.length) details.push(`Ослабляется: ${weakened.map((key) => protectionFields.find((field) => field.key === key)?.label ?? key).join(', ')}`);
  const org = ctx.target.ownerType === 'Organization';
  const body = protectionBody(next, org);
  const signatures = next.signatures !== (current?.signatures ?? false) ? next.signatures : undefined;
  const item: PlanItem = {
    category: title,
    kind: current ? 'update' : 'create',
    title: `${current ? 'Обновить' : 'Создать'} защиту ветки ${branch.name}`,
    details,
    stage: Stage.protection,
    apply: async (client) => {
      await client.mutate('PUT', repoPath(ctx.target, 'branches', branch.name, 'protection'), body);
      if (signatures === true) await client.mutate('POST', repoPath(ctx.target, 'branches', branch.name, 'protection', 'required_signatures'));
      if (signatures === false) await client.mutate('DELETE', repoPath(ctx.target, 'branches', branch.name, 'protection', 'required_signatures'));
    }
  };
  if (weakened.length) item.risk = 'ослабление защиты ветки';
  return [item];
}
