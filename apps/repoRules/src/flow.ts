import type { Context } from '@repoRules/plan';

export type Transfer = 'all' | 'select' | 'skip';

/**
 * Ask whether to transfer a category. "Show JSON" prints the raw API data and asks again.
 * The default answer transfers nothing when the category has risky items.
 */
export async function askTransfer(ctx: Context, question: string, options: { select?: boolean; json?: unknown; defaultSkip?: boolean } = {}): Promise<Transfer> {
  const labels = ['Да, всё', ...(options.select === false ? [] : ['Выбрать отдельные']), 'Нет, пропустить'];
  const values: Transfer[] = ['all', ...(options.select === false ? [] : (['select'] as const)), 'skip'];
  if (options.json !== undefined) labels.push('Показать JSON');
  for (;;) {
    const answer = await ctx.ask.select(question, labels, options.defaultSkip ? values.length - 1 : 0);
    const value = values[answer];
    if (value) return value;
    ctx.ui.json(options.json);
  }
}

export type Conflict = 'keep' | 'merge' | 'replace' | 'skip';

/** Ask what to do with an existing target object. Merge is offered only where it has a clear meaning. */
export async function askConflict(ctx: Context, question: string, options: { merge?: string; replace?: string } = {}): Promise<Conflict> {
  const choices: [string, Conflict][] = [['Оставить как в цели', 'keep']];
  if (options.merge) choices.push([options.merge, 'merge']);
  choices.push([options.replace ?? 'Заменить значением источника', 'replace'], ['Пропустить', 'skip']);
  const answer = await ctx.ask.select(
    question,
    choices.map(([label]) => label),
    0
  );
  return choices[answer]?.[1] ?? 'keep';
}

/** Select items from a list. `all` returns every index without a question. */
export async function pick<T>(ctx: Context, mode: Transfer, question: string, items: readonly T[], label: (item: T) => string, checked: (item: T) => boolean = () => true): Promise<T[]> {
  if (mode === 'skip') return [];
  if (mode === 'all') return [...items];
  const indexes = await ctx.ask.checkbox(
    question,
    items.map((item) => ({ label: label(item), checked: checked(item) }))
  );
  return indexes.flatMap((index) => {
    const item = items[index];
    return item === undefined ? [] : [item];
  });
}
