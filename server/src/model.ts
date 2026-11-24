import OpenAI, { APIConnectionError, APIError } from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import { embeddingIdentity, type Config } from './config.js';

export const modelAnswer = z.strictObject({
  outcome: z.enum(['answered', 'not_in_document']),
  answer: z.string().max(4_000),
  quotes: z.array(z.string().max(2_000)).max(5),
});
export type ModelAnswer = z.infer<typeof modelAnswer>;

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

// Model output is checked at the edge like any other input.
const embeddingVector = z.array(z.number().finite()).min(1);

export type ModelErrorCode = 'model_unavailable' | 'model_rejected' | 'model_bad_output';

// `detail` may hold provider text, which can echo the prompt; it goes to the database's debug column, never to logs
// or clients.
export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

function classify(err: unknown): never {
  if (err instanceof APIConnectionError) {
    throw new ModelError('model_unavailable', 'model server unreachable or timed out', err.message);
  }
  if (err instanceof APIError) {
    const retryable = err.status === 429 || (err.status ?? 0) >= 500;
    throw new ModelError(
      retryable ? 'model_unavailable' : 'model_rejected',
      `model server answered ${err.status ?? 'without a status'}`,
      err.message,
    );
  }
  throw err;
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

  return {
    chatModel: config.CHAT_MODEL,
    embeddingModel: embeddingIdentity(config),

    async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
      const prefix =
        kind === 'document' ? config.EMBEDDING_DOC_PREFIX : config.EMBEDDING_QUERY_PREFIX;
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 32) {
        const input = texts.slice(i, i + 32).map((t) => prefix + t);
        const res = await client.embeddings
          .create({
            model: config.EMBEDDING_MODEL,
            input,
            // The SDK asks for base64 by default, which not every OpenAI-compatible server supports.
            encoding_format: 'float',
            ...(config.EMBEDDING_DIMENSIONS && { dimensions: config.EMBEDDING_DIMENSIONS }),
          })
          .catch(classify);
        if (res.data.length !== input.length) {
          throw new ModelError('model_bad_output', 'wrong number of embeddings returned');
        }
        for (const d of [...res.data].sort((a, b) => a.index - b.index)) {
          const vector = embeddingVector.safeParse(d.embedding);
          if (!vector.success || vector.data.length !== (vectors[0] ?? vector.data).length) {
            throw new ModelError(
              'model_bad_output',
              'the embedding model returned an unusable vector',
            );
          }
          vectors.push(vector.data);
        }
      }
      return vectors;
    },

    async answer(messages: ChatCompletionMessageParam[]): Promise<ModelAnswer> {
      const body = {
        model: config.CHAT_MODEL,
        messages,
        max_tokens: config.CHAT_MAX_TOKENS,
        response_format: answerFormat,
        ...(config.CHAT_TEMPERATURE !== undefined && { temperature: config.CHAT_TEMPERATURE }),
        ...(config.CHAT_TOP_P !== undefined && { top_p: config.CHAT_TOP_P }),
        // Not in the OpenAI API, but LM Studio and other servers accept it.
        ...(config.CHAT_TOP_K !== undefined && { top_k: config.CHAT_TOP_K }),
        ...(config.CHAT_REASONING_EFFORT && { reasoning_effort: config.CHAT_REASONING_EFFORT }),
      };
      const res = await client.chat.completions
        .create(body as unknown as ChatCompletionCreateParamsNonStreaming)
        .catch(classify);
      const choice = res.choices[0];
      if (choice?.finish_reason === 'length') {
        throw new ModelError('model_bad_output', 'the model hit its token cap before answering');
      }
      const content = choice?.message.content ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new ModelError(
          'model_bad_output',
          'the model did not return JSON',
          content.slice(0, 2_000),
        );
      }
      const result = modelAnswer.safeParse(parsed);
      if (!result.success) {
        throw new ModelError(
          'model_bad_output',
          'the model returned the wrong JSON shape',
          content.slice(0, 2_000),
        );
      }
      return result.data;
    },
  };
}
