#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { auditRepository, auditText } from '@reHistory/audit';
import { runDemo, validateDemoURL } from '@reHistory/demo';
import { applyPlan, defaultBackupBranch, type Flow, flows, makePlan, normalizeCommitMessage, type Options, type Plan, Repository, terminalJSON, validateIdentity } from '@reHistory/engine';
import { exportDestination, exportPlan, verifyExport } from '@reHistory/export';
import { PromptCancelled, TerminalPrompts, terminalStyle } from '@reHistory/prompts';
import { executePush, preparePush, pushRemotes, type RemoteCopy, remoteCopy, sharedTags, updateTrackingRef } from '@reHistory/remote';

// Git metadata and errors can contain terminal control characters.
function safe(value: unknown): string {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' ? ch : '?'));
}
const style = terminalStyle();
function print(value: unknown, tone: keyof ReturnType<typeof terminalStyle> = 'plain'): void {
  console.log(style[tone](safe(value)));
}
function help(): void {
  print(`reHistory — переписывание времени, авторов или сообщений коммитов текущей ветки и её тегов.
Node.js 24.12+, Git 2.39+. Запуск: node /путь/toolchain/apps/reHistory/dist/src/cli.js [параметры]

  --repo PATH          Исходный репозиторий (по умолчанию текущий каталог).
  --dry-run            Рассчитать план без записи; совместим с --export.
  --audit              Аудит всего локального хранилища без изменений, без TTY.
  --json               JSON-отчёт для --audit или --verify-export.
  --export NEW_PATH    Нормализовать в новый bare-репозиторий, не меняя исходный.
  --verify-export PATH Повторно проверить созданный экспорт без изменений.
  --demo               Автоматический сценарий в новом отдельном каталоге.
  --demo-remote URL    ОБЯЗАТЕЛЬНЫЙ пустой сервер для demo (HTTPS/SSH).
  --demo-dir NEW_PATH  Новый каталог demo; по умолчанию — системный temp.
  --help               Справка.

Переписывание и экспорт интерактивны. За один запуск выполняется один флоу:
время, авторы или сообщения коммитов. Переписывание на месте требует, чтобы
коммиты ветки были в remote-ветках (refs/remotes/*). После переписывания можно
отдельно подтвердить push ветки и её тегов с точными force-with-lease. По умолчанию push выключен.
Demo отправляет только тестовые данные на явно указанный сервер. Публикация npm не выполняется.
Подробности и восстановление: README.md и SECURITY.md пакета.`);
}
export function parseDate(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new Error('Такой даты не существует.');
    return date.getTime() / 1000;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Формат: ГГГГ-ММ-ДД либо ГГГГ-ММ-ДДTЧЧ:ММ:СС+ЧЧ:ММ.');
  const [y, m, d, h, min, sec] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d || h > 23 || min > 59 || sec > 59) throw new Error('Некорректные дата или время.');
  if (value.endsWith('Z') === false) {
    const offset = value.slice(-5).split(':').map(Number);
    if (offset[0] > 23 || offset[1] > 59) throw new Error('Некорректный часовой пояс.');
  }
  const result = Date.parse(value) / 1000;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Дата должна быть не раньше 1970 года.');
  return result;
}

/** Read separate date and time values. Use the system time zone without a suffix. */
export function parseStart(date: string, time: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Дата: ГГГГ-ММ-ДД.');
  // Validate the calendar date independently of local midnight transitions.
  parseDate(`${date}T00:00:00Z`);
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(time);
  if (!match) throw new Error('Время: ЧЧ:ММ[:СС], при необходимости с +ЧЧ:ММ или Z.');
  const [, hour, minute, seconds = '00', zone] = match;
  const [h, min, sec] = [hour, minute, seconds].map(Number);
  if (h > 23 || min > 59 || sec > 59) throw new Error('Некорректное время.');
  if (zone) {
    const timestamp = parseDate(`${date}T${hour}:${minute}:${seconds}${zone}`);
    if (timestamp > 253402300799) throw new Error('Дата и время должны находиться в пределах 1970–9999 годов.');
    return timestamp;
  }
  const [y, m, d] = date.split('-').map(Number);
  const local = new Date(0);
  local.setFullYear(y, m - 1, d);
  local.setHours(h, min, sec, 0);
  if (local.getFullYear() !== y || local.getMonth() !== m - 1 || local.getDate() !== d || local.getHours() !== h || local.getMinutes() !== min || local.getSeconds() !== sec)
    throw new Error('В этом часовом поясе такого времени нет. Измените время или укажите смещение.');
  const timestamp = local.getTime() / 1000;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 253402300799) throw new Error('Дата и время должны находиться в пределах 1970–9999 годов.');
  return timestamp;
}

/**
 * Decide if an in-place rewrite can start. Unpushed commits stop it.
 * A repository without remote-tracking refs needs an explicit confirmation. A dry-run only shows warnings.
 */
export function remoteGate(copy: RemoteCopy, dryRun: boolean): 'ok' | 'block' | 'warn' | 'confirm' | 'notice' {
  if (copy.tracking && copy.unpushed) return dryRun ? 'warn' : 'block';
  if (!copy.tracking) return dryRun ? 'notice' : 'confirm';
  return 'ok';
}

export type Arguments = {
  path: string;
  dryRun: boolean;
  audit: boolean;
  json: boolean;
  demo: boolean;
  destination: string | undefined;
  verify: string | undefined;
  remote: string | undefined;
  demoDir: string | undefined;
};
export function parseArguments(args: string[]): Arguments {
  let path = process.cwd();
  let dryRun = false;
  let audit = false;
  let json = false;
  let demo = false;
  let destination: string | undefined;
  let verify: string | undefined;
  let remote: string | undefined;
  let demoDir: string | undefined;
  let explicitRepo = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Параметр указан повторно: ${arg}`);
    seen.add(arg);
    if (['--repo', '--export', '--verify-export', '--demo-remote', '--demo-dir'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Отсутствует значение ${arg}.`);
      if (arg === '--repo') {
        path = value;
        explicitRepo = true;
      }
      if (arg === '--export') destination = value;
      if (arg === '--verify-export') verify = value;
      if (arg === '--demo-remote') remote = value;
      if (arg === '--demo-dir') demoDir = value;
    } else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--audit') audit = true;
    else if (arg === '--json') json = true;
    else if (arg === '--demo') demo = true;
    else throw new Error(`Неизвестный аргумент: ${arg}. Используйте --help.`);
  }
  if ([audit, Boolean(destination), Boolean(verify), demo].filter(Boolean).length > 1) throw new Error('Выберите один режим: --audit, --export, --verify-export или --demo.');
  if (json && !audit && !verify) throw new Error('--json допустим только для аудита/проверки экспорта.');
  if (dryRun && (audit || verify || demo)) throw new Error('--dry-run допустим только для обычного режима и экспорта.');
  if (!demo && (remote || demoDir)) throw new Error('--demo-remote и --demo-dir требуют --demo.');
  if ((demo || verify) && explicitRepo) throw new Error('--repo не используется вместе с demo/проверкой экспорта.');
  if (demo) remote = validateDemoURL(remote);
  return { path, dryRun, audit, json, demo, destination, verify, remote, demoDir };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    help();
    return;
  }
  const mode = parseArguments(args);
  if (Number(process.versions.node.split('.')[0]) < 24 || (Number(process.versions.node.split('.')[0]) === 24 && Number(process.versions.node.split('.')[1]) < 12))
    throw new Error('Требуется Node.js 24.12 или новее.');
  if (mode.demo) {
    runDemo({ remote: mode.remote!, directory: mode.demoDir, print });
    return;
  }
  if (mode.verify) {
    const report = verifyExport(mode.verify);
    if (mode.json) console.log(terminalJSON(report));
    else {
      print(`${report.ok ? '✓ Экспорт проверен' : '✕ Проверка не пройдена'} · коммиты: ${report.commits} · теги: ${report.tags} · объекты: ${report.objects}`, report.ok ? 'success' : 'error');
      print(report.repository, 'muted');
      for (const error of report.errors) print(error, 'error');
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const repo = new Repository(mode.path);
  if (mode.audit) {
    const report = auditRepository(repo);
    if (mode.json) console.log(terminalJSON(report));
    else for (const line of auditText(report).split('\n')) print(line, line.startsWith('АУДИТ:') ? 'accent' : line.startsWith('Внимание:') ? 'warning' : 'plain');
    if (!report.complete) process.exitCode = 2;
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Нужен интерактивный терминал (TTY).');
  const state = repo.inspect();
  if (mode.destination) exportDestination(repo, mode.destination);
  print(`reHistory · ${mode.destination ? 'экспорт' : 'переписывание'}${mode.dryRun ? ' · dry-run' : ''}`, 'accent');
  print(`${repo.path} · ${state.head.slice(11)}`, 'muted');
  if (state.refs.some((r) => r.name.startsWith('refs/codex/'))) print('refs/codex/* сохраняют старую историю; в экспорт не входят.', 'warning');
  print('Не запускайте другие операции Git до завершения.', 'warning');
  const prompts = new TerminalPrompts();
  const ask = (question: string, initial?: string): Promise<string> => prompts.text(question, initial);
  const choose = (question: string, defaultYes: boolean): Promise<boolean> => prompts.confirm(question, defaultYes);
  async function newIdentity(): Promise<{ name: string; email: string }> {
    for (;;) {
      const name = await ask('Имя');
      const email = await ask('Email');
      try {
        validateIdentity(name, email);
        return { name, email };
      } catch (error) {
        print(error instanceof Error ? error.message : error);
      }
    }
  }
  async function offerPush(plan: Plan): Promise<void> {
    try {
      if (!(await choose('Сделать push?', false))) return;
      const remotes = pushRemotes(repo, plan.head);
      if (!remotes.names.length) {
        print('Remote не настроен. Локальная история сохранена.', 'warning');
        return;
      }
      const index = remotes.names.length === 1 ? 0 : await prompts.select('Remote для push', remotes.names, remotes.initial);
      const push = preparePush(plan, remotes.names[index]);
      print(`Push → ${push.remote} · ${push.url}`, 'accent');
      for (const ref of push.refs) print(`${ref.destination}: ${ref.expected ? ref.expected.slice(0, 12) : 'новая ссылка'} → ${ref.oid.slice(0, 12)}`);
      let includeOptional = false;
      if (push.optional.length) {
        print(`Теги, которые требуют отдельного решения: ${push.optional.length}`, 'warning');
        const reasons = { shared: 'есть в других ветках', new: 'нет на сервере' };
        for (const ref of push.optional)
          print(`  ${ref.destination}: ${ref.expected ? ref.expected.slice(0, 12) : 'новая ссылка'} → ${ref.oid.slice(0, 12)} · ${ref.reasons.map((reason) => reasons[reason]).join(', ')}`, 'warning');
        print('Перенос общих тегов уводит их из истории других веток, например релизные теги master. Новые теги станут публичными.', 'warning');
        includeOptional = await choose('Отправить и эти теги?', false);
      }
      print('Другие ссылки и старые копии остаются без изменений.', 'muted');
      if (!(await choose(includeOptional ? 'Отправить ветку и все показанные теги?' : 'Отправить ветку и теги без отдельного решения?', false))) {
        print('Push пропущен.');
        return;
      }
      executePush(push, undefined, includeOptional);
      if (push.optional.length && !includeOptional) print(`Не отправлены теги: ${push.optional.length}. Локально они уже переписаны.`, 'warning');
      print('✓ Push выполнен.', 'success');
      try {
        const tracking = updateTrackingRef(push);
        if (tracking) print(`Remote-ветка обновлена: ${tracking}`, 'muted');
        else print('Remote-ветка не обновлена локально. Перед следующим флоу выполните git fetch.', 'warning');
      } catch (error) {
        print(`Remote-ветка не обновлена локально. Перед следующим флоу выполните git fetch.\n${error instanceof Error ? error.message : error}`, 'warning');
      }
    } catch (error) {
      if (error instanceof PromptCancelled) {
        print('Push отменён. Локальная история сохранена.');
        return;
      }
      throw new Error(`Локальная история сохранена. Push не подтверждён; проверьте remote перед повтором.\n${error instanceof Error ? error.message : error}`, { cause: error });
    }
  }
  const flowLabels: Record<Flow, string> = { dates: 'Время коммитов', authors: 'Авторы коммитов', messages: 'Сообщения коммитов' };
  async function askDates(): Promise<Options> {
    let interval: number;
    for (;;) {
      const value = await ask('Интервал (в секундах)', '1');
      interval = Number(value);
      if (/^\d+$/.test(value) && Number.isSafeInteger(interval) && interval >= 1 && interval <= 31536000) break;
      print('Целое число: 1–31536000.');
    }
    const today = new Date();
    const dateDefault = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let date: string;
    for (;;) {
      date = await ask('Дата первого коммита', dateDefault);
      try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Дата: ГГГГ-ММ-ДД.');
        parseDate(`${date}T00:00:00Z`);
        break;
      } catch (error) {
        print(error instanceof Error ? error.message : error);
      }
    }
    let start: number;
    for (;;) {
      const time = await ask('Время первого коммита', '00:00:00');
      try {
        start = parseStart(date, time);
        break;
      } catch (error) {
        print(error instanceof Error ? error.message : error);
      }
    }
    const tagPolicy = (await choose('Нормализовать даты тегов?', true)) ? 'normalize' : 'preserve';
    return { flow: 'dates', start, interval, tagPolicy };
  }
  async function askAuthors(): Promise<Options> {
    const identity = await newIdentity();
    const tagIdentity = (await choose('То же имя/email для создателей тегов?', true)) ? identity : undefined;
    return { flow: 'authors', identity, tagIdentity };
  }
  async function askMessages(): Promise<Options> {
    for (;;) {
      const value = await ask('Новое сообщение');
      try {
        normalizeCommitMessage(value);
        return { flow: 'messages', commitMessage: value };
      } catch (error) {
        print(error instanceof Error ? error.message : error);
      }
    }
  }
  function describe(options: Options, plan: Plan): void {
    const tags = plan.selected.filter((r) => r.name.startsWith('refs/tags/')).length;
    print(`Флоу: ${flowLabels[options.flow]} · коммиты: ${plan.commits} · теги: ${tags}`);
    if (options.flow === 'dates') {
      print(`${new Date(options.start * 1000).toISOString()} → ${new Date((options.start + (plan.commits - 1) * options.interval) * 1000).toISOString()} · шаг: ${options.interval} с`);
      print(`Даты тегов: ${options.tagPolicy === 'preserve' ? 'сохранить исходными' : 'нормализовать'}`);
      print('Авторы и сообщения: без изменений', 'muted');
    } else if (options.flow === 'authors') {
      print(`Автор и коммитер: ${options.identity.name} <${options.identity.email}>`);
      print(`Создатель тегов: ${options.tagIdentity ? `${options.tagIdentity.name} <${options.tagIdentity.email}>` : 'без изменений'}`);
      print('Даты и сообщения: без изменений', 'muted');
    } else {
      print(`Сообщения: ${options.commitMessage}`);
      print('Даты, авторы и теги: без изменений', 'muted');
    }
  }
  try {
    // Rewrite in place only after the current history has a remote copy. Run one flow, push, then run the next flow.
    let gate: ReturnType<typeof remoteGate> = 'ok';
    if (!mode.destination) {
      const copy = remoteCopy(repo, state.headOid);
      gate = remoteGate(copy, mode.dryRun);
      const unpushed = `Незапушенные коммиты: ${copy.unpushed}. Сначала отправьте ветку на сервер и обновите remote-ссылки (git fetch).`;
      if (gate === 'block') throw new Error(unpushed);
      if (gate === 'warn') print(`${unpushed} Без dry-run запуск будет остановлен.`, 'warning');
      if (gate === 'confirm' || gate === 'notice') print('Нет remote-веток (refs/remotes/*): копия истории на сервере не найдена.', 'warning');
      if (gate === 'confirm' && !(await choose('Продолжить без копии на сервере?', false))) {
        print('Отменено.');
        return;
      }
    }
    const flow =
      flows[
        await prompts.select(
          'Что переписать?',
          flows.map((item) => flowLabels[item]),
          0
        )
      ];
    let backupBranch: string | undefined;
    if (!mode.destination) {
      if (await choose('Создать бекап?', true)) {
        for (;;) {
          const candidate = await ask('Ветка бекапа', defaultBackupBranch);
          try {
            repo.git(['check-ref-format', `refs/heads/${candidate}`]);
          } catch (error) {
            print(error instanceof Error ? error.message : error);
            continue;
          }
          // Stop if the name exists. Do not add a suffix or overwrite the branch.
          if (repo.refs().some((r) => r.name === `refs/heads/${candidate}`)) throw new Error('Бекап-ветка уже существует.');
          backupBranch = candidate;
          break;
        }
      } else print('Без бекапа восстановление не гарантируется.', 'warning');
    } else print(`Экспорт → ${mode.destination}`, 'muted');
    const options: Options = { ...(flow === 'dates' ? await askDates() : flow === 'authors' ? await askAuthors() : await askMessages()), backupBranch };
    print('Готовлю план…');
    const plan = makePlan(repo, options);
    print('\nПлан', 'accent');
    describe(options, plan);
    print(mode.destination ? 'Исходник сохранится.' : `Бекап: ${backupBranch || 'нет'}`, 'muted');
    for (const ref of plan.selected) print(`  ${ref.name}  ${ref.oid.slice(0, 12)} → ${plan.mapping.get(ref.oid)!.slice(0, 12)}`, 'muted');
    if (plan.stripped) {
      print(`Подписи и mergetag к удалению: ${plan.stripped}`, 'warning');
      print('Новые коммиты и теги нельзя подписать заново. Без удаления подписей переписывание невозможно.', 'warning');
    }
    const shared = mode.destination ? 0 : sharedTags(plan).size;
    if (shared) print(`Теги, которые есть и в других ветках: ${shared}. Локально они разойдутся с этими ветками. Push — только после отдельного подтверждения.`, 'warning');
    if (options.flow === 'dates') print('Даты условные; старые копии сохраняют исходную историю.', 'muted');
    if (!mode.destination && plan.selected.every((ref) => plan.mapping.get(ref.oid) === ref.oid)) {
      print('Изменений нет: история уже соответствует параметрам.', 'success');
      return;
    }
    if (mode.dryRun) {
      print('Dry-run завершён. Без изменений.', 'success');
      return;
    }
    if (plan.stripped && !(await choose('Удалить подписи и продолжить?', false))) {
      print('Отменено: подписи сохранены, история не изменена.');
      return;
    }
    if (!(await choose(mode.destination ? 'Создать экспорт?' : 'Применить изменения?', false))) {
      print('Отменено.');
      return;
    }
    if (mode.destination) {
      const result = exportPlan(plan, mode.destination);
      print(`✓ Экспорт проверен · коммиты: ${result.commits} · теги: ${result.tags}`, 'success');
      print(result.repository, 'muted');
    } else {
      // Repeat the remote copy check for the planned head. Plan application then rejects any later ref change.
      const recheck = remoteGate(remoteCopy(repo, plan.headOid), false);
      if (recheck === 'block' || (recheck === 'confirm' && gate !== 'confirm')) throw new Error('Ветка или remote-ссылки изменились после проверки. Запустите скрипт заново.');
      const result = applyPlan(plan);
      print(`✓ Готово · коммиты: ${plan.commits}`, 'success');
      print(`Восстановление: ${result.recovery}${result.backupPrefix ? `\nБекап-ссылки: ${result.backupPrefix}` : ''}`, 'muted');
      // A confirmation can resume from poll. Two check phases include the next poll.
      await nextTurn();
      await nextTurn();
      if (result.interrupted) {
        print('Прервано. Локальная история сохранена; push не выполнялся.', 'warning');
        process.exitCode = 130;
        return;
      }
      await offerPush(plan);
    }
  } finally {
    prompts.close();
  }
}
// An npm bin can be a symbolic link. Compare the real paths.
let entry = '';
try {
  if (process.argv[1]) entry = pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  /* Import from stdin or eval. */
}
if (import.meta.url === entry) {
  main().catch((error) => {
    if (error instanceof PromptCancelled) {
      print('Отменено.', 'muted');
      process.exitCode = 130;
    } else {
      console.error(style.error(safe(`Ошибка: ${error instanceof Error ? error.message : error}`)));
      process.exitCode = 1;
    }
  });
}
