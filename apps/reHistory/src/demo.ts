import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { auditRepository, auditText } from '@reHistory/audit';
import { applyPlan,makePlan, Repository, runGit } from '@reHistory/engine';
import { exportPlan } from '@reHistory/export';
import { networkGit,validateRemoteURL } from '@reHistory/remote';

/** Demo still requires a URL before any files or network calls. */
export function validateDemoURL(value: string | undefined): string {
  if (!value) throw new Error('Для demo обязателен --demo-remote URL. Ничего не создано.');
  return validateRemoteURL(value);
}
export type DemoTransport = { refs: (repo: Repository, url: string) => string; push: (repo: Repository, url: string, refspecs: string[]) => void };
const transport: DemoTransport = {
  refs: (repo, url) => networkGit(repo, ['ls-remote', '--refs', url]).toString('utf8').trim(),
  push: (repo, url, refspecs) => {
    networkGit(repo, ['push', '--atomic', '--', url, ...refspecs]);
  }
};

/** Use the shared rewrite engine. Supply automatic answers only for a new demo copy. */
export type DemoResult = {
  ok: boolean;
  root: string;
  source: string;
  exported: ReturnType<typeof exportPlan>;
  originalCommits: number;
  serverNamespace: string;
  remoteUnchangedAfterRewrite: boolean;
};
export function runDemo(options: { remote: string; directory?: string; print?: (text: string) => void }, connection: DemoTransport = transport): DemoResult {
  const url = validateDemoURL(options.remote); // Validate before any file write.
  const log = options.print || (() => {});
  // Make sure that the server is empty before demo creation. Do not push yet.
  if (runRemoteProbe(url, connection)) throw new Error('Demo требует пустой серверный репозиторий. Push не выполнялся.');
  let root: string;
  if (options.directory) {
    root = resolve(options.directory);
    mkdirSync(root, { mode: 0o700 });
  } else root = mkdtempSync(join(tmpdir(), 'rehistory-demo-'));
  log(`Demo-каталог: ${root}`);
  try {
    const source = join(root, 'source');
    mkdirSync(source, { mode: 0o700 });
    runGit(source, ['init', '-q', '--template=', '--initial-branch=main']);
    const repo = new Repository(source);
    repo.git(['config', 'user.name', 'Demo Автор']);
    repo.git(['config', 'user.email', 'demo@example.invalid']);
    const namespace = `rehistory-demo-${randomUUID()}`;
    let counter = 0;
    const base = Math.floor(Date.now() / 1000) - 86400;
    function commit(label: string): void {
      counter++;
      writeFileSync(join(source, 'demo.txt'), `${label}\n${counter}\n`);
      repo.git(['add', '--', 'demo.txt']);
      const date = `${base + counter * 3} +0000`;
      repo.git(['commit', '-q', '-m', label], undefined, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    }
    function tag(label: string, annotated: boolean): void {
      repo.git(['tag', ...(annotated ? ['-a', '-m', `Demo: ${label}`] : []), `${namespace}-${label}`], undefined, { GIT_COMMITTER_DATE: `${base + counter * 3 + 1} +0000` });
    }
    function specifications(): string[] {
      return repo
        .refs()
        .filter((r) => !r.symbolic && /^(refs\/heads\/|refs\/tags\/)/.test(r.name))
        .map((r) => `${r.name}:${r.name.startsWith('refs/heads/') ? `refs/heads/${namespace}/${r.name.slice(11)}` : r.name}`);
    }
    log('Создаю 10 коммитов main с датами через 3 секунды и теги.');
    for (let i = 1; i <= 10; i++) {
      commit(`Demo main ${i}`);
      if (i === 3 || i === 7 || i === 10) tag(`main-${i}`, i !== 3);
    }
    if (connection.refs(repo, url)) throw new Error('Сервер перестал быть пустым. Push отменён.');
    connection.push(repo, url, specifications());
    log('Начальная main и теги отправлены. Создаю 3 ветки по 2 коммита с тегами.');
    for (let branch = 1; branch <= 3; branch++) {
      repo.git(['checkout', '-q', '-b', `feature-${branch}`, 'main']);
      for (let i = 1; i <= 2; i++) {
        commit(`Demo feature ${branch}: ${i}`);
        tag(`feature-${branch}-${i}`, i === 2);
      }
    }
    connection.push(repo, url, specifications());
    repo.git(['checkout', '-q', 'main']);
    const serverBefore = connection.refs(repo, url);
    log('Все исходные ветки и теги отправлены. Выполняю обычное переписывание main общим движком.');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const settings = {
      start: today.getTime() / 1000,
      interval: 1,
      tagPolicy: 'normalize' as const,
      backupBranch: 'rehistory-backup/demo',
      identity: { name: 'Demo Нормализованный', email: 'normalized@example.invalid' },
      tagIdentity: { name: 'Demo Нормализованный', email: 'normalized@example.invalid' }
    };
    applyPlan(makePlan(repo, settings));
    const audit = auditRepository(repo);
    log(auditText(audit));
    if (!audit.complete || !audit.refs.some((r) => r.backup) || !audit.commits.some((c) => !c.inCurrentHistory)) throw new Error('Demo-аудит не обнаружил ожидаемую исходную историю вне main.');
    // The source already has these dates. The same settings give the same objects.
    const exported = exportPlan(makePlan(repo, { ...settings, backupBranch: undefined }), join(root, 'export.git'));
    const exportAudit = auditRepository(new Repository(exported.repository));
    if (!exportAudit.complete || exportAudit.reflog.entries || exportAudit.unreachable.count || exportAudit.refs.some((r) => r.backup || !r.inCurrentHistory))
      throw new Error('Экспорт demo содержит посторонние метаданные.');
    if (serverBefore !== connection.refs(repo, url)) throw new Error('Серверные ссылки неожиданно изменились после переписывания.');
    const summary = { ok: true, root, source, exported, originalCommits: counter, serverNamespace: namespace, remoteUnchangedAfterRewrite: true };
    writeFileSync(join(root, 'demo-result.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    log(`DEMO УСПЕШНО: создано ${counter} исходных коммитов; экспорт проверен (${exported.commits} коммитов).\nРезультаты: ${root}\nПереписанная история и экспорт на сервер не отправлялись.`);
    return summary;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nDemo остановлено. Созданные файлы сохранены в ${root}; ранее выполненные push не откатываются.`, { cause: error });
  }
}
function runRemoteProbe(url: string, connection: DemoTransport): string {
  // Isolate ls-remote from local config in the current directory or its parents.
  // The probe directory is not a repository. Remove only this directory.
  const directory = mkdtempSync(join(tmpdir(), 'rehistory-probe-'));
  try {
    const probe = Object.create(Repository.prototype) as Repository;
    probe.path = directory;
    probe.git = (args, input, extraEnv = {}) => runGit(directory, args, input, { ...extraEnv, GIT_CEILING_DIRECTORIES: dirname(directory) });
    return connection.refs(probe, url);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
