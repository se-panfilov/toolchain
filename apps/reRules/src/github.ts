import { setTimeout as delay } from 'node:timers/promises';

/** Only github.com is supported. The address is fixed and never comes from the environment or from arguments. */
export const apiOrigin = 'https://api.github.com';
const apiVersion = '2022-11-28';
const userAgent = 'tx-rerules';
const maxPages = 100;
const maxBodyBytes = 16 * 1024 * 1024;
const maxRetries = 3;
const maxWaitMs = 5 * 60 * 1000;

export type ApiErrorKind = 'auth' | 'permission' | 'not-found' | 'validation' | 'conflict' | 'unsupported' | 'rate-limit' | 'transient' | 'redirect' | 'network' | 'invalid-response';

/** Replace terminal control characters. API messages and repository data are untrusted text. */
export function safe(value: unknown, keepNewlines = false): string {
  return String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (ch) => (keepNewlines && ch === '\n' ? ch : '?'));
}

function shorten(value: string, limit = 300): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  constructor(kind: ApiErrorKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** A short Russian description of the error class for reports. */
export function errorKindLabel(kind: ApiErrorKind): string {
  const labels: Record<ApiErrorKind, string> = {
    auth: 'ошибка авторизации',
    permission: 'недостаточно прав',
    'not-found': 'не найдено или нет доступа',
    validation: 'ошибка проверки данных',
    conflict: 'конфликт или ограничение организации',
    unsupported: 'не поддерживается для этого репозитория или тарифа',
    'rate-limit': 'превышен лимит запросов',
    transient: 'временная ошибка GitHub',
    redirect: 'репозиторий переименован или перенесён',
    network: 'ошибка сети',
    'invalid-response': 'некорректный ответ API'
  };
  return labels[kind];
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${errorKindLabel(error.kind)}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`;
  return safe(error instanceof Error ? error.message : String(error));
}

export type TransportRequest = { method: string; url: string; headers: Record<string, string>; body?: string };
export type TransportResponse = { status: number; header(name: string): string | null; text(): Promise<string> };
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** The default transport. Redirects are not followed: the token must not go to another address, and a renamed repository must stop the run. */
export const fetchTransport: Transport = async (request) => {
  const init: RequestInit = { method: request.method, headers: request.headers, redirect: 'manual', signal: AbortSignal.timeout(60000) };
  if (request.body !== undefined) init.body = request.body;
  const response = await fetch(request.url, init);
  return {
    status: response.status,
    header: (name) => response.headers.get(name),
    text: async () => {
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > maxBodyBytes) throw new ApiError('invalid-response', response.status, 'Слишком большой ответ API.');
      const text = await response.text();
      if (text.length > maxBodyBytes) throw new ApiError('invalid-response', response.status, 'Слишком большой ответ API.');
      return text;
    }
  };
};

export type RepoRef = { owner: string; name: string };
export type Query = Record<string, string | number | boolean | undefined>;

/**
 * Build an API path from segments. Each segment is encoded, so data cannot add path parts or a query.
 * Empty, `.`, and `..` segments are refused: URL normalization would remove them and change the target path.
 */
export function apiPath(...segments: (string | number)[]): string {
  return segments
    .map((segment) => {
      const text = String(segment);
      if (text === '' || /^(\.|%2e){1,2}$/i.test(text)) throw new Error(`Недопустимая часть пути API: ${safe(text)}`);
      return `/${encodeURIComponent(text)}`;
    })
    .join('');
}

export function repoPath(repo: RepoRef, ...segments: (string | number)[]): string {
  return apiPath('repos', repo.owner, repo.name, ...segments);
}

export type ClientOptions = {
  token: string;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum time between two mutations. GitHub recommends at least one second against secondary rate limits. */
  mutationIntervalMs?: number;
  onWait?: (seconds: number) => void;
};

/**
 * A small GitHub REST client. Reads are permitted for any repository. Mutations are permitted only for the one target
 * repository that `allowWrites` sets. A mutation of another path stops with an error before a request.
 */
export class GitHubClient {
  private readonly token: string;
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly mutationIntervalMs: number;
  private readonly onWait: ((seconds: number) => void) | undefined;
  private writeTarget: RepoRef | undefined;
  private writesFrozen = false;
  private lastMutation = 0;

  constructor(options: ClientOptions) {
    this.token = options.token;
    this.transport = options.transport ?? fetchTransport;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.now = options.now ?? Date.now;
    this.mutationIntervalMs = options.mutationIntervalMs ?? 1000;
    this.onWait = options.onWait;
  }

  /** Permit mutations only for this repository. It can be set once. */
  allowWrites(target: RepoRef): void {
    if (this.writeTarget || this.writesFrozen) throw new Error('Цель записи уже задана.');
    this.writeTarget = { ...target };
  }

  /** Forbid all mutations for the rest of the run, for example in dry-run mode. */
  freezeWrites(): void {
    this.writesFrozen = true;
  }

  /** Check that a mutation goes to the target repository or to a team grant for this repository. */
  assertWritable(path: string): void {
    const target = this.writeTarget;
    if (this.writesFrozen || !target) throw new Error('Изменения запрещены в этом режиме.');
    const base = repoPath(target).toLowerCase();
    // Compare the path that the request will use after URL normalization.
    const lower = new URL(path, apiOrigin).pathname.toLowerCase();
    if (lower !== path.toLowerCase()) throw new Error(`Путь API изменяется при нормализации: ${safe(path)}. Операция остановлена.`);
    if (lower === base || lower.startsWith(`${base}/`)) return;
    // PUT /orgs/{org}/teams/{slug}/repos/{owner}/{repo} grants a team access to the target repository.
    const parts = lower.split('/');
    const teamGrant =
      parts.length === 8 &&
      parts[1] === 'orgs' &&
      parts[2] === encodeURIComponent(target.owner).toLowerCase() &&
      parts[3] === 'teams' &&
      parts[5] === 'repos' &&
      `/repos/${parts[6]}/${parts[7]}` === base;
    if (teamGrant) return;
    throw new Error(`Попытка изменить ресурс вне целевого репозитория: ${safe(path)}. Операция остановлена.`);
  }

  async get(path: string, query?: Query): Promise<unknown> {
    return (await this.request('GET', path, query)).data;
  }

  /** GET that returns undefined for HTTP 404. */
  async getOptional(path: string, query?: Query): Promise<unknown> {
    try {
      return await this.get(path, query);
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'not-found') return undefined;
      throw error;
    }
  }

  /** GET that returns the HTTP status for endpoints that answer with 204 or 404, such as membership checks. */
  async status(path: string): Promise<number> {
    try {
      return (await this.request('GET', path)).status;
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'not-found') return 404;
      throw error;
    }
  }

  /** Read all pages. `key` selects the array in an object response, for example `variables`. */
  async paginate(path: string, query: Query = {}, key?: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let url: string | undefined = this.url(path, { per_page: 100, ...query });
    for (let page = 0; url; page++) {
      if (page >= maxPages) throw new ApiError('invalid-response', 0, 'Слишком много страниц в ответе API.');
      const result = await this.send('GET', url);
      const data = key === undefined ? result.data : isRecord(result.data) ? result.data[key] : undefined;
      if (!Array.isArray(data)) throw new ApiError('invalid-response', result.status, 'Ожидался список в ответе API.');
      items.push(...(data as unknown[]));
      url = nextLink(result.link);
    }
    return items;
  }

  async mutate(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    this.assertWritable(path);
    const wait = this.lastMutation + this.mutationIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    try {
      return (await this.request(method, path, undefined, body)).data;
    } finally {
      this.lastMutation = this.now();
    }
  }

  private url(path: string, query?: Query): string {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Некорректный путь API.');
    const url = new URL(path, apiOrigin);
    for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    return url.toString();
  }

  private async request(method: string, path: string, query?: Query, body?: unknown): Promise<{ status: number; data: unknown; link: string | null }> {
    return this.send(method, this.url(path, query), body);
  }

  private async send(method: string, url: string, body?: unknown): Promise<{ status: number; data: unknown; link: string | null }> {
    if (new URL(url).origin !== apiOrigin) throw new ApiError('invalid-response', 0, 'Ссылка API ведёт на другой адрес.');
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'user-agent': userAgent,
      'x-github-api-version': apiVersion
    };
    const request: TransportRequest = { method, url, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      request.body = JSON.stringify(body);
    }
    for (let attempt = 0; ; attempt++) {
      let response: TransportResponse;
      try {
        response = await this.transport(request);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // A network error after a sent mutation can hide a completed change. Retry only reads.
        if (method === 'GET' && attempt < maxRetries) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApiError('network', 0, safe(error instanceof Error ? error.message : String(error)));
      }
      const text = await response.text();
      const data = parseBody(text, response.status);
      if (response.status >= 200 && response.status < 300) return { status: response.status, data, link: response.header('link') };
      const wait = rateLimitWait(response, data, this.now());
      if (wait !== undefined) {
        if (attempt >= maxRetries || wait > maxWaitMs) throw new ApiError('rate-limit', response.status, 'Лимит запросов GitHub исчерпан. Повторите позже.');
        this.onWait?.(Math.ceil(wait / 1000));
        await this.sleep(wait);
        continue;
      }
      // GitHub did not finish a read. A mutation can be complete after 5xx, so it is not repeated.
      if (method === 'GET' && [500, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw classify(response.status, data);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBody(text: string, status: number): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (status >= 200 && status < 300) throw new ApiError('invalid-response', status, 'Ответ API не является JSON.');
    return undefined;
  }
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match?.[1]) {
      const url = new URL(match[1]);
      if (url.origin !== apiOrigin) throw new ApiError('invalid-response', 0, 'Ссылка на следующую страницу ведёт на другой адрес.');
      return url.toString();
    }
  }
  return undefined;
}

function apiMessage(data: unknown): string {
  if (!isRecord(data)) return '';
  const parts: string[] = [];
  if (typeof data.message === 'string') parts.push(data.message);
  if (Array.isArray(data.errors)) {
    for (const item of data.errors.slice(0, 5)) {
      if (typeof item === 'string') parts.push(item);
      else if (isRecord(item) && typeof item.message === 'string') parts.push(item.message);
      else if (isRecord(item) && typeof item.code === 'string') parts.push(`${typeof item.field === 'string' ? item.field : ''} ${item.code}`.trim());
    }
  }
  return shorten(safe(parts.join('; ')));
}

/** Return the wait time for primary and secondary rate limits, or undefined when the response is another error. */
function rateLimitWait(response: TransportResponse, data: unknown, now: number): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = response.header('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (response.header('x-ratelimit-remaining') === '0') {
    const reset = Number(response.header('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - now + 1000);
    return 60000;
  }
  if (/secondary rate limit|abuse/i.test(apiMessage(data))) return 60000;
  return response.status === 429 ? 60000 : undefined;
}

const planLimitation = /upgrade to github (pro|team)|make this repository public|not available for|advanced security|is not enabled for|plan does not|feature is not available|not supported/i;

export function classify(status: number, data: unknown): ApiError {
  const message = apiMessage(data) || `HTTP ${status}`;
  if (status >= 300 && status < 400) return new ApiError('redirect', status, 'GitHub вернул перенаправление. Укажите актуальное имя репозитория.');
  if (status === 401) return new ApiError('auth', status, message);
  if (status === 403) return new ApiError(planLimitation.test(message) ? 'unsupported' : 'permission', status, message);
  if (status === 404) return new ApiError('not-found', status, message);
  if (status === 409) return new ApiError('conflict', status, message);
  if (status === 422) return new ApiError(planLimitation.test(message) ? 'unsupported' : 'validation', status, message);
  if (status >= 500) return new ApiError('transient', status, message);
  return new ApiError('invalid-response', status, message);
}
