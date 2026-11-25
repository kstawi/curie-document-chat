import type { Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import type { Database } from './db.js';
import * as m0001 from './migrations/0001_initial.js';
import * as m0002 from './migrations/0002_conversations.js';
import * as m0003 from './migrations/0003_requeues.js';
import * as m0004 from './migrations/0004_idempotency_keys.js';
import * as m0005 from './migrations/0005_pdf.js';

// Listed in code rather than read from disk, so the same list works under tsx and from the compiled build.
const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_conversations': m0002,
  '0003_requeues': m0003,
  '0004_idempotency_keys': m0004,
  '0005_pdf': m0005,
};

// Kysely's Postgres migrator holds an advisory lock while it runs, so two services starting together can't apply
// the same migration twice.
export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    const what = failed ? `migration ${failed.migrationName}` : 'running migrations';
    throw new Error(`Failed ${what}`, { cause: error });
  }
}
