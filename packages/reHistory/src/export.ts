import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, readdirSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Repository, runGit, parts, field, validateIdentity, type Plan, type Options } from '@reHistory/engine';
import { inventory, objectClosure, stamp } from '@reHistory/audit';

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
function exactKeys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
}
function validIdentity(value: unknown): boolean {
  if (!exactKeys(value, ['name', 'email']) || typeof value.name !== 'string' || typeof value.email !== 'string') return false;
  try { validateIdentity(value.name, value.email); return true; }
  catch { return false; }
}
function loadManifest(path: string): Manifest {
  const file = join(path, manifestName);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('Некорректный файл манифеста экспорта.');
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const fail = () => { throw new Error('Неподдерживаемая структура манифеста экспорта.'); };
  if (!exactKeys(value, ['version', 'head', 'refs', 'objects', 'commitOrder', 'policy'])) fail();
  const m = value as Manifest;
  const oid = (item: unknown) => typeof item === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item);
  const ref = (item: unknown) => exactKeys(item, ['name', 'oid']) && typeof item.name === 'string'
    && /^(refs\/heads\/|refs\/tags\/)/.test(item.name) && oid(item.oid);
  const unique = (items: string[]) => new Set(items).size === items.length;
  if (m.version !== 1 || typeof m.head !== 'string' || !m.head.startsWith('refs/heads/')) fail();
  if (!Array.isArray(m.refs) || !m.refs.length || !m.refs.every(ref) || !unique(m.refs.map(r => r.name))) fail();
  if (!Array.isArray(m.objects) || !m.objects.every(oid) || !unique(m.objects)) fail();
  if (!Array.isArray(m.commitOrder) || !m.commitOrder.length || !m.commitOrder.every(oid) || !unique(m.commitOrder)) fail();
  const width = m.commitOrder[0].length;
  if (![...m.objects, ...m.commitOrder, ...m.refs.map(r => r.oid)].every(item => item.length === width)) fail();
  if (!exactKeys(m.policy, ['start', 'interval', 'tagPolicy'], ['identity', 'tagIdentity'])) fail();
  const { start, interval, tagPolicy, identity, tagIdentity } = m.policy;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(interval) || interval < 1 || interval > 31536000) fail();
  const last = start + (m.commitOrder.length - 1) * interval;
  if (!Number.isSafeInteger(last) || last > 253402300799 || !['normalize', 'preserve'].includes(tagPolicy)) fail();
  if (identity !== undefined && !validIdentity(identity)) fail();
  if (tagIdentity !== undefined && !validIdentity(tagIdentity)) fail();
  return m;
}

/** Check metadata and every nested path before Git reads the object store. */
function checkExportFiles(root: string, manifest: Manifest): { errors: string[]; peeledRefs: Map<string, string> } {
  const errors: string[] = [];
  let peeledRefs = new Map<string, string>();
  const check = (ok: boolean, message: string) => { if (!ok) errors.push(message); };
  const refs = new Map(manifest.refs.map(ref => [ref.name, ref.oid]));
  const objects = new Set(manifest.objects);
  const directories = new Set(['objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags']);
  for (const name of refs.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const metadata = new Set(['HEAD', 'config', 'packed-refs', manifestName]);
  const packs = new Map<string, Set<string>>();
  const width = manifest.commitOrder[0].length;
  const loose = new RegExp(`^objects/([a-f0-9]{2})/([a-f0-9]{${width - 2}})$`);
  const packed = new RegExp(`^objects/pack/(pack-[a-f0-9]{${width}})\\.(pack|idx)$`);
  const read = (relative: string) => readFileSync(join(root, relative), 'utf8');
  function visit(directory: string, prefix = ''): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) { check(false, `В экспорте есть символическая ссылка: ${relative}.`); continue; }
      if (stat.isDirectory()) {
        const allowed = directories.has(relative) || /^objects\/[a-f0-9]{2}$/.test(relative);
        check(allowed, `Неожиданный служебный каталог: ${relative}.`);
        if (allowed) visit(path, relative);
        continue;
      }
      if (!stat.isFile()) { check(false, `Специальный файл в экспорте: ${relative}.`); continue; }
      check(stat.nlink === 1, `В экспорте есть файл с общей hardlink: ${relative}.`);
      const object = loose.exec(relative);
      const pack = packed.exec(relative);
      const allowed = metadata.has(relative) || refs.has(relative) || Boolean(object && objects.has(object[1] + object[2])) || Boolean(pack);
      check(allowed, `Неожиданный служебный файл: ${relative}.`);
      if (!allowed) continue;
      if (pack) {
        if (!packs.has(pack[1])) packs.set(pack[1], new Set());
        packs.get(pack[1])!.add(pack[2]);
        const hashBytes = width / 2;
        const tailBytes = pack[2] === 'idx' ? hashBytes * 2 : hashBytes;
        const footer = Buffer.alloc(tailBytes);
        const fd = openSync(path, 'r');
        let bytes = 0;
        try { if (stat.size >= tailBytes) bytes = readSync(fd, footer, 0, tailBytes, stat.size - tailBytes); }
        finally { closeSync(fd); }
        check(bytes === tailBytes && footer.subarray(0, hashBytes).toString('hex') === pack[1].slice(5), `Неверное имя pack/idx: ${relative}.`);
      }
      if (refs.has(relative)) {
        check(stat.size <= 8192 && read(relative) === `${refs.get(relative)}\n`, `Посторонние данные или неверная ссылка: ${relative}.`);
      }
      if (relative === 'HEAD') {
        check(stat.size <= 8192 && read(relative) === `ref: ${manifest.head}\n`, 'Посторонние данные или неверная ссылка в HEAD.');
      }
      if (relative === 'config') {
        check(stat.size <= 65536 && canonicalConfig(read(relative)), 'В config есть посторонние настройки, данные или неподдерживаемые значения.');
      }
      if (relative === 'packed-refs') {
        const parsed = stat.size <= 64 * 1024 * 1024 ? parsePackedRefs(read(relative), refs, objects, width) : undefined;
        check(parsed !== undefined, 'Посторонние данные или неверные packed-refs.');
        if (parsed) peeledRefs = parsed;
      }
    }
  }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { errors: ['Экспорт должен быть обычным каталогом без символической ссылки.'], peeledRefs };
  visit(root);
  for (const [name, files] of packs) check(files.has('pack') && files.has('idx'), `Неполная пара pack/idx: ${name}.`);
  return { errors, peeledRefs };
}

function canonicalConfig(text: string): boolean {
  const booleans = ['true', 'false', 'yes', 'no', 'on', 'off', '0', '1'];
  const allowed: Record<string, string[]> = {
    'core.repositoryformatversion': ['0', '1'], 'core.bare': ['true'], 'core.logallrefupdates': ['false'],
    'core.filemode': booleans, 'core.ignorecase': booleans, 'core.symlinks': booleans,
    'core.protectntfs': booleans, 'core.precomposeunicode': booleans, 'extensions.objectformat': ['sha1', 'sha256'],
  };
  let section = '';
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = /^\s*\[(core|extensions)\]\s*$/i.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    const item = /^\s*([a-z]+)\s*=\s*([a-z0-9]+)\s*$/i.exec(line);
    if (!item) return false;
    const key = `${section}.${item[1].toLowerCase()}`;
    if (seen.has(key) || !allowed[key]?.includes(item[2].toLowerCase())) return false;
    seen.add(key);
  }
  return true;
}

function parsePackedRefs(text: string, refs: Map<string, string>, objects: Set<string>, width: number): Map<string, string> | undefined {
  const lines = text.split('\n');
  if (lines.pop() !== '') return;
  if (lines[0]?.startsWith('#')) {
    const header = /^# pack-refs with: (?:peeled|fully-peeled|sorted)(?: (?:peeled|fully-peeled|sorted))* ?$/.test(lines.shift()!);
    if (!header) return;
  }
  const record = new RegExp(`^([a-f0-9]{${width}}) (refs/(?:heads|tags)/.+)$`);
  const peeled = new RegExp(`^\\^[a-f0-9]{${width}}$`);
  const seen = new Set<string>();
  const peeledRefs = new Map<string, string>();
  let tag: string | undefined;
  for (const line of lines) {
    if (peeled.test(line) && tag) {
      if (!objects.has(line.slice(1))) return;
      peeledRefs.set(tag, line.slice(1)); tag = undefined; continue;
    }
    const item = record.exec(line);
    if (!item || refs.get(item[2]) !== item[1] || seen.has(item[2])) return;
    seen.add(item[2]); tag = item[2].startsWith('refs/tags/') ? item[2] : undefined;
  }
  return peeledRefs;
}

/** Read the object inventory, graph, refs, and dates. Verify integrity without writes. */
export function verifyExport(path: string) {
  const absolute = resolve(path);
  const manifest = loadManifest(absolute);
  const { errors, peeledRefs } = checkExportFiles(absolute, manifest);
  if (errors.length) {
    return { ok: false, repository: absolute, commits: manifest.commitOrder.length,
      tags: manifest.refs.filter(ref => ref.name.startsWith('refs/tags/')).length, objects: manifest.objects.length, errors };
  }
  const repo = new Repository(absolute);
  function check(ok: boolean, message: string): void { if (!ok) errors.push(message); }
  function attempt(fn: () => void): void { try { fn(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } }
  const refObjects = new Map(manifest.refs.map(ref => [ref.name, ref.oid]));
  for (const [name, target] of peeledRefs) attempt(() => {
    const oid = refObjects.get(name)!;
    check(repo.text(['rev-parse', '--verify', `${oid}^{}`]) === target, `Неверная peeled-ссылка в packed-refs: ${name}.`);
  });
  check(repo.text(['rev-parse', '--is-bare-repository']) === 'true', 'Экспорт должен быть bare-репозиторием.');
  attempt(() => check(repo.text(['symbolic-ref', '-q', 'HEAD']) === manifest.head, 'HEAD не соответствует манифесту.'));
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
