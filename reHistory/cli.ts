#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { Repository, makePlan, applyPlan, validateIdentity } from './engine.ts';
import { auditRepository, auditText } from './audit.ts';
import { exportDestination, exportPlan, verifyExport } from './export.ts';
import { runDemo, validateDemoURL } from './demo.ts';

// Метаданные Git и ошибки могут содержать управляющие символы терминала.
function safe(value: unknown): string { return String(value).replace(/[\p{Cc}\p{Cf}]/gu, ch => ch === '\n' ? ch : '?'); }
function print(value: unknown): void { console.log(safe(value)); }
function help(): void {
  print(`reHistory — нормализация истории текущей ветки и её тегов.
Node.js 24.12+, Git 2.39+. Прямой запуск: node /путь/reHistory/cli.ts [параметры]

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

Обычное переписывание и экспорт интерактивны. Push есть только в demo,
только на явно указанный сервер, без force push. Публикация npm не выполняется.
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

export function parseArguments(args: string[]) {
  let path = process.cwd();
  let dryRun = false; let audit = false; let json = false; let demo = false;
  let destination: string | undefined; let verify: string | undefined;
  let remote: string | undefined; let demoDir: string | undefined; let explicitRepo = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Параметр указан повторно: ${arg}`);
    seen.add(arg);
    if (['--repo', '--export', '--verify-export', '--demo-remote', '--demo-dir'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Отсутствует значение ${arg}.`);
      if (arg === '--repo') { path = value; explicitRepo = true; }
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
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { help(); return; }
  const mode = parseArguments(args);
  if (Number(process.versions.node.split('.')[0]) < 24 || (Number(process.versions.node.split('.')[0]) === 24 && Number(process.versions.node.split('.')[1]) < 12)) throw new Error('Требуется Node.js 24.12 или новее.');
  if (mode.demo) { runDemo({ remote: mode.remote!, directory: mode.demoDir, print }); return; }
  if (mode.verify) {
    const report = verifyExport(mode.verify);
    if (mode.json) console.log(JSON.stringify(report, null, 2));
    else print(`${report.ok ? 'ПРОВЕРКА УСПЕШНА' : 'ПРОВЕРКА НЕ ПРОЙДЕНА'}: ${report.repository}\nКоммитов: ${report.commits}; тегов: ${report.tags}; объектов: ${report.objects}\n${report.errors.join('\n')}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const repo = new Repository(mode.path);
  if (mode.audit) {
    const report = auditRepository(repo);
    if (mode.json) console.log(JSON.stringify(report, null, 2)); else print(auditText(report));
    if (!report.complete) process.exitCode = 2;
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Для переписывания/экспорта нужен терминал (TTY). Автоматические ответы разрешены только внутри нового demo.');
  const state = repo.inspect();
  if (mode.destination) exportDestination(repo, mode.destination);
  print(`Репозиторий: ${repo.path}\nВетка: ${state.head.slice(11)}\nРежим: ${mode.destination ? 'экспорт в новый bare-репозиторий' : 'переписывание на месте'}${mode.dryRun ? ' / DRY-RUN' : ''}`);
  print('На время работы закройте Git-интеграцию IDE и не запускайте другие операции Git.');
  const rl = createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => { rl.close(); });
  async function ask(question: string, fallback?: string): Promise<string> {
    return (await rl.question(safe(`${question}${fallback !== undefined ? ` [${fallback}]` : ''}: `))).trim() || fallback || '';
  }
  async function choose(question: string, defaultYes: boolean): Promise<boolean> {
    for (;;) {
      print(`${question}\n  1. Да${defaultYes ? ' (по умолчанию)' : ''}\n  2. Нет${!defaultYes ? ' (по умолчанию)' : ''}`);
      const answer = await ask('Выберите номер', defaultYes ? '1' : '2');
      if (answer === '1' || answer === '2') return answer === '1';
      print('Выберите 1 или 2.');
    }
  }
  async function newIdentity(): Promise<{ name: string; email: string }> {
    for (;;) {
      const name = await ask('Новое имя'); const email = await ask('Новый email');
      try { validateIdentity(name, email); return { name, email }; }
      catch (error) { print(error instanceof Error ? error.message : error); }
    }
  }
  try {
    let backupBranch: string | undefined;
    if (!mode.destination) {
      if (await choose('Создать бекап-ветку и резервные ссылки затронутых тегов?', true)) {
        const fallback = `rehistory-backup/${new Date().toISOString().replace(/[:.]/g, '-')}`;
        for (;;) {
          const candidate = await ask('Имя бекап-ветки', fallback);
          try {
            repo.git(['check-ref-format', `refs/heads/${candidate}`]);
            if (state.refs.some(r => r.name === `refs/heads/${candidate}`)) throw new Error('Такая ветка уже существует.');
            backupBranch = candidate; break;
          } catch (error) { print(error instanceof Error ? error.message : error); }
        }
      } else print('Бекап отключён. JSON с хешами не защитит исходные объекты от будущего GC.');
    } else print(`Каталог экспорта: ${mode.destination}\nИсходный репозиторий сохраняется целиком; бекап внутри экспорта не создаётся.`);
    let interval: number;
    for (;;) {
      const value = await ask('Интервал между коммитами, в секундах', '1');
      interval = Number(value);
      if (/^\d+$/.test(value) && Number.isSafeInteger(interval) && interval >= 1 && interval <= 31536000) break;
      print('Введите целое число от 1 до 31536000.');
    }
    const today = new Date();
    const dateDefault = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let start: number;
    for (;;) {
      try { start = parseDate(await ask('Дата первого коммита (ГГГГ-ММ-ДД, местная полночь; либо ISO с поясом)', dateDefault)); break; }
      catch (error) { print(error instanceof Error ? error.message : error); }
    }
    const identity = await choose('Заменить имя/email всех авторов и коммитеров текущей истории?', false) ? await newIdentity() : undefined;
    const tagPolicy = await choose('Нормализовать даты annotated-тегов по датам конечных коммитов?', true) ? 'normalize' : 'preserve';
    let tagIdentity: { name: string; email: string } | undefined;
    if (identity) { if (await choose('Применить новое имя/email также к создателям annotated-тегов?', true)) tagIdentity = identity; }
    else if (await choose('Заменить имя/email создателей annotated-тегов?', false)) tagIdentity = await newIdentity();
    print('Проверяю историю и рассчитываю новые объекты…');
    const plan = makePlan(repo, { start, interval, identity, backupBranch, tagPolicy, tagIdentity });
    print(`\nПЛАН\nКоммитов: ${plan.commits}\nИнтервал: ${interval} с\nНачало: ${new Date(start * 1000).toISOString()}\nКонец: ${new Date((start + (plan.commits - 1) * interval) * 1000).toISOString()}\nИмя/email коммитов: ${identity ? `${identity.name} <${identity.email}>` : 'сохранить'}\nДаты annotated-тегов: ${tagPolicy === 'normalize' ? 'нормализовать' : 'СОХРАНИТЬ ИСХОДНЫЕ'}\nTagger: ${tagIdentity ? `${tagIdentity.name} <${tagIdentity.email}>` : 'сохранить'}\nБекап: ${mode.destination ? 'исходный репозиторий' : backupBranch || 'отключён'}\nВыбранные ссылки:`);
    for (const ref of plan.selected) print(`  ${ref.name}: ${ref.oid} → ${plan.mapping.get(ref.oid)}`);
    print(`Удаляемых заголовков подписей/mergetag и подписей тегов: ${plan.stripped}.\nДаты искусственные и не устанавливают время фактической работы. Старые копии могут сохранять исходные данные.`);
    if (mode.dryRun) { print('Dry-run завершён. Никаких записей, экспорта и бекапа не создано.'); return; }
    if (plan.stripped && !await choose('Удалить недействительные подписи и mergetag?', false)) { print('Отменено.'); return; }
    if (!await choose(mode.destination ? 'Создать и проверить показанный экспорт?' : 'Применить показанное переписывание?', false)) { print('Отменено.'); return; }
    if (mode.destination) {
      const result = exportPlan(plan, mode.destination);
      print(`ЭКСПОРТ ПРОВЕРЕН: ${result.repository}\nКоммитов: ${result.commits}; тегов: ${result.tags}; объектов: ${result.objects}\nИсходный репозиторий не изменён. Push не выполнялся.`);
    } else {
      const result = applyPlan(plan);
      print(`Готово. Переписано коммитов: ${plan.commits}.\nВосстановление: ${result.recovery}${result.backupPrefix ? `\nРезервные ссылки: ${result.backupPrefix}` : ''}\nPush не выполнялся.`);
    }
  } finally { rl.close(); }
}
// npm bin может быть символической ссылкой; сравниваем реальные пути.
let entry = '';
try { if (process.argv[1]) entry = pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* импорт из stdin/eval */ }
if (import.meta.url === entry) {
  main().catch(error => { console.error(safe(`Ошибка: ${error instanceof Error ? error.message : error}`)); process.exitCode = 1; });
}
