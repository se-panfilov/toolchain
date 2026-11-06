import { accessCategory } from '@repoRules/access';
import { actionsCategory } from '@repoRules/actions';
import { codeownersCategory } from '@repoRules/codeowners';
import { environmentsCategory } from '@repoRules/environments';
import { execute, type Outcome, renderReport } from '@repoRules/execute';
import { autolinksCategory, labelsCategory, milestonesCategory } from '@repoRules/extras';
import { ApiError, describeError } from '@repoRules/github';
import { pagesCategory, webhooksCategory } from '@repoRules/integrations';
import { type AnyCategory, changeKinds, type Context, type PlanItem, renderPlan, summary } from '@repoRules/plan';
import { protectionCategory } from '@repoRules/protection';
import { rulesetsCategory } from '@repoRules/rulesets';
import { secretsCategory } from '@repoRules/secrets';
import { securityCategory } from '@repoRules/security';
import { settingsCategory } from '@repoRules/settings';
import { variablesCategory } from '@repoRules/variables';

/**
 * Categories in question order. Environments come before variables, secrets, and rulesets, because these reference
 * environment names. Governance categories come last, so the user sees the full plan context first.
 * A new category needs only a new entry here.
 */
export const categories: readonly AnyCategory[] = [
  settingsCategory,
  environmentsCategory,
  variablesCategory,
  secretsCategory,
  actionsCategory,
  securityCategory,
  accessCategory,
  labelsCategory,
  milestonesCategory,
  autolinksCategory,
  webhooksCategory,
  pagesCategory,
  codeownersCategory,
  rulesetsCategory,
  protectionCategory
];

/** Discovery, presentation, and questions for each category. Nothing changes here. */
export async function collectPlan(ctx: Context, list: readonly AnyCategory[] = categories): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const [index, cat] of list.entries()) {
    ctx.ui.heading(index + 1, list.length, cat.title);
    let data: unknown;
    try {
      data = await cat.discover(ctx);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      ctx.ui.warn(`Не удалось прочитать: ${describeError(error)}`);
      items.push({ category: cat.title, kind: 'warn', title: `Категория не прочитана: ${describeError(error)}`, stage: 0 });
      continue;
    }
    const reason = cat.empty?.(data, ctx);
    if (reason) {
      ctx.ui.info(reason);
      continue;
    }
    cat.present(data, ctx);
    items.push(...(await cat.plan(data, ctx)));
  }
  return items;
}

export type RunResult = { status: 'nothing' | 'dry-run' | 'cancelled' | 'applied'; outcomes: Outcome[] };

/** Show the plan, confirm, and apply. Mutations become possible only after the final confirmation. */
export async function confirmAndApply(ctx: Context, items: PlanItem[], stopped: () => boolean = () => false): Promise<RunResult> {
  const { ui, ask } = ctx;
  for (;;) {
    renderPlan(ui, items, ctx.source.fullName, ctx.target.fullName);
    const counts = summary(items);
    if (counts.changes === 0) {
      ui.line('Изменений нет.');
      return { status: 'nothing', outcomes: [] };
    }
    if (ctx.dryRun) {
      ui.line(ui.style.warning('Пробный запуск (--dry-run): изменения не применены.'));
      return { status: 'dry-run', outcomes: [] };
    }
    const answer = await ask.select('Продолжить?', ['Применить изменения', 'Показать план ещё раз', 'Отмена'], 0);
    if (answer === 1) continue;
    if (answer !== 0) {
      ui.line('Отменено. Изменения не применены.');
      return { status: 'cancelled', outcomes: [] };
    }
    const risky = items.filter((item) => changeKinds.has(item.kind) && item.risk);
    if (risky.length) {
      ui.section('Операции повышенного риска:');
      for (const item of risky) ui.warn(`${item.category}: ${item.title} — ${item.risk ?? ''}`);
      if (!(await ask.confirm(`Подтвердите ${risky.length} операций повышенного риска в ${ctx.target.fullName}`, false))) {
        ui.line('Отменено. Изменения не применены.');
        return { status: 'cancelled', outcomes: [] };
      }
    }
    ctx.client.allowWrites(ctx.target);
    ui.section('ПРИМЕНЕНИЕ');
    const outcomes = await execute(items, ctx.client, ui, stopped);
    renderReport(ui, outcomes);
    return { status: 'applied', outcomes };
  }
}
