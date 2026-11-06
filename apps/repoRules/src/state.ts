import { ApiError, describeError, isRecord, safe } from '@repoRules/github';

/** Why a value is not available. The tool never replaces a missing value with a default. */
export type MissingState = 'not-configured' | 'unsupported' | 'forbidden' | 'unavailable' | 'unknown';

export type Read<T> = { ok: true; value: T } | { ok: false; state: MissingState; detail: string };

export function known<T>(value: T): Read<T> {
  return { ok: true, value };
}

export function missing<T>(state: MissingState, detail = ''): Read<T> {
  return { ok: false, state, detail };
}

export function stateLabel(state: MissingState): string {
  const labels: Record<MissingState, string> = {
    'not-configured': 'Не настроено',
    unsupported: 'Не поддерживается',
    forbidden: 'Недостаточно прав',
    unavailable: 'API недоступен',
    unknown: 'Неизвестно'
  };
  return labels[state];
}

/** Convert a read failure into a state. A 404 means "not configured" only when the caller knows that it has access. */
export function stateOf(error: unknown, notFound: MissingState = 'unknown'): { state: MissingState; detail: string } {
  if (error instanceof ApiError) {
    const map: Partial<Record<ApiError['kind'], MissingState>> = {
      permission: 'forbidden',
      auth: 'forbidden',
      unsupported: 'unsupported',
      'not-found': notFound,
      transient: 'unavailable',
      network: 'unavailable',
      'rate-limit': 'unavailable'
    };
    return { state: map[error.kind] ?? 'unknown', detail: describeError(error) };
  }
  // Programming errors must not look like a GitHub state.
  throw error;
}

/** Run a read and keep the failure as a state. */
export async function attempt<T>(read: () => Promise<T>, notFound: MissingState = 'unknown'): Promise<Read<T>> {
  try {
    return known(await read());
  } catch (error) {
    const { state, detail } = stateOf(error, notFound);
    return missing(state, detail);
  }
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

export function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === 'string');
}

/** Deep equality for JSON data. Object key order is ignored. */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

export { safe };
