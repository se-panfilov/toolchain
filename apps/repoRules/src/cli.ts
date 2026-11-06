#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import { authGuide, sourceLabel, type Token, tokenFromEnv, tokenFromGh, validToken, verifyToken } from '@repoRules/auth';
import { describeError, GitHubClient } from '@repoRules/github';
import { type Asker, PromptCancelled, TerminalPrompts } from '@repoRules/prompts';
import { checkPair, loadRepo, parseRepo } from '@repoRules/repo';
import { collectPlan, confirmAndApply } from '@repoRules/run';
import { Ui } from '@repoRules/ui';

export function help(): string {
  return `repoRules — интерактивный перенос настроек репозитория GitHub в другой репозиторий.
Node.js 24.12+. macOS, Linux, Windows. Нужен интерактивный терминал.
Запуск: tx-reporules [--source OWNER/REPO] [--target OWNER/REPO] [--dry-run]

  --source REPO   Репозиторий-источник: owner/repo или https://github.com/owner/repo.
  --target REPO   Целевой репозиторий. Он должен уже существовать.
  --dry-run       Обзор, выбор и план без изменений в цели.
  --version       Версия.
  --help          Справка.

Пример:
  tx-reporules --source my-user/my-template --target my-user/new-project --dry-run

Категории: настройки репозитория, окружения, переменные, секреты (новые значения),
Actions, безопасность, доступ, метки, вехи, автоссылки, вебхуки, Pages, CODEOWNERS,
наборы правил, защита веток.
Источник только читается. Перед изменениями показывается план; ничего не меняется без подтверждения.
Авторизация: GH_TOKEN, GITHUB_TOKEN или gh auth token. Токен не сохраняется и не выводится.
Подробности: README.md пакета.`;
}

function version(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'неизвестно';
}

export type Arguments = { source: string | undefined; target: string | undefined; dryRun: boolean; help: boolean; version: boolean };

/** Accept `--name value` and `--name=value`. Reject unknown and repeated options, empty values, and values that start with `-`. */
export function parseArguments(args: readonly string[]): Arguments {
  const result: Arguments = { source: undefined, target: undefined, dryRun: false, help: false, version: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (seen.has(name)) throw new Error(`Параметр повторяется: ${name}`);
    seen.add(name);
    if (name === '--source' || name === '--target') {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`Нет значения для ${name}`);
      parseRepo(value);
      if (name === '--source') result.source = value;
      else result.target = value;
    } else if (eq > 0) throw new Error(`Параметр ${name} не принимает значение.`);
    else if (name === '--dry-run') result.dryRun = true;
    else if (name === '--help' || name === '-h') result.help = true;
    else if (name === '--version') result.version = true;
    else throw new Error(`Неизвестный параметр: ${safeArg(arg)}`);
  }
  return result;
}

function safeArg(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 100);
}

async function askRepo(ask: Asker, ui: Ui, question: string, initial: string | undefined): Promise<string> {
  let value = initial;
  for (;;) {
    if (value !== undefined) {
      try {
        parseRepo(value);
        return value;
      } catch (error) {
        ui.error(error instanceof Error ? error.message : String(error));
      }
    }
    value = await ask.text(question, value ?? '');
  }
}

async function obtainToken(ask: Asker, ui: Ui): Promise<Token> {
  const fromEnv = tokenFromEnv();
  if (fromEnv) return fromEnv;
  const fromGh = await tokenFromGh();
  if (fromGh) return fromGh;
  ui.line(authGuide);
  for (;;) {
    const value = (await ask.secret('Токен GitHub (не отображается)')).trim();
    if (validToken(value)) return { value, source: 'input' };
    ui.error('Некорректный токен: нужна строка без пробелов, 20–255 символов.');
  }
}

export async function main(args: readonly string[]): Promise<number> {
  let parsed: Arguments;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nСправка: tx-reporules --help\n`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(`${help()}\n`);
    return 0;
  }
  if (parsed.version) {
    stdout.write(`${version()}\n`);
    return 0;
  }
  // A run without a terminal cannot ask questions. Consent is never assumed, also not in CI.
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write('Нужен интерактивный терминал (TTY). Неинтерактивный режим не поддерживается.\n');
    return 1;
  }
  const ui = new Ui(stdout);
  const prompts = new TerminalPrompts(stdin, stdout);
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    ui.line(ui.style.warning('Остановка после текущей операции…'));
  };
  try {
    ui.line(ui.style.strong('repoRules — перенос настроек репозитория GitHub'));
    if (parsed.dryRun) ui.line(ui.style.warning('Пробный запуск: цель не изменяется.'));
    const token = await obtainToken(prompts, ui);
    const client = new GitHubClient({
      token: token.value,
      onWait: (seconds) => {
        ui.info(`Лимит запросов GitHub: ожидание ${seconds} с…`);
      }
    });
    if (parsed.dryRun) client.freezeWrites();
    const identity = await verifyToken(client);
    ui.rows([['Пользователь GitHub', `${identity.login} (${sourceLabel(token.source)})`]], 0);
    const sourceRef = parseRepo(await askRepo(prompts, ui, 'Репозиторий-источник (owner/repo)', parsed.source));
    const targetRef = parseRepo(await askRepo(prompts, ui, 'Целевой репозиторий (owner/repo)', parsed.target));
    const source = await loadRepo(client, sourceRef);
    const target = await loadRepo(client, targetRef);
    const warnings = checkPair(source, target);
    ui.line();
    ui.rows([
      ['ИСТОЧНИК', `${source.fullName} (${source.visibility}, ${source.ownerType === 'Organization' ? 'организация' : 'личный'})`],
      ['ЦЕЛЬ', `${target.fullName} (${target.visibility}, ${target.ownerType === 'Organization' ? 'организация' : 'личный'})`]
    ]);
    for (const warning of warnings) ui.warn(warning);
    if (source.private && !target.private) {
      ui.warn('Источник закрытый, а цель доступна публично. Перенесённые описание, темы, метки, вехи, окружения и CODEOWNERS станут видны всем.');
      if (!(await prompts.confirm('Продолжить с публичной целью?', false))) {
        ui.line('Отменено. Изменения не применены.');
        return 130;
      }
    }
    ui.info('Источник только читается. Изменения цели начнутся после показа плана и подтверждения.');
    const ctx = { client, source, target, ui, ask: prompts, dryRun: parsed.dryRun, targetEnvironments: new Set<string>() };
    const items = await collectPlan(ctx);
    process.on('SIGINT', onSignal);
    const result = await confirmAndApply(ctx, items, () => stopping);
    return result.outcomes.some((outcome) => outcome.status !== 'done') ? 1 : 0;
  } catch (error) {
    if (error instanceof PromptCancelled) {
      ui.line('Отменено. Изменения не применены.');
      return 130;
    }
    ui.error(describeError(error));
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    prompts.close();
  }
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntry()) process.exitCode = await main(process.argv.slice(2));
