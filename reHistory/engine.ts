import { spawnSync } from 'node:child_process';
import { constants, existsSync, openSync, closeSync, unlinkSync, writeFileSync, fsyncSync, readdirSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';

export const defaultBackupBranch = 'rehistory-backup/original';

export type Ref = { name: string; oid: string; symbolic: string };
export type Options = { interval: number; start: number; identity?: { name: string; email: string }; backupBranch?: string; tagPolicy?: 'normalize' | 'preserve'; tagIdentity?: { name: string; email: string } };
export type ObjectData = { type: 'commit' | 'tag'; data: Buffer; oid: string };
export type Plan = { repo: Repository; options: Options; refs: Ref[]; selected: Ref[]; objects: ObjectData[]; mapping: Map<string, string>; commits: number; stripped: number; head: string; headOid: string; commitOrder: string[] };

// Call Git without a shell. Remove inherited Git routing variables.
// This makes --repo select the specified repository.
export function withoutGitEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  // Windows environment variable names are case-insensitive.
  return Object.fromEntries(Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
}
const env = withoutGitEnvironment(process.env);
Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull });
export function runGit(path: string, args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): Buffer {
  const result = spawnSync('git', ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', '-c', 'protocol.https.allow=never', '-c', 'protocol.ssh.allow=never', '-c', 'protocol.http.allow=never', '-c', 'protocol.ext.allow=never', '-C', path, ...args], {
    env: { ...env, ...extraEnv }, input, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw new Error(`Не удалось запустить Git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Git ${args[0]}: ${result.stderr?.toString('utf8').trim() || `код ${result.status}`}`);
  return result.stdout;
}

export class Repository {
  path: string;
  common: string;
  constructor(path: string) {
    this.path = resolve(path);
    this.common = this.text(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  }
  git(args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): Buffer {
    return runGit(this.path, args, input, extraEnv);
  }
  text(args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): string { return this.git(args, input, extraEnv).toString('utf8').trim(); }
  refs(): Ref[] {
    const output = this.text(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)']);
    const refs = output ? output.split('\n').map(line => { const [name, oid, symbolic] = line.split('\0'); return { name, oid, symbolic }; }) : [];
    const known = new Set(refs.map(ref => ref.name));
    const missing: Ref[] = [];
    // for-each-ref omits symbolic refs whose targets are missing.
    // Inspect only regular loose files and never follow directory links.
    const visit = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        const name = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) { visit(file, name); continue; }
        if (!entry.isFile() || known.has(name)) continue;
        const fd = openSync(file, 'r');
        const buffer = Buffer.alloc(8192);
        let bytes: number;
        try { bytes = readSync(fd, buffer, 0, buffer.length, 0); }
        finally { closeSync(fd); }
        const text = buffer.subarray(0, bytes).toString('utf8');
        if (!text.startsWith('ref: ')) continue;
        try { this.git(['check-ref-format', name]); }
        catch { continue; } // Git lock files and invalid names are not refs.
        missing.push({ name, oid: '', symbolic: text.slice(5).trim() });
      }
    };
    const directory = join(this.common, 'refs');
    if (existsSync(directory)) visit(directory, 'refs');
    return [...refs, ...missing.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)];
  }
  inspect(): { refs: Ref[]; head: string; headOid: string } {
    if (this.text(['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('Shallow-репозиторий: сначала получите полную историю.');
    return this.inspectFull();
  }
  inspectFull(): { refs: Ref[]; head: string; headOid: string } {
    const config = this.text(['config', '--list']);
    if (/^(remote\..*\.promisor(?:=|$)|extensions\.partialclone(?:=|$))/mi.test(config)) throw new Error('Partial clone не поддерживается: нужен полный локальный репозиторий.');
    const refs = this.refs();
    if (refs.some(r => r.symbolic && /^refs\/(heads|tags)\//.test(r.name))) throw new Error('Символические ссылки внутри локальных веток/тегов не поддерживаются.');
    const unsupported = refs.filter(r => !/^refs\/(heads|tags|remotes|rehistory|codex)\//.test(r.name));
    if (unsupported.length) throw new Error(`Неподдерживаемые ссылки (stash/notes/replace и др.): ${unsupported.map(r => r.name).join(', ')}. Сначала сохраните их отдельно и уберите из рабочей копии.`);
    if (existsSync(join(this.common, 'info', 'grafts'))) throw new Error('Обнаружен info/grafts: переписывание остановлено.');
    if (this.text(['worktree', 'list', '--porcelain']).split('\n').filter(x => x.startsWith('worktree ')).length > 1) throw new Error('Обнаружены дополнительные worktree. Используйте отдельный полный клон.');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
      if (existsSync(this.text(['rev-parse', '--path-format=absolute', '--git-path', name]))) throw new Error(`Незавершённая операция Git: ${name}.`);
    }
    if (this.text(['rev-parse', '--is-bare-repository']) !== 'true' && this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).length) throw new Error('Рабочее дерево и индекс должны быть чистыми, включая untracked-файлы и подмодули.');
    const head = this.text(['symbolic-ref', '-q', 'HEAD']);
    const headOid = this.text(['rev-parse', '--verify', 'HEAD']);
    if (!refs.some(r => r.name === head && r.name.startsWith('refs/heads/'))) throw new Error('HEAD должен указывать на существующую локальную ветку.');
    return { refs, head, headOid };
  }
}

export function parts(data: Buffer): { headers: Buffer[]; message: Buffer } {
  const end = data.indexOf('\n\n');
  if (end < 0) throw new Error('Некорректный Git-объект: нет разделителя заголовков.');
  const headers: Buffer[] = [];
  for (const line of data.subarray(0, end).toString('latin1').split('\n')) {
    if (line.startsWith(' ')) {
      if (!headers.length) throw new Error('Некорректное продолжение заголовка.');
      headers[headers.length - 1] = Buffer.concat([headers.at(-1)!, Buffer.from(`\n${line}`, 'latin1')]);
    } else headers.push(Buffer.from(line, 'latin1'));
  }
  return { headers, message: data.subarray(end + 2) };
}
export function field(header: Buffer): string { return header.subarray(0, header.indexOf(' ')).toString('ascii'); }
function assemble(headers: Buffer[], message: Buffer): Buffer { return Buffer.concat([...headers.flatMap((h, i) => i ? [Buffer.from('\n'), h] : [h]), Buffer.from('\n\n'), message]); }
export function validateIdentity(name: string, email: string): void {
  if (!name.trim() || /[<>\p{Cc}\p{Cf}]/u.test(name) || name.length > 200) throw new Error('Имя должно содержать 1–200 символов без <, > и управляющих символов.');
  if (email.length > 254 || !/^[^\s<>@\p{Cc}\p{Cf}]+@[^\s<>@\p{Cc}\p{Cf}]+$/u.test(email)) throw new Error('Введите email вида name@example.org без пробелов и управляющих символов.');
}
function identity(header: Buffer, timestamp: number, replacement?: Options['identity']): Buffer {
  const text = header.toString('latin1');
  const match = /^(author|committer|tagger) (.*) (-?\d+) ([+-]\d{4})$/.exec(text);
  if (!match) throw new Error('Некорректная дата или идентичность в коммите.');
  const who = replacement ? Buffer.from(`${replacement.name} <${replacement.email}>`, 'utf8') : Buffer.from(match[2], 'latin1');
  return Buffer.concat([Buffer.from(`${match[1]} `), who, Buffer.from(` ${timestamp} +0000`)]);
}

/** Remove one trailing signature block without discarding ambiguous message text. */
export function stripTagSignature(message: Buffer): { message: Buffer; stripped: boolean } {
  const marker = /(?:^|\n)-----BEGIN (?:PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----/.exec(message.toString('latin1'));
  if (!marker) return { message, stripped: false };
  const offset = marker.index + (message[marker.index] === 10 ? 1 : 0);
  const block = message.subarray(offset).toString('latin1');
  const boundaries = [...block.matchAll(/^-----(?:BEGIN|END) [A-Z0-9 ]+-----\r?$/gm)];
  const complete = /^-----BEGIN (PGP SIGNATURE|SSH SIGNATURE)-----\r?\n[\s\S]*\r?\n-----END \1-----[\r\n]*$/.test(block);
  if (!complete || boundaries.length !== 2) {
    throw new Error('Неоднозначная подпись тега: незакрытый или вложенный блок, несколько подписей либо текст после подписи. История не изменена.');
  }
  return { message: message.subarray(0, offset), stripped: true };
}

export function makePlan(repo: Repository, options: Options): Plan {
  if (!Number.isSafeInteger(options.interval) || options.interval < 1 || options.interval > 31536000) throw new Error('Интервал: целое число от 1 до 31536000 секунд.');
  if (options.identity) validateIdentity(options.identity.name, options.identity.email);
  if (options.tagIdentity) validateIdentity(options.tagIdentity.name, options.tagIdentity.email);
  if (options.tagPolicy && !['normalize', 'preserve'].includes(options.tagPolicy)) throw new Error('Неизвестная политика дат тегов.');
  const { refs, head, headOid } = repo.inspect();
  const reachable = new Set(repo.text(['rev-list', headOid]).split('\n'));
  const selected = refs.filter(r => {
    if (r.name === head) return true;
    if (r.symbolic || !r.name.startsWith('refs/tags/')) return false;
    const target = repo.text(['rev-parse', '--verify', `${r.name}^{}`]);
    return reachable.has(target);
  });
  if (options.backupBranch) {
    repo.git(['check-ref-format', `refs/heads/${options.backupBranch}`]);
    if (refs.some(r => r.name === `refs/heads/${options.backupBranch}`)) throw new Error('Бекап-ветка уже существует.');
  }
  // Use --stdin to avoid the argument length limit.
  // Put parents first, even if the original dates are incorrect.
  const commits = repo.text(['rev-list', '--topo-order', '--reverse', '--stdin'], selected.map(r => r.oid).join('\n') + '\n').split('\n').filter(Boolean);
  if (!commits.length) throw new Error('Нет коммитов для переписывания.');
  const last = options.start + (commits.length - 1) * options.interval;
  if (!Number.isSafeInteger(options.start) || options.start < 0 || !Number.isSafeInteger(last) || last > 253402300799) throw new Error('Даты должны находиться между 1970 и 9999 годом.');
  const mapping = new Map<string, string>();
  const objects: ObjectData[] = [];
  let stripped = 0;
  let totalBytes = 0;
  const add = (old: string, type: ObjectData['type'], data: Buffer): string => {
    totalBytes += data.length;
    if (totalBytes > 128 * 1024 * 1024) throw new Error('Объём метаданных истории превышает безопасный лимит 128 МиБ.');
    const oid = repo.text(['hash-object', '-t', type, '--stdin'], data);
    objects.push({ type, data, oid }); mapping.set(old, oid); return oid;
  };
  for (const [index, old] of commits.entries()) {
    const { headers, message } = parts(repo.git(['cat-file', 'commit', old]));
    const updated: Buffer[] = [];
    for (const h of headers) {
      const key = field(h);
      if (['gpgsig', 'gpgsig-sha256', 'mergetag'].includes(key)) { stripped++; continue; }
      if (key === 'parent') {
        const parent = mapping.get(h.subarray(7).toString('ascii'));
        if (!parent) throw new Error('Родитель коммита отсутствует в плане.');
        updated.push(Buffer.from(`parent ${parent}`));
      } else if (key === 'author' || key === 'committer') {
        updated.push(identity(h, options.start + index * options.interval, options.identity));
      } else updated.push(h);
    }
    add(old, 'commit', assemble(updated, message));
  }
  const dates = new Map(commits.map((old, index) => [old, options.start + index * options.interval]));
  const active = new Set<string>();
  function rewriteTag(old: string): string {
    if (mapping.has(old)) return mapping.get(old)!;
    if (active.has(old)) throw new Error('Циклическая ссылка тегов.');
    active.add(old);
    if (repo.text(['cat-file', '-t', old]) !== 'tag') throw new Error('Тег указывает на дерево/blob. Такие теги не поддерживаются.');
    const { headers, message } = parts(repo.git(['cat-file', 'tag', old]));
    const target = headers.find(h => field(h) === 'object')?.subarray(7).toString('ascii');
    if (!target) throw new Error('Тег без object.');
    const rewritten = rewriteTag(target);
    const signature = stripTagSignature(message);
    if (signature.stripped) stripped++;
    const date = dates.get(target);
    if (date === undefined) throw new Error('Не удалось определить дату конечного коммита тега.');
    if (!headers.some(h => field(h) === 'tagger')) throw new Error('Annotated-тег без tagger: обработка остановлена.');
    const updated = headers.map(h => {
      if (field(h) === 'object') return Buffer.from(`object ${rewritten}`);
      if (field(h) !== 'tagger') return h;
      if (options.tagPolicy !== 'preserve') return identity(h, date, options.tagIdentity);
      if (!options.tagIdentity) return h;
      const match = / (-?\d+) ([+-]\d{4})$/.exec(h.toString('latin1'));
      if (!match) throw new Error('Некорректная дата tagger.');
      return Buffer.concat([Buffer.from(`tagger ${options.tagIdentity.name} <${options.tagIdentity.email}>`), Buffer.from(match[0])]);
    });
    const result = add(old, 'tag', assemble(updated, signature.message));
    dates.set(old, date);
    active.delete(old); return result;
  }
  for (const ref of selected) if (!mapping.has(ref.oid)) rewriteTag(ref.oid);
  return { repo, options, refs, selected, objects, mapping, commits: commits.length, stripped, head, headOid, commitOrder: commits.map(old => mapping.get(old)!) };
}

export function applyPlan(plan: Plan): { recovery: string; backupPrefix?: string } {
  const { repo, options } = plan;
  const lock = join(repo.common, 'rehistory.lock');
  const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let recovery = '';
  try {
    writeFileSync(fd, `${process.pid}\n`);
    const snapshot = repo.inspect();
    if (JSON.stringify(snapshot.refs) !== JSON.stringify(plan.refs) || snapshot.head !== plan.head || snapshot.headOid !== plan.headOid) throw new Error('Репозиторий изменился после построения плана. Запустите скрипт заново.');
    const id = randomUUID();
    const backupPrefix = options.backupBranch ? `refs/rehistory/backups/${id}` : undefined;
    // Create the file exclusively. Do not overwrite a file or a symbolic link.
    recovery = join(repo.common, `rehistory-recovery-${id}.json`);
    const recoveryFd = openSync(recovery, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(recoveryFd, JSON.stringify({ version: 1, head: plan.head, backupPrefix, refs: plan.selected.map(r => ({ name: r.name, old: r.oid, new: plan.mapping.get(r.oid) })), backupBranch: options.backupBranch }, null, 2) + '\n');
      fsyncSync(recoveryFd);
    } finally { closeSync(recoveryFd); }
    for (const object of plan.objects) {
      if (repo.text(['hash-object', '-w', '-t', object.type, '--stdin'], object.data) !== object.oid) throw new Error('Контрольная сумма записанного объекта не совпала.');
    }
    // Verify all original direct refs, including refs that stay unchanged.
    // Use no-deref to prevent writes through a substituted symbolic ref.
    // Compare old object IDs to detect concurrent branch changes.
    const commands = ['start'];
    const selectedNames = new Set(plan.selected.map(r => r.name));
    for (const ref of plan.refs.filter(r => !r.symbolic)) {
      commands.push('option no-deref');
      commands.push(selectedNames.has(ref.name)
        ? `update ${ref.name} ${plan.mapping.get(ref.oid)!} ${ref.oid}`
        : `verify ${ref.name} ${ref.oid}`);
    }
    if (backupPrefix) {
      for (const ref of plan.selected) commands.push(`create ${backupPrefix}/${ref.name.slice(5)} ${ref.oid}`);
      commands.push(`create refs/heads/${options.backupBranch} ${plan.headOid}`);
    }
    const final = repo.inspect();
    if (JSON.stringify(final) !== JSON.stringify(snapshot)) throw new Error('Состояние Git изменилось во время записи объектов. Ссылки не обновлены.');
    commands.push('prepare', 'commit', '');
    repo.git(['update-ref', '-m', 'reHistory: переписывание истории', '--stdin'], commands.join('\n'));
    return { recovery, backupPrefix };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}${recovery ? `\nПлан восстановления: ${recovery}` : ''}`);
  } finally {
    closeSync(fd); unlinkSync(lock);
  }
}
