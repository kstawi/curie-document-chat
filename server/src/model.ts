import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import { embeddingIdentity, type Config } from './config.js';

// Postgres can't store a NUL character or half an emoji (a lone surrogate), and model text can contain both.
const storable = (s: string) => s.replaceAll('\u0000', '').toWellFormed();

export const modelAnswer = z
  .strictObject({
    outcome: z.enum(['answered', 'not_in_document']),
    answer: z.string().max(4_000).overwrite(storable).trim(),
    quotes: z.array(z.string().max(2_000).overwrite(storable)).max(5),
  })
  // An empty note on not_in_document still carries the verdict; an empty answer carries nothing.
  .refine((r) => r.outcome !== 'answered' || r.answer !== '');
export type ModelAnswer = z.infer<typeof modelAnswer>;

// A rewritten follow-up is only ever used as a search query, so a short cap is enough.
const REWRITE_MAX_CHARS = 300;
const rewriteReply = z.strictObject({
  question: z.string().max(2_000).overwrite(storable).trim().min(1),
});

// The answer format tested in step 0 of the build, sent as a strict JSON schema.
const answerFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'answer',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'answer', 'quotes'],
      properties: {
        outcome: { type: 'string', enum: ['answered', 'not_in_document'] },
        answer: { type: 'string' },
        quotes: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      },
    },
  },
} as const;

const rewriteFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'rewrite',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: { question: { type: 'string' } },
    },
  },
} as const;

// Model output is checked at the edge like any other input.
const embeddingVector = z.array(z.number().finite()).min(1);

// What went wrong with a call. The jobs decide what each leads to (the failure table in DESIGN.md).
export type ModelFailure =
  'timeout' | 'unavailable' | 'context' | 'rejected' | 'bad_output' | 'aborted';

const FAILURE_CODES = {
  timeout: 'model_unavailable',
  unavailable: 'model_unavailable',
  context: 'context_too_long',
  rejected: 'model_rejected',
  bad_output: 'model_bad_output',
  aborted: 'model_unavailable',
} as const;

// `detail` may hold provider text, which can echo the prompt; it goes to the database's debug column, never to logs
// or clients.
export class ModelError extends Error {
  readonly detail?: string;
  constructor(
    readonly kind: ModelFailure,
    message: string,
    detail?: string,
  ) {
    super(message);
    this.detail = detail && storable(detail);
  }

  get code() {
    return FAILURE_CODES[this.kind];
  }
}

// LM Studio: "... exceeds the available context size"; OpenAI: code context_length_exceeded; others say "context
// window" or "maximum number of tokens".
const CONTEXT_EXCEEDED =
  /context[ _](size|length|window)|exceeds the (available|maximum)|too many tokens/i;

function classify(err: unknown, signal?: AbortSignal): never {
  // Our own cancellation (shutdown or the job's time limit) first: the SDK reports it as an API error too.
  if (err instanceof APIUserAbortError || signal?.aborted) {
    throw new ModelError('aborted', 'the model call was cancelled');
  }
  if (err instanceof APIConnectionTimeoutError) {
    throw new ModelError('timeout', 'the model server did not answer in time', err.message);
  }
  if (err instanceof APIConnectionError) {
    throw new ModelError('unavailable', 'model server unreachable', err.message);
  }
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    if (status === 429 || status >= 500) {
      throw new ModelError('unavailable', `model server answered ${status}`, err.message);
    }
    if (CONTEXT_EXCEEDED.test(`${err.code ?? ''} ${err.message}`)) {
      throw new ModelError('context', 'the prompt is longer than the model context', err.message);
    }
    throw new ModelError('rejected', `model server answered ${status}`, err.message);
  }
  // A body cut off or broken on the way (the SDK throws a bare TypeError or SyntaxError): treated as an outage.
  throw new ModelError(
    'unavailable',
    'the model server reply was cut off or unreadable',
    String(err),
  );
}

interface CallOptions {
  signal?: AbortSignal;
  timeout: number;
}

export type Model = ReturnType<typeof createModel>;

export function createModel(config: Config) {
  // Retries happen in one place, the job, so the client's own are off.
  const client = new OpenAI({
    baseURL: config.MODEL_BASE_URL,
    apiKey: config.MODEL_API_KEY,
    maxRetries: 0,
    timeout: config.MODEL_TIMEOUT_MS,
  });

  // Sampling and thinking settings differ by model, so each is sent only when set.
  const thinkingOn = {
    ...(config.CHAT_TEMPERATURE !== undefined && { temperature: config.CHAT_TEMPERATURE }),
    ...(config.CHAT_TOP_P !== undefined && { top_p: config.CHAT_TOP_P }),
    // Not in the OpenAI API, but LM Studio and other servers accept it.
    ...(config.CHAT_TOP_K !== undefined && { top_k: config.CHAT_TOP_K }),
    ...(config.CHAT_REASONING_EFFORT && { reasoning_effort: config.CHAT_REASONING_EFFORT }),
  };
  // The model's own switch where it has one, and temperature 0.
  const thinkingOff = {
    temperature: config.CHAT_RETRY_TEMPERATURE,
    ...(config.CHAT_RETRY_REASONING_EFFORT && {
      reasoning_effort: config.CHAT_RETRY_REASONING_EFFORT,
    }),
  };

  async function chat<T>(
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    { signal, timeout }: CallOptions,
  ): Promise<T> {
    const res = await client.chat.completions
      .create(
        { model: config.CHAT_MODEL, ...body } as unknown as ChatCompletionCreateParamsNonStreaming,
        {
          signal,
          timeout,
        },
      )
      .catch((err: unknown) => classify(err, signal));
    // A server can answer 200 with a body of another shape.
    const choice = Array.isArray(res?.choices) ? res.choices[0] : undefined;
    if (choice?.finish_reason === 'length') {
      throw new ModelError('bad_output', 'the model hit its token cap before answering');
    }
    const content = choice?.message?.content ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ModelError('bad_output', 'the model did not return JSON', content.slice(0, 2_000));
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new ModelError(
        'bad_output',
        'the model returned the wrong JSON shape',
        content.slice(0, 2_000),
      );
    }
    return result.data;
  }

  async function embed(
    texts: string[],
    kind: 'document' | 'query',
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const prefix =
      kind === 'document' ? config.EMBEDDING_DOC_PREFIX : config.EMBEDDING_QUERY_PREFIX;
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const input = texts.slice(i, i + 32).map((t) => prefix + t);
      const res = await client.embeddings
        .create(
          {
            model: config.EMBEDDING_MODEL,
            input,
            // The SDK asks for base64 by default, which not every OpenAI-compatible server supports.
            encoding_format: 'float',
            ...(config.EMBEDDING_DIMENSIONS && { dimensions: config.EMBEDDING_DIMENSIONS }),
          },
          { signal },
        )
        .catch((err: unknown) => classify(err, signal));
      // A server can answer 200 with a body of another shape.
      if (!Array.isArray(res?.data) || res.data.length !== input.length) {
        throw new ModelError('bad_output', 'wrong number of embeddings returned');
      }
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const [i, d] of sorted.entries()) {
        const vector = embeddingVector.safeParse(d.embedding);
        // Every vector must have the configured size, or else the size of the first one.
        const size = config.EMBEDDING_DIMENSIONS ?? (vectors[0] ?? vector.data)?.length;
        if (d.index !== i || !vector.success || vector.data.length !== size) {
          throw new ModelError('bad_output', 'the embedding model returned an unusable vector');
        }
        vectors.push(vector.data);
      }
    }
    return vectors;
  }

  return {
    chatModel: config.CHAT_MODEL,
    embeddingModel: embeddingIdentity(config),
    embed,

    // Thinking on is the normal call; thinking off is the retry after a runaway or an unusable reply.
    answer(
      messages: ChatCompletionMessageParam[],
      { thinking, signal }: { thinking: boolean; signal?: AbortSignal },
    ): Promise<ModelAnswer> {
      return chat(
        {
          messages,
          max_tokens: config.CHAT_MAX_TOKENS,
          response_format: answerFormat,
          ...(thinking ? thinkingOn : thinkingOff),
        },
        modelAnswer,
        { signal, timeout: thinking ? config.MODEL_TIMEOUT_MS : config.CHAT_RETRY_TIMEOUT_MS },
      );
    },

    async rewrite(messages: ChatCompletionMessageParam[], signal?: AbortSignal): Promise<string> {
      const { question } = await chat(
        {
          messages,
          max_tokens: config.REWRITE_MAX_TOKENS,
          response_format: rewriteFormat,
          ...thinkingOff,
        },
        rewriteReply,
        { signal, timeout: config.REWRITE_TIMEOUT_MS },
      );
      return [...question].slice(0, REWRITE_MAX_CHARS).join('');
    },

    // One tiny call to each model, for the worker's start-up check. A rejected request or an unusable vector points
    // at the settings; anything else at the server. Never throws.
    async check() {
      const probe = (call: () => Promise<unknown>) =>
        call().then(
          () => 'ok' as const,
          (err: unknown) =>
            err instanceof ModelError && (err.kind === 'rejected' || err.kind === 'bad_output')
              ? ('misconfigured' as const)
              : ('unavailable' as const),
        );
      const [chatState, embeddingState] = await Promise.all([
        probe(() =>
          client.chat.completions
            .create(
              {
                model: config.CHAT_MODEL,
                messages: [{ role: 'user', content: 'Reply with the word ok.' }],
                max_tokens: 16,
                ...thinkingOff,
              } as unknown as ChatCompletionCreateParamsNonStreaming,
              { timeout: config.REWRITE_TIMEOUT_MS },
            )
            .catch((err: unknown) => classify(err)),
        ),
        probe(() => embed(['ok'], 'query')),
      ]);
      return { chat: chatState, embedding: embeddingState };
    },
  };
}
