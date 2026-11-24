import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for an OpenAI-compatible model server, so the real client, timeouts and error handling are exercised.
// Embeddings are a word-hash bag of words: texts sharing words point the same way, which is enough to rank passages.
const DIMS = 64;

export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    v[createHash('sha1').update(word).digest()[0]! % DIMS]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export interface ChatReply {
  status?: number;
  body?: unknown;
  content?: string;
  finish?: string;
  // Resolves before the reply is sent; lets a test hold an answer open.
  wait?: Promise<void>;
}

export interface ChatRequest {
  messages: { role: string; content: string }[];
  [key: string]: unknown;
}

export class FakeModel {
  url = '';
  chatRequests: ChatRequest[] = [];
  embeddingStatus = 200;
  onChat: (req: ChatRequest) => ChatReply = () => ({ content: '{}' });
  private server: Server | undefined;

  async start() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }

  async stop() {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reply(answer: { outcome: string; answer: string; quotes: string[] }) {
    this.onChat = () => ({ content: JSON.stringify(answer) });
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    if (req.url?.endsWith('/embeddings')) {
      if (this.embeddingStatus !== 200)
        return { status: this.embeddingStatus, body: { error: { message: 'down' } } };
      const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
      return {
        status: 200,
        body: {
          object: 'list',
          data: input.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: fakeEmbedding(text),
          })),
          model: body.model,
        },
      };
    }
    if (req.url?.endsWith('/chat/completions')) {
      this.chatRequests.push(body);
      const r = this.onChat(body);
      await r.wait;
      if (r.status && r.status !== 200)
        return { status: r.status, body: r.body ?? { error: { message: 'fail' } } };
      return {
        status: 200,
        body: {
          id: 'fake',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: r.finish ?? 'stop',
              message: { role: 'assistant', content: r.content ?? '' },
            },
          ],
        },
      };
    }
    return { status: 404, body: { error: { message: 'unknown route' } } };
  }
}
