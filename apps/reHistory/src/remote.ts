import { createHash } from 'node:crypto';

import { gitConfigKeys, mapped, type Plan, type Repository } from '@reHistory/engine';

/** Accept only explicit SSH/HTTPS destinations without embedded secrets. */
export function validateRemoteURL(value: string): string {
  if (/[\s\p{Cc}\p{Cf}\\%]/u.test(value) || value.split('/').includes('..')) throw new Error('URL содержит недопустимые символы или сегменты пути.');
  const scp = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value);
  const normalized = scp ? `ssh://${value.replace(':', '/')}` : value;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Укажите HTTPS/SSH URL или git@host:owner/repo.git.');
  }
  if (
    !['https:', 'ssh:'].includes(url.protocol) ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(url.hostname) ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9._~/-]+$/.test(url.pathname) ||
    url.pathname.split('/').includes('..') ||
    (url.protocol === 'https:' && url.username) ||
    (url.username && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.username))
  ) {
    throw new Error('Нужен HTTPS/SSH URL без паролей, токенов, query, fragment и нестандартных путей.');
  }
  // Keep home-relative SCP paths distinct from absolute SSH URL paths.
  return scp ? value : url.href;
}

export function networkGit(repo: Repository, args: string[]): Buffer {
  rejectNetworkConfiguration(configuration(repo));
  return repo.git(
    [
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.ssh.allow=always',
      '-c',
      'http.sslVerify=true',
      '-c',
      'http.followRedirects=false',
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=',
      ...args
    ],
    undefined,
    {
      GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=15 -oServerAliveInterval=15 -oServerAliveCountMax=2',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never'
    }
  );
}

type Configuration = { values: Map<string, string[]>; keys: string[]; digest: string };
function configuration(repo: Repository): Configuration {
  const raw = repo.git(['config', '--null', '--list']);
  const values = new Map<string, string[]>();
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const end = record.indexOf('\n');
    const key = end < 0 ? record : record.slice(0, end);
    const value = end < 0 ? '' : record.slice(end + 1);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return { values, keys: gitConfigKeys(repo), digest: createHash('sha256').update(raw).digest('hex') };
}

function rejectNetworkConfiguration(config: Configuration): void {
  const keys = config.keys;
  if (keys.some((key) => /^http\./i.test(key))) throw new Error('HTTP-настройки Git не поддерживаются для сетевых операций. Уберите http.* в отдельном клоне или используйте ручной push.');
  if (keys.some((key) => /^url\.[\s\S]*\.(?:insteadof|pushinsteadof)$/i.test(key))) throw new Error('URL-подстановки Git не поддерживаются для push. Выполните отправку вручную.');
}

export function pushRemotes(repo: Repository, head: string): { names: string[]; initial: number } {
  const names = repo.text(['remote']).split('\n').filter(Boolean);
  for (const name of names) repo.git(['check-ref-format', `refs/remotes/${name}/probe`]);
  const preferred = configuration(repo)
    .values.get(`branch.${head.slice(11)}.remote`)
    ?.at(-1);
  const initial = Math.max(0, names.indexOf(preferred ?? 'origin'));
  return { names, initial };
}

export type PushTransport = {
  refs: (repo: Repository, url: string) => string;
  push: (repo: Repository, url: string, args: string[]) => void;
};
const transport: PushTransport = {
  refs: (repo, url) => networkGit(repo, ['ls-remote', '--refs', url]).toString('utf8').trim(),
  push: (repo, _url, args) => {
    networkGit(repo, args);
  }
};
export type PushRef = { local: string; destination: string; oid: string; expected: string };
/** `shared`: another branch contains the initial tag target. `new`: the server does not have the tag. */
export type OptionalTagReason = 'shared' | 'new';
export type PushPlan = {
  rewrite: Plan;
  remote: string;
  url: string;
  configDigest: string;
  /** The branch and the tags that only this branch contains and that the server already has. */
  refs: PushRef[];
  /** Tags that need a separate user choice. They are not sent by default. */
  optional: (PushRef & { reasons: OptionalTagReason[] })[];
};

function checkLocal(rewrite: Plan): void {
  const current = rewrite.repo.inspect();
  if (current.head !== rewrite.head || current.headOid !== rewrite.mapping.get(rewrite.headOid)) throw new Error('Локальная ветка изменилась. Push отменён.');
  for (const ref of rewrite.selected) {
    if (current.refs.find((item) => item.name === ref.name)?.oid !== rewrite.mapping.get(ref.oid)) throw new Error('Локальная ветка или тег изменились. Push отменён.');
  }
}

/**
 * Find initial tag targets that other branches also contain, for example tags of the default branch.
 * The current branch, its remote-tracking refs and the push destination do not count.
 */
export function sharedTags(rewrite: Plan, push?: { remote: string; destination: string }): Set<string> {
  const { repo } = rewrite;
  const branch = rewrite.head.slice(11);
  const own = new Set([rewrite.head]);
  if (push) own.add(`refs/remotes/${push.remote}/${push.destination.slice(11)}`);
  for (const name of repo.text(['remote']).split('\n').filter(Boolean)) own.add(`refs/remotes/${name}/${branch}`);
  const tips = rewrite.refs.filter((ref) => !ref.symbolic && ref.oid && /^refs\/(heads|remotes)\//.test(ref.name) && !own.has(ref.name)).map((ref) => ref.oid);
  const shared = new Set<string>();
  if (!tips.length) return shared;
  const reachable = new Set(repo.text(['rev-list', '--stdin'], tips.join('\n') + '\n').split('\n'));
  for (const ref of rewrite.selected) {
    if (!ref.name.startsWith('refs/tags/')) continue;
    if (reachable.has(repo.text(['rev-parse', '--verify', `${ref.oid}^{commit}`]))) shared.add(ref.name);
  }
  return shared;
}

/** Read the selected server only after the user opts in. Never fetch. */
export function preparePush(rewrite: Plan, remote: string, connection: PushTransport = transport): PushPlan {
  const { repo } = rewrite;
  checkLocal(rewrite);
  if (!pushRemotes(repo, rewrite.head).names.includes(remote)) throw new Error('Remote не найден. Push отменён.');
  const config = configuration(repo);
  // Explicit destinations must not be silently redirected by a second URL rewrite.
  rejectNetworkConfiguration(config);
  const urls = repo.text(['remote', 'get-url', '--push', '--all', '--', remote]).split('\n').filter(Boolean);
  if (urls.length !== 1) throw new Error('Для push нужен remote с одним URL отправки.');
  const url = validateRemoteURL(urls[0] ?? '');
  const branch = `branch.${rewrite.head.slice(11)}`;
  const merges = config.values.get(`${branch}.merge`) ?? [];
  if (config.values.get(`${branch}.remote`)?.at(-1) === remote && merges.length > 1) throw new Error('У ветки несколько upstream-ссылок. Push отменён.');
  const destination = config.values.get(`${branch}.remote`)?.at(-1) === remote ? (merges[0] ?? rewrite.head) : rewrite.head;
  if (!destination.startsWith('refs/heads/')) throw new Error('Upstream должен быть веткой.');
  repo.git(['check-ref-format', destination]);
  const advertised = connection.refs(repo, url);
  const server = new Map<string, string>();
  const width = rewrite.headOid.length;
  for (const line of advertised.split('\n').filter(Boolean)) {
    const [, oid, name] = /^([a-f0-9]{40}|[a-f0-9]{64})\t(refs\/[^\s]+)$/.exec(line) ?? [];
    if (oid === undefined || name === undefined || oid.length !== width || server.has(name)) throw new Error('Некорректный ответ сервера. Push отменён.');
    server.set(name, oid);
  }
  const newCommits = new Set(rewrite.objects.filter((object) => object.type === 'commit').map((object) => object.oid));
  const oldCommits = new Set([...rewrite.mapping].filter(([, oid]) => newCommits.has(oid)).map(([oid]) => oid));
  const shared = sharedTags(rewrite, { remote, destination });
  const refs: PushPlan['refs'] = [];
  const optional: PushPlan['optional'] = [];
  for (const ref of rewrite.selected) {
    const target = ref.name === rewrite.head ? destination : ref.name;
    const oid = mapped(rewrite.mapping, ref.oid);
    const expected = server.get(target) ?? '';
    if (expected && expected !== oid && (ref.name === rewrite.head ? !oldCommits.has(expected) : expected !== ref.oid)) {
      throw new Error(`На сервере есть неизвестные изменения: ${target}. Push отменён.`);
    }
    const item = { local: ref.name, destination: target, oid, expected };
    const reasons: OptionalTagReason[] = [];
    if (ref.name !== rewrite.head) {
      if (shared.has(ref.name)) reasons.push('shared');
      if (!expected) reasons.push('new');
    }
    if (reasons.length) optional.push({ ...item, reasons });
    else refs.push(item);
  }
  if (configuration(repo).digest !== config.digest) throw new Error('Настройки Git изменились. Push отменён.');
  checkLocal(rewrite);
  return { rewrite, remote, url, configDigest: config.digest, refs, optional };
}

/** Send the required refs. Optional tags are sent only when the user selected them separately. */
export function executePush(plan: PushPlan, connection: PushTransport = transport, includeOptional = false): void {
  checkLocal(plan.rewrite);
  const refs: PushRef[] = [...plan.refs, ...(includeOptional ? plan.optional : [])];
  if (configuration(plan.rewrite.repo).digest !== plan.configDigest) throw new Error('Настройки Git изменились после проверки. Push отменён.');
  // Explicit object IDs prevent a concurrent local ref update from changing the payload.
  const args = [
    '-c',
    'push.followTags=false',
    '-c',
    'push.recurseSubmodules=no',
    '-c',
    'push.autoSetupRemote=false',
    '-c',
    'push.negotiate=false',
    '-c',
    'push.gpgSign=false',
    '-c',
    'push.pushOption=',
    'push',
    '--atomic',
    '--porcelain',
    '--no-mirror',
    '--no-follow-tags',
    '--recurse-submodules=no',
    '--no-signed',
    '--no-verify',
    ...refs.map((ref) => `--force-with-lease=${ref.destination}:${ref.expected}`),
    '--',
    plan.url,
    ...refs.map((ref) => `${ref.oid}:${ref.destination}`)
  ];
  connection.push(plan.rewrite.repo, plan.url, args);
}

export type RemoteCopy = { tracking: number; unpushed: number };
/** Count current-branch commits that no remote-tracking ref contains. Read only local refs. Never fetch. */
export function remoteCopy(repo: Repository, headOid: string): RemoteCopy {
  const tracking = repo.refs().filter((ref) => ref.name.startsWith('refs/remotes/') && !ref.symbolic && ref.oid).length;
  const unpushed = Number(repo.text(['rev-list', '--count', headOid, ...(tracking ? ['--not', '--remotes'] : [])]));
  if (!Number.isSafeInteger(unpushed) || unpushed < 0) throw new Error('Не удалось сравнить ветку с remote-ссылками.');
  return { tracking, unpushed };
}

/**
 * Record a confirmed push in the remote-tracking branch, as `git push <remote>` does.
 * Only the default fetch mapping is supported. Return undefined when the mapping is different.
 */
export function updateTrackingRef(plan: PushPlan): string | undefined {
  const { repo, head } = plan.rewrite;
  const branch = plan.refs.find((ref) => ref.local === head);
  if (!branch) return undefined;
  const fetch = configuration(repo).values.get(`remote.${plan.remote}.fetch`) ?? [];
  if (!fetch.some((value) => value === `+refs/heads/*:refs/remotes/${plan.remote}/*` || value === `refs/heads/*:refs/remotes/${plan.remote}/*`)) return undefined;
  const tracking = `refs/remotes/${plan.remote}/${branch.destination.slice(11)}`;
  repo.git(['check-ref-format', tracking]);
  const current = repo.refs().find((ref) => ref.name === tracking);
  if (current?.symbolic) return undefined;
  // A missing ref must stay missing until this create. An existing ref must keep its value until this update.
  const expected = current?.oid ?? '0'.repeat(branch.oid.length);
  repo.git(['update-ref', '--no-deref', '-m', 'reHistory: push', tracking, branch.oid, expected]);
  return tracking;
}
