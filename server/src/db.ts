import { Kysely, PostgresDialect, type Generated, type GeneratedAlways } from 'kysely';
import pg from 'pg';

export interface DocumentsTable {
  id: Generated<string>;
  title: string;
  format: 'markdown' | 'text' | 'pdf';
  content: string | null;
  status: Generated<'queued' | 'processing' | 'ready' | 'failed'>;
  error_code: string | null;
  error_message: string | null;
  attempt: Generated<number>;
  heartbeat_at: Date | null;
  embedding_model: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ChunksTable {
  id: GeneratedAlways<string>;
  document_id: string;
  ordinal: number;
  start_offset: number;
  end_offset: number;
  heading_path: Generated<string>;
  text: string;
  // pgvector's text form, e.g. "[0.1,0.2]"; distance operators like <=> need raw SQL.
  embedding: string | null;
}

export interface Database {
  documents: DocumentsTable;
  chunks: ChunksTable;
}

export function createDb(
  databaseUrl: string,
  onConnectionLost: (err: Error) => void = () => {},
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    // A query that runs this long is a bug or a stuck lock; fail it instead of holding a connection.
    statement_timeout: 15_000,
  });
  // Postgres can drop a connection at any moment (a restart, a failover, a backend killed for memory). pg reports
  // it as an 'error' event on the client, which the pool re-emits while the client is idle; unhandled, either one
  // ends the process. Handled, the query in flight fails, the broken client is discarded and the next query gets a
  // new one. The client listener covers both cases, so the pool's copy is only acknowledged.
  pool.on('connect', (client) => client.on('error', onConnectionLost));
  pool.on('error', () => {});
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
