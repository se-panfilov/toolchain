import { spawnSync } from 'node:child_process';
import { constants, existsSync, openSync, closeSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

type Ref = { name: string; oid: string; symbolic: string };
export type Options = { interval: number; start: number; identity?: { name: string; email: string }; backupBranch?: string };
type ObjectData = { type: 'commit' | 'tag'; data: Buffer; oid: string };
export type Plan = { repo: Repository; options: Options; refs: Ref[]; selected: Ref[]; objects: ObjectData[]; mapping: Map<string, string>; commits: number; stripped: number; head: string; headOid: string };

// Git вызывается без shell. Убираем наследуемые перенаправления Git,
// чтобы --repo всегда выбирал именно указанный репозиторий.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' });
export class Repository {
  path: string;
  common: string;
  constructor(path: string) {
    this.path = resolve(path);
    this.common = this.text(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  }
  git(args: string[], input?: Buffer | string): Buffer {
    const result = spawnSync('git', ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-C', this.path, ...args], {
      env, input, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
    });
    if (result.error) throw new Error(`Не удалось запустить Git: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Git ${args[0]}: ${result.stderr?.toString('utf8').trim() || `код ${result.status}`}`);
    return result.stdout;
  }
  text(args: string[], input?: Buffer | string): string { return this.git(args, input).toString('utf8').trim(); }
  refs(): Ref[] {
    const output = this.text(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)']);
    return output ? output.split('\n').map(line => { const [name, oid, symbolic] = line.split('\0'); return { name, oid, symbolic }; }) : [];
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
    const unsupported = refs.filter(r => !/^refs\/(heads|tags|remotes|rehistory)\//.test(r.name));
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

function parts(data: Buffer): { headers: Buffer[]; message: Buffer } {
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
function field(header: Buffer): string { return header.subarray(0, header.indexOf(' ')).toString('ascii'); }
function assemble(headers: Buffer[], message: Buffer): Buffer { return Buffer.concat([...headers.flatMap((h, i) => i ? [Buffer.from('\n'), h] : [h]), Buffer.from('\n\n'), message]); }
export function validateIdentity(name: string, email: string): void {
  if (!name.trim() || /[<>\p{Cc}\p{Cf}]/u.test(name) || name.length > 200) throw new Error('Имя должно содержать 1–200 символов без <, > и управляющих символов.');
  if (email.length > 254 || !/^[^\s<>@\p{Cc}\p{Cf}]+@[^\s<>@\p{Cc}\p{Cf}]+$/u.test(email)) throw new Error('Введите email вида name@example.org без пробелов и управляющих символов.');
}
function identity(header: Buffer, timestamp: number, replacement?: Options['identity']): Buffer {
  const text = header.toString('latin1');
  const match = /^(author|committer) (.*) (-?\d+) ([+-]\d{4})$/.exec(text);
  if (!match) throw new Error('Некорректная дата или идентичность в коммите.');
  const who = replacement ? Buffer.from(`${replacement.name} <${replacement.email}>`, 'utf8') : Buffer.from(match[2], 'latin1');
  return Buffer.concat([Buffer.from(`${match[1]} `), who, Buffer.from(` ${timestamp} +0000`)]);
}
export function makePlan(repo: Repository, options: Options): Plan {
  if (!Number.isSafeInteger(options.interval) || options.interval < 1 || options.interval > 31536000) throw new Error('Интервал: целое число от 1 до 31536000 секунд.');
  if (options.identity) validateIdentity(options.identity.name, options.identity.email);
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
  // --stdin обходит ограничение длины argv. Топологический порядок гарантирует,
  // что родитель получит более раннюю дату даже при исходно неверных часах.
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
    let body = message;
    const marker = /(?:^|\n)-----BEGIN (?:PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----/m.exec(message.toString('latin1'));
    if (marker) { body = message.subarray(0, marker.index + (message[marker.index] === 10 ? 1 : 0)); stripped++; }
    const result = add(old, 'tag', assemble(headers.map(h => field(h) === 'object' ? Buffer.from(`object ${rewritten}`) : h), body));
    active.delete(old); return result;
  }
  for (const ref of selected) if (!mapping.has(ref.oid)) rewriteTag(ref.oid);
  return { repo, options, refs, selected, objects, mapping, commits: commits.length, stripped, head, headOid };
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
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const backupPrefix = options.backupBranch ? `refs/rehistory/backups/${id}` : undefined;
    // Эксклюзивное создание исключает перезапись, включая цели символических ссылок.
    recovery = join(repo.common, `rehistory-recovery-${id}.json`);
    const recoveryFd = openSync(recovery, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(recoveryFd, JSON.stringify({ version: 1, head: plan.head, backupPrefix, refs: plan.selected.map(r => ({ name: r.name, old: r.oid, new: plan.mapping.get(r.oid) })), backupBranch: options.backupBranch }, null, 2) + '\n');
      fsyncSync(recoveryFd);
    } finally { closeSync(recoveryFd); }
    for (const object of plan.objects) {
      if (repo.text(['hash-object', '-w', '-t', object.type, '--stdin'], object.data) !== object.oid) throw new Error('Контрольная сумма записанного объекта не совпала.');
    }
    // Проверяем все исходные прямые ссылки, включая неизменяемые. no-deref
    // исключает запись в постороннюю цель при подмене ссылки символической.
    // Проверка старых хешей защищает от конкурирующего перемещения веток.
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
