import { ApiError, type ApiErrorKind, describeError, type GitHubClient } from '@reRules/github';
import { changeKinds, ordered, type PlanItem } from '@reRules/plan';
import type { Ui } from '@reRules/ui';

export type Outcome = { item: PlanItem; status: 'done' | 'failed' | 'not-run'; kind?: ApiErrorKind | 'error'; message?: string };

/** Errors that stop the remaining mutations: the token or the repository is no longer usable. */
const fatalKinds: ReadonlySet<ApiErrorKind> = new Set(['auth', 'redirect']);

/**
 * Apply change items one by one in stage order. A failed item does not stop independent items.
 * Nothing is rolled back and nothing is deleted because of a failure. `stopped` lets Ctrl+C end the run after the current item.
 */
export async function execute(items: readonly PlanItem[], client: GitHubClient, ui: Ui, stopped: () => boolean = () => false): Promise<Outcome[]> {
  const changes = ordered(items).filter((item) => changeKinds.has(item.kind) && item.apply);
  const outcomes: Outcome[] = [];
  let halt: string | undefined;
  for (const [index, item] of changes.entries()) {
    const label = `[${index + 1}/${changes.length}] ${item.category}: ${item.title}`;
    if (halt || stopped()) {
      outcomes.push({ item, status: 'not-run', message: halt ?? 'Прервано пользователем.' });
      continue;
    }
    ui.line(`${ui.style.muted('…')} ${sanitize(label)}`);
    try {
      await item.apply?.(client);
      outcomes.push({ item, status: 'done' });
      ui.line(`  ${ui.style.success('готово')}`);
    } catch (error) {
      const kind = error instanceof ApiError ? error.kind : 'error';
      const message = describeError(error);
      outcomes.push({ item, status: 'failed', kind, message });
      ui.line(`  ${ui.style.error('ошибка')} ${sanitize(message)}`);
      if (error instanceof ApiError && fatalKinds.has(error.kind)) halt = 'Не выполнено: предыдущая ошибка остановила перенос.';
    }
  }
  return outcomes;
}

export function renderReport(ui: Ui, outcomes: readonly Outcome[]): void {
  ui.section('ОТЧЁТ О ВЫПОЛНЕНИИ');
  const done = outcomes.filter((outcome) => outcome.status === 'done');
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');
  const notRun = outcomes.filter((outcome) => outcome.status === 'not-run');
  for (const outcome of outcomes) {
    const mark = outcome.status === 'done' ? ui.style.success('[✓]') : outcome.status === 'failed' ? ui.style.error('[✗]') : ui.style.muted('[ ]');
    ui.line(`${mark} ${sanitize(`${outcome.item.category}: ${outcome.item.title}`)}`);
    if (outcome.message) ui.line(`      ${ui.style.muted(sanitize(outcome.message))}`);
  }
  ui.line();
  ui.rows([
    ['Выполнено', String(done.length)],
    ['Ошибок', String(failed.length)],
    ['Не выполнено', String(notRun.length)]
  ]);
  if (failed.length || notRun.length) ui.line('Запустите программу снова: уже применённые настройки будут показаны как совпадающие, повтор не создаст дубликатов.');
  ui.line('Это отчёт о выполненных операциях, а не сверка всех настроек.');
}

function sanitize(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '?');
}
