import { askTransfer, pick } from '@reRules/flow';
import { apiPath, type GitHubClient, repoPath } from '@reRules/github';
import { category, type Context, type PlanItem, Stage } from '@reRules/plan';
import type { RepoInfo } from '@reRules/repo';
import { attempt, type Read, rec, str } from '@reRules/state';

const title = 'Доступ';

/** Built-in roles from the weakest to the strongest. Custom roles have no rank. */
const roles = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
const apiPermission: Record<string, string> = { read: 'pull', triage: 'triage', write: 'push', maintain: 'maintain', admin: 'admin', pull: 'pull', push: 'push' };

export function roleRank(role: string): number {
  const normalized = role === 'pull' ? 'read' : role === 'push' ? 'write' : role;
  return roles.indexOf(normalized as (typeof roles)[number]);
}

export type Grant = { kind: 'user' | 'team'; name: string; role: string };
export type AccessData = {
  users: Read<Grant[]>;
  teams: Read<Grant[]> | undefined;
  targetUsers: Read<Grant[]>;
  targetTeams: Read<Grant[]> | undefined;
  members: Map<string, Read<boolean>>;
};

function roleOf(item: Record<string, unknown>): string {
  const role = str(item.role_name) ?? str(item.permission);
  if (role) return role;
  const permissions = rec(item.permissions);
  return [...roles].reverse().find((name) => permissions[apiPermission[name] ?? name] === true || permissions[name] === true) ?? 'read';
}

async function users(client: GitHubClient, repo: RepoInfo): Promise<Grant[]> {
  const direct = (await client.paginate(repoPath(repo, 'collaborators'), { affiliation: 'direct' })).map((item) => ({
    kind: 'user' as const,
    name: str(rec(item).login) ?? '',
    role: roleOf(rec(item))
  }));
  return direct.filter((grant) => grant.name && grant.name.toLowerCase() !== repo.owner.toLowerCase());
}

async function invitations(client: GitHubClient, repo: RepoInfo): Promise<Grant[]> {
  return (await client.paginate(repoPath(repo, 'invitations'))).map((item) => ({ kind: 'user' as const, name: str(rec(rec(item).invitee).login) ?? '', role: str(rec(item).permissions) ?? 'read' }));
}

async function teams(client: GitHubClient, repo: RepoInfo): Promise<Grant[]> {
  return (await client.paginate(repoPath(repo, 'teams'))).map((item) => ({ kind: 'team' as const, name: str(rec(item).slug) ?? '', role: roleOf(rec(item)) }));
}

export async function discoverAccess(ctx: Context): Promise<AccessData> {
  const { client, source, target } = ctx;
  const sourceUsers = await attempt(() => users(client, source));
  const targetUsers = await attempt(async () => [...(await users(client, target)), ...(await invitations(client, target))]);
  const members = new Map<string, Read<boolean>>();
  if (target.ownerType === 'Organization' && sourceUsers.ok) {
    for (const grant of sourceUsers.value) {
      // 204: member; 404: not a member. Other answers mean that the membership is unknown.
      members.set(grant.name.toLowerCase(), await attempt(async () => (await client.status(apiPath('orgs', target.owner, 'members', grant.name))) === 204));
    }
  }
  return {
    users: sourceUsers,
    teams: source.ownerType === 'Organization' ? await attempt(() => teams(client, source)) : undefined,
    targetUsers,
    targetTeams: target.ownerType === 'Organization' ? await attempt(() => teams(client, target)) : undefined,
    members
  };
}

export const accessCategory = category<AccessData>({
  id: 'access',
  title,
  discover: discoverAccess,
  empty(data) {
    const noUsers = data.users.ok && data.users.value.length === 0;
    const noTeams = !data.teams || (data.teams.ok && data.teams.value.length === 0);
    return noUsers && noTeams ? 'В источнике нет прямых соавторов и команд.' : undefined;
  },
  present(data, ctx) {
    const { ui } = ctx;
    if (data.users.ok) {
      ui.section('Прямые соавторы источника:');
      ui.rows(data.users.value.map((grant) => [grant.name, grant.role] as const));
    } else ui.warn(`Соавторы источника: ${data.users.detail}`);
    if (data.teams?.ok) {
      ui.section('Команды источника:');
      ui.rows(data.teams.value.map((grant) => [grant.name, grant.role] as const));
    } else if (data.teams) ui.warn(`Команды источника: ${data.teams.detail}`);
    if (ctx.source.ownerType === 'Organization') ui.info('Права через организацию (базовые права, владельцы, наследование команд) не переносятся.');
    if (ctx.target.ownerType === 'User') ui.info('В личном репозитории роль не выбирается: соавтор получает права записи.');
  },
  async plan(data, ctx) {
    const items: PlanItem[] = [];
    if (!data.targetUsers.ok) return [{ category: title, kind: 'warn', title: `Доступ в цели не прочитан: ${data.targetUsers.detail}`, stage: Stage.access }];
    const candidates: Grant[] = [];
    const existingUsers = data.targetUsers.value;
    for (const grant of data.users.ok ? data.users.value : []) {
      const existing = existingUsers.find((item) => item.name.toLowerCase() === grant.name.toLowerCase());
      if (existing && (ctx.target.ownerType === 'User' || roleRank(existing.role) >= roleRank(grant.role))) {
        items.push({ category: title, kind: 'keep', title: `${grant.name}: доступ уже есть (${existing.role})`, stage: Stage.access });
      } else if (roleRank(grant.role) < 0 && ctx.target.ownerType === 'User') {
        items.push({ category: title, kind: 'warn', title: `${grant.name}: роль ${grant.role} недоступна в личном репозитории`, stage: Stage.access });
      } else candidates.push(grant);
    }
    const sameOrg = ctx.target.ownerType === 'Organization' && ctx.source.owner.toLowerCase() === ctx.target.owner.toLowerCase();
    for (const grant of data.teams?.ok ? data.teams.value : []) {
      const existing = data.targetTeams?.ok ? data.targetTeams.value.find((item) => item.name === grant.name) : undefined;
      if (!sameOrg) items.push({ category: title, kind: 'warn', title: `Команда ${grant.name}: команды переносятся только внутри той же организации`, stage: Stage.access });
      else if (existing && roleRank(existing.role) >= roleRank(grant.role)) items.push({ category: title, kind: 'keep', title: `Команда ${grant.name}: доступ уже есть`, stage: Stage.access });
      else candidates.push(grant);
    }
    if (!candidates.length) return items;
    const external = (grant: Grant): boolean => {
      if (grant.kind !== 'user' || ctx.target.ownerType !== 'Organization') return false;
      const member = data.members.get(grant.name.toLowerCase());
      return member?.ok === true && !member.value;
    };
    const describe = (grant: Grant): string =>
      `${grant.kind === 'team' ? 'Команда ' : ''}${grant.name} — ${ctx.target.ownerType === 'User' ? 'запись' : grant.role}${external(grant) ? ' (внешний соавтор)' : ''}`;
    const mode = await askTransfer(ctx, 'Выдать доступ в цели?', { defaultSkip: true });
    if (mode === 'skip') return [...items, { category: title, kind: 'skip', title: 'Доступ не переносится', stage: Stage.access }];
    // External collaborators are never selected automatically.
    let chosen: Grant[];
    if (mode === 'all') {
      chosen = candidates.filter((grant) => !external(grant));
      for (const grant of candidates.filter(external)) items.push({ category: title, kind: 'skip', title: `${grant.name}: внешний соавтор, выберите вручную`, stage: Stage.access });
    } else chosen = await pick(ctx, 'select', 'Кому выдать доступ?', candidates, describe, (grant) => !external(grant));
    for (const grant of chosen) {
      if (!(await ctx.ask.confirm(`Выдать доступ: ${describe(grant)} к ${ctx.target.fullName}?`, false))) {
        items.push({ category: title, kind: 'skip', title: `${grant.name}: доступ не выдаётся`, stage: Stage.access });
        continue;
      }
      const permission = apiPermission[grant.role] ?? grant.role;
      const details = grant.kind === 'user' ? ['GitHub отправит приглашение, если пользователь ещё не участник.'] : [];
      items.push({
        category: title,
        kind: 'create',
        title: `${grant.kind === 'team' ? 'Команда' : 'Пользователь'} ${grant.name}: доступ ${ctx.target.ownerType === 'User' ? 'запись' : grant.role}`,
        details,
        risk: 'выдача доступа к репозиторию',
        stage: Stage.access,
        apply: async (client) => {
          if (grant.kind === 'team') await client.mutate('PUT', apiPath('orgs', ctx.target.owner, 'teams', grant.name, 'repos', ctx.target.owner, ctx.target.name), { permission });
          else await client.mutate('PUT', repoPath(ctx.target, 'collaborators', grant.name), ctx.target.ownerType === 'Organization' ? { permission } : {});
        }
      });
    }
    return items;
  }
});
