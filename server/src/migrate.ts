import type { Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import type { Database } from './db.js';
import * as m0001 from './migrations/0001_initial.js';

// Listed in code rather than read from disk, so the same list works under tsx and from the compiled build.
const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
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
