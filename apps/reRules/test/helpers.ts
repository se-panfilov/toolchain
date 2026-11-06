import { GitHubClient, type TransportRequest, type TransportResponse } from '@reRules/github';
import type { Context } from '@reRules/plan';
import type { Asker, Choice } from '@reRules/prompts';
import type { RepoInfo } from '@reRules/repo';
import { Ui } from '@reRules/ui';

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = { method: string; path: string | RegExp; reply: Reply | ((request: TransportRequest) => Reply) };

/** A fake GitHub API. Unknown requests answer 404. Every request is recorded. */
export class FakeApi {
  readonly requests: TransportRequest[] = [];
  private readonly routes: Route[] = [];

  on(method: string, path: string | RegExp, reply: Route['reply']): this {
    this.routes.unshift({ method, path, reply });
    return this;
  }

  get mutations(): TransportRequest[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  transport = (request: TransportRequest): Promise<TransportResponse> => {
    this.requests.push(request);
    const url = new URL(request.url);
    const route = this.routes.find((item) => item.method === request.method && (typeof item.path === 'string' ? item.path === url.pathname : item.path.test(url.pathname)));
    const reply = route ? (typeof route.reply === 'function' ? route.reply(request) : route.reply) : { status: 404, body: { message: 'Not Found' } };
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    return Promise.resolve({
      status: reply.status,
      header: (name: string) => headers.get(name.toLowerCase()) ?? null,
      text: () => Promise.resolve(reply.body === undefined ? '' : JSON.stringify(reply.body))
    });
  };

  client(): GitHubClient {
    return new GitHubClient({ token: 'test-token-0123456789abcdef', transport: this.transport, sleep: () => Promise.resolve(), mutationIntervalMs: 0 });
  }
}

/** Scripted answers. Each question takes the next answer; a missing answer fails the test. */
export class ScriptedAsker implements Asker {
  readonly questions: string[] = [];
  private readonly answers: unknown[];
  constructor(answers: unknown[] = []) {
    this.answers = [...answers];
  }
  private next(question: string): unknown {
    this.questions.push(question);
    if (!this.answers.length) throw new Error(`No scripted answer for: ${question}`);
    return this.answers.shift();
  }
  select(question: string, choices: readonly string[]): Promise<number> {
    const answer = this.next(question);
    const index = typeof answer === 'string' ? choices.indexOf(answer) : Number(answer);
    if (index < 0 || index >= choices.length) throw new Error(`Bad answer ${String(answer)} for ${question}: ${choices.join(' | ')}`);
    return Promise.resolve(index);
  }
  checkbox(question: string, choices: readonly Choice[]): Promise<number[]> {
    const answer = this.next(question);
    if (answer === 'defaults') return Promise.resolve(choices.flatMap((choice, index) => (choice.checked ? [index] : [])));
    return Promise.resolve(answer as number[]);
  }
  confirm(question: string): Promise<boolean> {
    return Promise.resolve(this.next(question) === true);
  }
  text(question: string): Promise<string> {
    return Promise.resolve(String(this.next(question)));
  }
  secret(question: string): Promise<string> {
    return Promise.resolve(String(this.next(question)));
  }
  get remaining(): number {
    return this.answers.length;
  }
}

export class Buffered {
  text = '';
  isTTY = false;
  write(value: string): boolean {
    this.text += value;
    return true;
  }
}

export function repo(owner: string, name: string, extra: Partial<RepoInfo> = {}): RepoInfo {
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    id: owner === 'me' && name === 'template' ? 1 : 2,
    ownerType: 'User',
    private: false,
    visibility: 'public',
    archived: false,
    defaultBranch: 'main',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    raw: {},
    ...extra
  };
}

export function context(api: FakeApi, answers: unknown[] = [], options: { source?: RepoInfo; target?: RepoInfo; dryRun?: boolean } = {}): Context & { ask: ScriptedAsker; out: Buffered } {
  const out = new Buffered();
  return {
    client: api.client(),
    source: options.source ?? repo('me', 'template'),
    target: options.target ?? repo('me', 'project'),
    ui: new Ui(out),
    ask: new ScriptedAsker(answers),
    dryRun: options.dryRun ?? false,
    targetEnvironments: new Set<string>(),
    out
  };
}

export function body(request: TransportRequest | undefined): unknown {
  return request?.body === undefined ? undefined : JSON.parse(request.body);
}
