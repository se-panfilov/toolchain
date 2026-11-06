import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Repository, runGit, parts, field, type Plan, type Options } from './engine.ts';
import { inventory, objectClosure, stamp } from './audit.ts';

export const manifestName = 'rehistory-export.json';
type Manifest = {
  version: 1; head: string; refs: { name: string; oid: string }[]; objects: string[]; commitOrder: string[];
  policy: { start: number; interval: number; tagPolicy: 'normalize' | 'preserve'; identity?: Options['identity']; tagIdentity?: Options['tagIdentity'] };
};
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel));
}
/** Validate the destination without directory creation. Use this for dry-run too. */
export function exportDestination(repo: Repository, destination: string): string {
  const absolute = resolve(destination);
  const target = join(realpathSync(dirname(absolute)), basename(absolute));
  try { lstatSync(target); throw new Error('Каталог экспорта уже существует. Нужен новый путь.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const root = realpathSync(repo.text(['rev-parse', '--is-bare-repository']) === 'true' ? repo.common : repo.text(['rev-parse', '--show-toplevel']));
  if (within(root, target) || within(target, root) || within(realpathSync(repo.common), target)) throw new Error('Экспорт должен находиться вне исходного репозитория и его служебного каталога.');
  return target;
}
function equalSet(a: string[], b: string[]): boolean { return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort()); }
function loadManifest(path: string): Manifest {
  const file = join(path, manifestName);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('Некорректный файл манифеста экспорта.');
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  const oid = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  if (m.version !== 1 || typeof m.head !== 'string' || !m.head.startsWith('refs/heads/') || !Array.isArray(m.refs) || !m.refs.length || !m.refs.every(r => typeof r.name === 'string' && /^(refs\/heads\/|refs\/tags\/)/.test(r.name) && oid(r.oid)) || !Array.isArray(m.objects) || !m.objects.every(oid) || !Array.isArray(m.commitOrder) || !m.commitOrder.length || !m.commitOrder.every(oid) || !m.policy || !Number.isSafeInteger(m.policy.start) || !Number.isSafeInteger(m.policy.interval) || m.policy.interval < 1 || m.policy.interval > 31536000 || m.policy.start < 0 || m.policy.start + (m.commitOrder.length - 1) * m.policy.interval > 253402300799 || !['normalize', 'preserve'].includes(m.policy.tagPolicy)) throw new Error('Неподдерживаемая структура манифеста экспорта.');
  return m;
}

/** Read the object inventory, graph, refs, and dates. Verify integrity without writes. */
export function verifyExport(path: string) {
  const repo = new Repository(path);
  const manifest = loadManifest(repo.path);
  const errors: string[] = [];
  function check(ok: boolean, message: string): void { if (!ok) errors.push(message); }
  function attempt(fn: () => void): void { try { fn(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } }
  check(repo.text(['rev-parse', '--is-bare-repository']) === 'true', 'Экспорт должен быть bare-репозиторием.');
  attempt(() => check(repo.text(['symbolic-ref', '-q', 'HEAD']) === manifest.head, 'HEAD не соответствует манифесту.'));
  const allowed = new Set(['HEAD', 'config', 'objects', 'refs', 'packed-refs', manifestName]);
  for (const entry of readdirSync(repo.path)) check(allowed.has(entry), `Неожиданный служебный файл/каталог: ${entry}.`);
  function checkLinks(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      check(!stat.isSymbolicLink(), `В экспорте есть символическая ссылка: ${path}.`);
      if (stat.isDirectory()) checkLinks(path);
      else if (stat.isFile()) check(stat.nlink === 1, `В экспорте есть файл с общей hardlink: ${path}.`);
      else if (!stat.isSymbolicLink()) check(false, `Специальный файл в экспорте: ${path}.`);
    }
  }
  attempt(() => checkLinks(repo.path));
  const refs = repo.refs();
  check(refs.every(r => !r.symbolic), 'В экспорте есть неожиданные символические refs.');
  check(equalSet(refs.map(r => `${r.name} ${r.oid}`), manifest.refs.map(r => `${r.name} ${r.oid}`)), 'Набор refs не соответствует разрешённому набору.');
  check(manifest.refs.filter(r => r.name.startsWith('refs/heads/')).length === 1 && manifest.refs.some(r => r.name === manifest.head), 'Манифест должен описывать одну экспортированную ветку.');
  const objects = inventory(repo);
  check(equalSet(objects.map(o => o.oid), manifest.objects), 'В хранилище отсутствуют ожидаемые объекты или присутствуют лишние.');
  attempt(() => check(equalSet([...objectClosure(repo, refs.map(r => r.oid))], objects.map(o => o.oid)), 'Есть недостижимые объекты либо недостающие объекты графа.'));
  check(!existsSync(join(repo.common, 'objects', 'info', 'alternates')) && !existsSync(join(repo.common, 'objects', 'info', 'http-alternates')), 'Экспорт зависит от внешнего хранилища объектов.');
  check(repo.text(['rev-parse', '--is-shallow-repository']) === 'false', 'Экспорт оказался shallow.');
  check(!existsSync(join(repo.common, 'info', 'grafts')), 'В экспорте обнаружены grafts.');
  check(!repo.text(['reflog', 'show', '--all', '--format=%H']), 'В экспорте есть записи reflog.');
  const config = repo.text(['config', '--local', '--list']);
  check(!/^remote\.|^extensions\.partialclone(?:=|$)/mi.test(config), 'В экспорте обнаружена конфигурация remote/partial clone.');
  const allowedConfig = new Set(['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.symlinks', 'core.protectntfs', 'core.precomposeunicode', 'extensions.objectformat']);
  check(config.split('\n').filter(Boolean).every(line => allowedConfig.has(line.split('=')[0].toLowerCase())), 'В локальном config есть посторонние настройки.');
  check(equalSet(objects.filter(o => o.type === 'commit').map(o => o.oid), manifest.commitOrder), 'Набор коммитов не соответствует плану.');
  const times = new Map<string, number>();
  for (const [index, oid] of manifest.commitOrder.entries()) attempt(() => {
    const raw = repo.git(['cat-file', 'commit', oid]);
    const a = stamp(raw, 'author'); const c = stamp(raw, 'committer');
    const expected = manifest.policy.start + index * manifest.policy.interval;
    check(a.timestamp === expected && c.timestamp === expected && a.timezone === '+0000' && c.timezone === '+0000', `Неверные даты коммита ${oid}.`);
    if (manifest.policy.identity) {
      const who = `${manifest.policy.identity.name} <${manifest.policy.identity.email}>`;
      check(a.identity === who && c.identity === who, `Неверная идентичность коммита ${oid}.`);
    }
    for (const h of parts(raw).headers) {
      check(!['gpgsig', 'gpgsig-sha256', 'mergetag'].includes(field(h)), `Остался заголовок подписи в ${oid}.`);
      if (field(h) === 'parent') check(times.has(h.subarray(7).toString('ascii')) && times.get(h.subarray(7).toString('ascii'))! < expected, `Неверный порядок родителей ${oid}.`);
    }
    times.set(oid, expected);
  });
  for (const object of objects.filter(o => o.type === 'tag')) attempt(() => {
    const raw = repo.git(['cat-file', 'tag', object.oid]);
    const tagger = stamp(raw, 'tagger');
    const target = repo.text(['rev-parse', '--verify', `${object.oid}^{}`]);
    check(times.has(target), `Тег ${object.oid} указывает вне выбранной истории.`);
    if (manifest.policy.tagPolicy === 'normalize') check(tagger.timestamp === times.get(target) && tagger.timezone === '+0000', `Неверная дата тега ${object.oid}.`);
    if (manifest.policy.tagIdentity) check(tagger.identity === `${manifest.policy.tagIdentity.name} <${manifest.policy.tagIdentity.email}>`, `Неверный tagger ${object.oid}.`);
    check(!/(?:^|\n)-----BEGIN (?:PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----/m.test(parts(raw).message.toString('latin1')), `Осталась подпись тега ${object.oid}.`);
  });
  attempt(() => { repo.git(['fsck', '--full', '--strict', '--no-reflogs']); });
  return { ok: errors.length === 0, repository: repo.path, commits: manifest.commitOrder.length, tags: refs.filter(r => r.name.startsWith('refs/tags/')).length, objects: objects.length, errors };
}

export function exportPlan(plan: Plan, destination: string) {
  const { repo } = plan;
  const target = exportDestination(repo, destination);
  const sourceBefore = repo.inspect();
  if (JSON.stringify(sourceBefore.refs) !== JSON.stringify(plan.refs) || sourceBefore.head !== plan.head || sourceBefore.headOid !== plan.headOid) throw new Error('Исходный репозиторий изменился после построения плана.');
  // Create a new directory without recursive mode. Do not remove existing directories.
  mkdirSync(target, { mode: 0o700 });
  try {
    const format = repo.text(['rev-parse', '--show-object-format']);
    runGit(target, ['init', '-q', '--bare', '--template=', `--object-format=${format}`, `--initial-branch=${plan.head.slice(11)}`]);
    const output = new Repository(target);
    output.git(['config', 'core.logAllRefUpdates', 'false']);
    const original = [...objectClosure(repo, plan.selected.map(r => r.oid))];
    const info = repo.text(['cat-file', '--batch-check=%(objectname) %(objecttype)'], original.join('\n') + '\n');
    const expectedObjects = new Set<string>();
    // Copy only source tree and blob objects. Do not copy source commits or tags.
    for (const line of info.split('\n').filter(Boolean)) {
      const [oid, type] = line.split(' ');
      if (type !== 'tree' && type !== 'blob') continue;
      const data = repo.git(['cat-file', type, oid]);
      if (output.text(['hash-object', '-w', '-t', type, '--stdin'], data) !== oid) throw new Error('Не совпал хеш дерева/файла при копировании.');
      expectedObjects.add(oid);
    }
    for (const object of plan.objects) {
      if (output.text(['hash-object', '-w', '-t', object.type, '--stdin'], object.data) !== object.oid) throw new Error('Не совпал хеш переписанного объекта.');
      expectedObjects.add(object.oid);
    }
    const refs = plan.selected.map(r => ({ name: r.name, oid: plan.mapping.get(r.oid)! }));
    output.git(['update-ref', '--stdin'], ['start', ...refs.map(r => `create ${r.name} ${r.oid}`), 'prepare', 'commit', ''].join('\n'));
    const manifest: Manifest = {
      version: 1, head: plan.head, refs, objects: [...expectedObjects].sort(), commitOrder: plan.commitOrder,
      policy: { start: plan.options.start, interval: plan.options.interval, identity: plan.options.identity, tagPolicy: plan.options.tagPolicy || 'normalize', tagIdentity: plan.options.tagIdentity },
    };
    // Exclude old commit and tag IDs, source paths, and other branch names.
    writeFileSync(join(target, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (JSON.stringify(repo.inspect()) !== JSON.stringify(sourceBefore)) throw new Error('Исходный репозиторий изменился во время экспорта. Результат требует повторной проверки.');
    const verification = verifyExport(target);
    if (!verification.ok) throw new Error(`Проверка экспорта не пройдена:\n${verification.errors.join('\n')}`);
    return verification;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nНезавершённый экспорт оставлен в ${target}. Исходный репозиторий не переписывался.`);
  }
}
