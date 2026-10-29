import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Repository, parts, field } from '#rehistory/engine';

export type Stamp = { identity: string; timestamp: number; timezone: string };
export function stamp(data: Buffer, key: string): Stamp {
  const header = parts(data).headers.find(h => field(h) === key);
  const match = header && /^(?:author|committer|tagger) (.*) (-?\d+) ([+-]\d{4})$/.exec(header.toString('utf8'));
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error(`Некорректный заголовок ${key}.`);
  return { identity: match[1], timestamp: Number(match[2]), timezone: match[3] };
}
export function inventory(repo: Repository): { oid: string; type: string }[] {
  const output = repo.text(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']);
  return output ? output.split('\n').map(line => {
    const [oid, type] = line.split(' ');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || !['blob', 'tree', 'commit', 'tag'].includes(type)) throw new Error('Некорректная опись объектов Git.');
    return { oid, type };
  }) : [];
}
export function objectClosure(repo: Repository, roots: string[]): Set<string> {
  if (!roots.length) return new Set();
  return new Set(repo.text(['rev-list', '--objects', '--no-object-names', '--stdin'], roots.join('\n') + '\n').split('\n').filter(Boolean));
}

/** Read all refs and objects, including objects outside the selected branch. */
export function auditRepository(repo: Repository) {
  const warnings: string[] = [];
  let complete = true;
  function read(args: string[]): string {
    try { return repo.text(args); }
    catch (error) { complete = false; warnings.push(error instanceof Error ? error.message : String(error)); return ''; }
  }
  const refs = repo.refs();
  const config = read(['config', '--list']);
  const partial = /^(remote\..*\.promisor(?:=|$)|extensions\.partialclone(?:=|$))/mi.test(config);
  const shallow = read(['rev-parse', '--is-shallow-repository']) === 'true';
  const grafts = existsSync(join(repo.common, 'info', 'grafts'));
  if (partial || shallow || grafts) {
    complete = false;
    warnings.push('Partial clone, shallow или grafts: полнота истории не гарантируется; загрузка недостающих объектов отключена.');
  }
  // Do not resolve missing objects in a partial clone.
  let objects: ReturnType<typeof inventory> = [];
  try { objects = inventory(repo); } catch (error) { complete = false; warnings.push(String(error)); }
  let headOid = '';
  try { headOid = repo.text(['rev-parse', '--verify', 'HEAD']); } catch { warnings.push('HEAD не указывает на существующий коммит.'); }
  const current = new Set(headOid && !partial ? read(['rev-list', headOid]).split('\n').filter(Boolean) : []);
  let reachable = new Set<string>();
  try { if (!partial) reachable = objectClosure(repo, refs.filter(r => !r.symbolic).map(r => r.oid)); }
  catch (error) { complete = false; warnings.push(String(error)); }
  const reflog = read(['reflog', 'show', '--all', '--date=iso-strict', '--format=%H%x00%gD']).split('\n').filter(Boolean);
  const reflogRefs = [...new Set(reflog.map(line => line.split('\0')[1]?.replace(/@\{.*$/, '')).filter(Boolean))];
  const fromReflog = new Set(!partial ? read(['rev-list', '--objects', '--no-object-names', '--reflog', '--all']).split('\n').filter(Boolean) : []);
  const commits: { oid: string; author: Stamp; committer: Stamp; inCurrentHistory: boolean; reachableFromRefs: boolean; protectedByReflog: boolean }[] = [];
  const tags: { oid: string; target: string; tagger: Stamp; reachableFromRefs: boolean }[] = [];
  for (const object of objects) {
    if (object.type !== 'commit' && object.type !== 'tag') continue;
    try {
      const raw = repo.git(['cat-file', object.type, object.oid]);
      if (object.type === 'commit') commits.push({ oid: object.oid, author: stamp(raw, 'author'), committer: stamp(raw, 'committer'), inCurrentHistory: current.has(object.oid), reachableFromRefs: reachable.has(object.oid), protectedByReflog: fromReflog.has(object.oid) });
      else tags.push({ oid: object.oid, target: parts(raw).headers.find(h => field(h) === 'object')?.subarray(7).toString('ascii') || '', tagger: stamp(raw, 'tagger'), reachableFromRefs: reachable.has(object.oid) });
    } catch (error) { complete = false; warnings.push(`${object.oid}: ${error instanceof Error ? error.message : error}`); }
  }
  const refDetails = refs.map(ref => {
    let target = ref.oid;
    if (!partial) target = read(['rev-parse', '--verify', `${ref.name}^{}`]) || ref.oid;
    return { ...ref, target, inCurrentHistory: current.has(target), backup: ref.name.startsWith('refs/rehistory/') || ref.name.startsWith('refs/heads/rehistory-backup/') };
  });
  const gitDir = read(['rev-parse', '--absolute-git-dir']);
  const files = [...new Set([repo.common, gitDir])].flatMap(dir => dir ? readdirSync(dir).filter(name => name.startsWith('rehistory-recovery-') || name === 'rehistory.lock').map(name => join(dir, name)) : []);
  const alternates = existsSync(join(repo.common, 'objects', 'info', 'alternates'));
  const worktrees = read(['worktree', 'list', '--porcelain']);
  const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START'].filter(name => existsSync(read(['rev-parse', '--path-format=absolute', '--git-path', name])));
  const submodules = headOid && !partial ? read(['ls-tree', '-r', headOid]).split('\n').some(line => line.startsWith('160000 ')) : false;
  const unreachable = objects.filter(o => !reachable.has(o.oid));
  const unreachableByType = Object.fromEntries(['commit', 'tag', 'tree', 'blob'].map(type => [type, unreachable.filter(o => o.type === type).length]));
  if (reflog.length) warnings.push('Reflog сохраняет предыдущие положения ссылок и время операций.');
  if (unreachable.length) warnings.push('Есть объекты, недостижимые из текущих refs; они могут содержать старые метаданные.');
  if (files.length || refDetails.some(r => r.backup)) warnings.push('Обнаружены файлы восстановления, блокировка или резервные ссылки reHistory.');
  if (submodules) warnings.push('Есть подмодули: их собственная история не входит в этот аудит.');
  if (alternates) warnings.push('Используется внешнее хранилище объектов (alternates).');
  if (JSON.stringify(repo.refs()) !== JSON.stringify(refs)) { complete = false; warnings.push('Ссылки изменились во время аудита. Повторите его без параллельных Git-операций.'); }
  return {
    version: 1, complete, repository: repo.path, headOid, refs: refDetails, commits, tags,
    reflog: { entries: reflog.length, refs: reflogRefs, records: reflog.map(line => { const [oid, selector] = line.split('\0'); return { oid, selector }; }) }, unreachable: { count: unreachable.length, byType: unreachableByType },
    metadata: { partial, shallow, grafts, alternates, files, operations, submodules, worktreeCount: worktrees.split('\n').filter(x => x.startsWith('worktree ')).length, remoteNames: [...new Set(config.split('\n').map(line => /^remote\.(.*)\.url=/.exec(line)?.[1]).filter(Boolean))] },
    warnings,
  };
}
export type AuditReport = ReturnType<typeof auditRepository>;
export function auditText(report: AuditReport): string {
  const lines = [`АУДИТ: ${report.repository}`, `Полнота проверки: ${report.complete ? 'полная локальная опись' : 'НЕПОЛНАЯ — см. предупреждения'}`, `Коммитов в хранилище: ${report.commits.length}; в текущей истории: ${report.commits.filter(c => c.inCurrentHistory).length}`, `Annotated-объектов тегов: ${report.tags.length}`, `Reflog: ${report.reflog.entries} записей`, `Объектов вне текущих refs: ${report.unreachable.count}`, 'Ссылки:'];
  for (const ref of report.refs) lines.push(`  ${ref.name} → ${ref.target}${ref.inCurrentHistory ? ' [в текущей истории]' : ' [ВНЕ текущей истории]'}${ref.backup ? ' [бекап]' : ''}`);
  lines.push(`Рабочих деревьев: ${report.metadata.worktreeCount}; незавершённые операции: ${report.metadata.operations.join(', ') || 'нет'}; remotes: ${report.metadata.remoteNames.join(', ') || 'нет'}`);
  for (const record of report.reflog.records) lines.push(`  reflog ${record.selector}: ${record.oid}`);
  lines.push('Даты коммитов (Unix-секунды и исходный часовой пояс):');
  for (const c of report.commits) lines.push(`  ${c.oid}: author=${c.author.timestamp} ${c.author.timezone}; committer=${c.committer.timestamp} ${c.committer.timezone}${!c.reachableFromRefs ? ' [вне refs]' : ''}`);
  lines.push('Собственные даты annotated-тегов:');
  for (const tag of report.tags) lines.push(`  ${tag.oid}: tagger=${tag.tagger.timestamp} ${tag.tagger.timezone}; ${tag.tagger.identity}`);
  for (const file of report.metadata.files) lines.push(`Служебный файл: ${file}`);
  for (const warning of report.warnings) lines.push(`Внимание: ${warning}`);
  lines.push('Аудит ничего не удаляет и не подтверждает фактическое время выполнения работы.');
  return lines.join('\n');
}
