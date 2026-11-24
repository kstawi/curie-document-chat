import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { HttpError } from './errors.js';

export type KeySettings = Pick<Config, 'IDEMPOTENCY_KEY_TTL_MS' | 'IDEMPOTENCY_TAKEOVER_MS'>;

// Visible ASCII only, so a key is safe to store, log and compare.
const VALID_KEY = /^[\x21-\x7e]{1,200}$/;

// What a request that owns a key does with it:
// - `record` stores the response in the same transaction that creates or changes the row, and fails (rolling that
//   transaction back) if another request has taken the key over since. The key stays in flight: the row can still be
//   undone if its job can't be added.
// - `finish` marks the key done once nothing will undo the row.
// - `release` gives the key up, in the transaction that undoes the row when there is one. Without that transaction
//   (any other failure), a key with a stored response stays: the row it describes was committed, and a repeat gets
//   that response once the takeover time has passed.
export interface Claim {
  record(trx: Transaction<Database>, status: number, body: unknown): Promise<void>;
  finish(): Promise<void>;
  release(trx?: Kysely<Database>): Promise<void>;
}

const noKey: Claim = { record: async () => {}, finish: async () => {}, release: async () => {} };

export const requestHash = (fingerprint: unknown) =>
  createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');

const inProgress = () =>
  new HttpError(
    409,
    'request_in_progress',
    'A request with this Idempotency-Key is still in progress.',
  );

// Claims a key for a request, or finds the response to replay. A key in flight for longer than the takeover time
// belongs to a request presumed dead (the process stopped before it finished): if that request got as far as storing
// its response, its row was committed and the sweeper will see it through, so the response stands; otherwise the key
// is taken over.
export async function claimKey(
  db: Kysely<Database>,
  settings: KeySettings,
  scope: string,
  key: string,
  hash: string,
): Promise<{ replay: { status: number; body: string } } | { claim: Claim }> {
  const claimId = randomUUID();
  const now = new Date();
  const fresh = {
    request_hash: hash,
    claim: claimId,
    state: 'in_flight' as const,
    status_code: null,
    response: null,
    created_at: now,
    expires_at: new Date(now.getTime() + settings.IDEMPOTENCY_KEY_TTL_MS),
  };
  const mine = (q: Kysely<Database>) =>
    q
      .updateTable('idempotency_keys')
      .where('scope', '=', scope)
      .where('key', '=', key)
      .where('claim', '=', claimId);
  const claim: Claim = {
    async record(trx, status, body) {
      const res = await mine(trx)
        .set({ status_code: status, response: JSON.stringify(body) })
        .executeTakeFirst();
      if (!res.numUpdatedRows) {
        throw new HttpError(409, 'request_in_progress', 'Another request with this key took over.');
      }
    },
    async finish() {
      await mine(db).set({ state: 'done' }).execute();
    },
    async release(trx) {
      await (trx ?? db)
        .deleteFrom('idempotency_keys')
        .where('scope', '=', scope)
        .where('key', '=', key)
        .where('claim', '=', claimId)
        .$if(!trx, (q) => q.where('response', 'is', null))
        .execute();
    },
  };

  const inserted = await db
    .insertInto('idempotency_keys')
    .values({ scope, key, ...fresh })
    .onConflict((oc) => oc.columns(['scope', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (inserted) return { claim };

  const row = await db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('scope', '=', scope)
    .where('key', '=', key)
    .executeTakeFirst();
  // Released between the insert and the read: another request is starting with it right now.
  if (!row) throw inProgress();
  const expired = row.expires_at <= now;
  if (!expired && row.request_hash !== hash) {
    throw new HttpError(
      422,
      'idempotency_key_reused',
      'This Idempotency-Key was already used for a different request.',
    );
  }
  const replay = { replay: { status: row.status_code!, body: row.response! } };
  if (!expired && row.state === 'done') return replay;
  if (!expired && now.getTime() - row.created_at.getTime() < settings.IDEMPOTENCY_TAKEOVER_MS) {
    throw inProgress();
  }
  if (!expired && row.response !== null) return replay;
  // Only the row as read: if its request stored a response or finished in the meantime, nothing is taken over.
  const taken = await db
    .updateTable('idempotency_keys')
    .set(fresh)
    .where('scope', '=', scope)
    .where('key', '=', key)
    .where('claim', '=', row.claim)
    .where('state', '=', row.state)
    .where((eb) =>
      row.response === null ? eb('response', 'is', null) : eb('response', '=', row.response),
    )
    .executeTakeFirst();
  if (!taken.numUpdatedRows) throw inProgress();
  return { claim };
}

// Runs a POST at most once per Idempotency-Key. The same key with the same request gets the first response again; with
// a different request, 422; while the first is still running, 409. No key, no change. A failure releases the key, so a
// client can try again with it, unless its response was already stored with a committed row. Scope is the route pattern; the fingerprint covers the ids in the path and the body.
export async function withIdempotencyKey(
  {
    db,
    settings,
    request,
    reply,
  }: {
    db: Kysely<Database>;
    settings: KeySettings;
    request: FastifyRequest;
    reply: FastifyReply;
  },
  fingerprint: unknown,
  run: (claim: Claim) => Promise<{ status: number; body: unknown }>,
) {
  const key = request.headers['idempotency-key'];
  let claim = noKey;
  if (key !== undefined) {
    if (typeof key !== 'string' || !VALID_KEY.test(key)) {
      throw new HttpError(
        400,
        'invalid_request',
        'Idempotency-Key must be 1 to 200 visible ASCII characters.',
      );
    }
    const scope = `${request.method} ${request.routeOptions.url}`;
    const found = await claimKey(db, settings, scope, key, requestHash(fingerprint));
    // Sent as stored: a string with a JSON content type skips the response serializer, so it goes out byte for byte.
    if ('replay' in found) {
      return reply
        .code(found.replay.status)
        .type('application/json; charset=utf-8')
        .send(found.replay.body);
    }
    claim = found.claim;
  }
  let result: { status: number; body: unknown };
  try {
    result = await run(claim);
  } catch (err) {
    await claim.release().catch(() => {});
    throw err;
  }
  // If this fails, the key stays in flight with its response stored, and a repeat gets that response once the
  // takeover time has passed.
  await claim.finish().catch(() => {});
  return reply.code(result.status).send(result.body);
}
