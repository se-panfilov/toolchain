import type { GitHubClient } from '@reRules/github';
import type { Asker } from '@reRules/prompts';
import type { RepoInfo } from '@reRules/repo';
import type { Ui } from '@reRules/ui';

/**
 * Plan item kinds:
 * create, update, delete — changes in the target repository;
 * keep — the target value stays (also when it is already equal);
 * skip — the user or the tool skipped the item;
 * warn — an item that cannot be transferred, with the reason.
 */
export type PlanKind = 'create' | 'update' | 'delete' | 'keep' | 'skip' | 'warn';

export const changeKinds: ReadonlySet<PlanKind> = new Set(['create', 'update', 'delete']);

/**
 * Execution stages. Lower stages run first. Environments come before rulesets that reference them.
 * Files come before protections, because a new protection can block a later file write.
 */
export const Stage = {
  settings: 10,
  labels: 20,
  environments: 30,
  variables: 35,
  actions: 40,
  security: 45,
  access: 50,
  integrations: 55,
  files: 60,
  defaultBranch: 65,
  rulesets: 80,
  protection: 90
} as const;

export type PlanItem = {
  category: string;
  kind: PlanKind;
  title: string;
  details?: string[];
  /** A reason for an additional confirmation, for example a weaker protection or a new access grant. */
  risk?: string;
  stage: number;
  /** The mutation. Only change items have it. It receives the client with the write guard. */
  apply?: (client: GitHubClient) => Promise<void>;
};

export type Context = {
  client: GitHubClient;
  source: RepoInfo;
  target: RepoInfo;
  ui: Ui;
  ask: Asker;
  dryRun: boolean;
  /** Environment names that exist in the target or that the plan creates. Later categories read it. */
  targetEnvironments: Set<string>;
};

/**
 * A configuration category. `discover` only reads. `present` only prints. `plan` asks questions and returns plan items;
 * it does not change anything. The mutations are in the `apply` functions of the items.
 */
export type Category<D> = {
  id: string;
  title: string;
  discover(ctx: Context): Promise<D>;
  /** Return a reason to skip the category without questions, for example "no rulesets". */
  empty?(data: D, ctx: Context): string | undefined;
  present(data: D, ctx: Context): void;
  plan(data: D, ctx: Context): Promise<PlanItem[]>;
};

/** A category with an unknown data type, for the registry. */
export type AnyCategory = {
  id: string;
  title: string;
  discover(ctx: Context): Promise<unknown>;
  empty?(data: unknown, ctx: Context): string | undefined;
  present(data: unknown, ctx: Context): void;
  plan(data: unknown, ctx: Context): Promise<PlanItem[]>;
};

export function category<D>(definition: Category<D>): AnyCategory {
  return definition;
}

export const marks: Record<PlanKind, string> = { create: '[+]', update: '[~]', delete: '[-]', keep: '[=]', skip: '[-]', warn: '[!]' };

export function summary(items: readonly PlanItem[]): { changes: number; skipped: number; warnings: number; risky: number } {
  return {
    changes: items.filter((item) => changeKinds.has(item.kind)).length,
    skipped: items.filter((item) => item.kind === 'skip' || item.kind === 'keep').length,
    warnings: items.filter((item) => item.kind === 'warn').length,
    risky: items.filter((item) => changeKinds.has(item.kind) && item.risk).length
  };
}

/** Stable execution order: stage first, then the order of creation. */
export function ordered(items: readonly PlanItem[]): PlanItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.stage - b.item.stage || a.index - b.index)
    .map(({ item }) => item);
}

export function renderPlan(ui: Ui, items: readonly PlanItem[], source: string, target: string): void {
  ui.section('ПЛАН ПЕРЕНОСА');
  ui.line();
  ui.rows([
    ['Источник', source],
    ['Цель', target]
  ]);
  ui.line();
  const colors: Record<PlanKind, (text: string) => string> = {
    create: ui.style.success,
    update: ui.style.accent,
    delete: ui.style.error,
    keep: ui.style.muted,
    skip: ui.style.muted,
    warn: ui.style.warning
  };
  for (const item of ordered(items)) {
    const risk = item.risk && changeKinds.has(item.kind) ? ` ${ui.style.warning('(повышенный риск)')}` : '';
    ui.line(`${colors[item.kind](marks[item.kind])} ${ui.style.muted(`${item.category}:`)} ${sanitize(item.title)}${risk}`);
    for (const detail of item.details ?? []) ui.line(`      ${ui.style.muted(sanitize(detail))}`);
  }
  const counts = summary(items);
  ui.line();
  ui.rows([
    ['Изменений', String(counts.changes)],
    ['Пропущено и без изменений', String(counts.skipped)],
    ['Предупреждений', String(counts.warnings)],
    ['Операций повышенного риска', String(counts.risky)]
  ]);
}

function sanitize(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '?');
}
