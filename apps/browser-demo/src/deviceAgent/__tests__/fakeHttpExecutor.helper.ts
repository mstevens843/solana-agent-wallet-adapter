// Test helper — not a vitest spec. Mirrors the Kotlin FakeHttpExecutor used
// by the android-twa provider tests, so the browser test suite exercises the
// same observable contract: capture every postJson call in order and replay a
// pre-queued response or throw a pre-queued failure.

import type { HttpExecutor, HttpResponse } from '../provider/http.js';

type Queued =
  | { kind: 'response'; response: HttpResponse }
  | { kind: 'failure'; err: unknown };

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export class FakeHttpExecutor implements HttpExecutor {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Queued[] = [];

  queueResponse(status: number, body: string): void {
    this.queue.push({ kind: 'response', response: { status, body } });
  }

  queueFailure(err: unknown): void {
    this.queue.push({ kind: 'failure', err });
  }

  async postJson(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<HttpResponse> {
    this.calls.push({ url, headers: { ...headers }, body });
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`FakeHttpExecutor has no queued response for call ${this.calls.length}`);
    }
    if (next.kind === 'failure') throw next.err;
    return next.response;
  }
}
