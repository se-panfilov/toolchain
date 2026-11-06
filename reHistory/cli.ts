#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Repository, makePlan, applyPlan, validateIdentity } from './engine.ts';

// Метаданные репозитория и ошибки Git могут содержать управляющие символы терминала.
function safe(value: unknown): string { return String(value).replace(/[\p{Cc}\p{Cf}]/gu, ch => ch === '\n' ? ch : '?'); }
function print(value: unknown): void { console.log(safe(value)); }
function help(): void {
  print(`reHistory — переписывание текущей ветки и тегов её истории.

Запуск (Node.js 24+, Git 2.39+):
  node /путь/к/toolchain/reHistory/cli.ts [--repo /путь/к/репозиторию] [--dry-run]

  --repo PATH  Репозиторий (по умолчанию текущий каталог).
  --dry-run    Только план: никаких записей в репозиторий.
  --help       Эта справка.

Все вопросы — на русском языке. Отмена: Ctrl+C или выбор «Нет».
Скрипт никогда не выполняет push. Подробности: reHistory/README.md.`);
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let path = process.cwd();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { help(); return; }
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--repo' && args[i + 1] && !args[i + 1].startsWith('--')) path = args[++i];
    else throw new Error(`Неизвестный аргумент или отсутствующее значение: ${args[i]}. Используйте --help.`);
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Требуется Node.js 24 или новее.');
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Для интерактивного запуска нужен терминал (TTY). Перенаправление ответов запрещено.');
  const repo = new Repository(path);
  const state = repo.inspect();
  print(`Репозиторий: ${repo.path}\nТекущая ветка: ${state.head.slice(11)}\nРежим: ${dryRun ? 'DRY-RUN — без записи' : 'применение после подтверждения'}`);
  print('На время работы закройте Git-интеграцию IDE и не запускайте другие операции Git.');
  const rl = createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => { rl.close(); });
  async function ask(question: string, fallback?: string): Promise<string> {
    const value = (await rl.question(safe(`${question}${fallback !== undefined ? ` [${fallback}]` : ''}: `))).trim();
    return value || fallback || '';
  }
  async function choose(question: string, defaultYes: boolean): Promise<boolean> {
    for (;;) {
      print(`${question}\n  1. Да${defaultYes ? ' (по умолчанию)' : ''}\n  2. Нет${!defaultYes ? ' (по умолчанию)' : ''}`);
      const answer = await ask('Выберите номер', defaultYes ? '1' : '2');
      if (answer === '1' || answer === '2') return answer === '1';
      print('Выберите 1 или 2.');
    }
  }
  try {
    let backupBranch: string | undefined;
    if (await choose('Создать бекап-ветку и сохранить исходные ссылки всех затронутых тегов?', true)) {
      const fallback = `rehistory-backup/${new Date().toISOString().replace(/[:.]/g, '-')}`;
      for (;;) {
        const candidate = await ask('Имя бекап-ветки', fallback);
        try {
          repo.git(['check-ref-format', `refs/heads/${candidate}`]);
          if (state.refs.some(r => r.name === `refs/heads/${candidate}`)) throw new Error('Такая ветка уже существует.');
          backupBranch = candidate; break;
        } catch (error) { print(error instanceof Error ? error.message : error); }
      }
    } else print('Бекап не будет создан. Файл восстановления сохранит старые хеши, но не защитит объекты от будущего удаления сборщиком мусора Git.');
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
      try { start = parseDate(await ask('Дата первого коммита (ГГГГ-ММ-ДД, местная полночь; либо ISO с часовым поясом)', dateDefault)); break; }
      catch (error) { print(error instanceof Error ? error.message : error); }
    }
    let identity: { name: string; email: string } | undefined;
    if (await choose('Заменить имя и email всех авторов и коммитеров текущей истории?', false)) {
      for (;;) {
        const name = await ask('Новое имя');
        const email = await ask('Новый email');
        try { validateIdentity(name, email); identity = { name, email }; break; }
        catch (error) { print(error instanceof Error ? error.message : error); }
      }
    }
    print('Проверяю историю и рассчитываю новые объекты…');
    const plan = makePlan(repo, { start, interval, identity, backupBranch });
    print(`\nПЛАН\nКоммитов: ${plan.commits}\nИнтервал: ${interval} с\nНачало: ${new Date(start * 1000).toISOString()}\nКонец: ${new Date((start + (plan.commits - 1) * interval) * 1000).toISOString()}\nИмя/email: ${identity ? `${identity.name} <${identity.email}> (автор и коммитер)` : 'сохранить для каждого коммита'}\nБекап: ${backupBranch || 'отключён'}\nЗатронутые ссылки:`);
    for (const ref of plan.selected) print(`  ${ref.name}: ${ref.oid} → ${plan.mapping.get(ref.oid)}`);
    print(`Удаляемых заголовков подписей/mergetag и подписей тегов: ${plan.stripped}.\nИзменение истории меняет хеши. Существующие копии, reflog и серверные данные могут сохранять старые даты.\nНе запускайте параллельно другие операции Git, IDE с автообновлением Git и сборку мусора.`);
    if (dryRun) { print('\nDry-run завершён. Репозиторий не изменён, бекап не создан.'); return; }
    if (plan.stripped && !await choose('Подписи станут недействительными и будут удалены. Продолжить?', false)) { print('Отменено.'); return; }
    if (!await choose('Применить показанный план переписывания?', false)) { print('Отменено. Репозиторий не изменён.'); return; }
    const result = applyPlan(plan);
    print(`Готово. Переписано коммитов: ${plan.commits}.\nФайл восстановления: ${result.recovery}${result.backupPrefix ? `\nРезервные ссылки: ${result.backupPrefix}` : ''}\nPush не выполнялся.`);
  } finally { rl.close(); }
}

// Импорт модуля в тестах не должен запускать интерактивный диалог.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(safe(`Ошибка: ${error instanceof Error ? error.message : error}`)); process.exitCode = 1; });
}
