import {
  Kysely,
  PostgresDialect,
  type ColumnType,
  type Generated,
  type GeneratedAlways,
} from 'kysely';
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

export interface ConversationsTable {
  id: Generated<string>;
  document_id: string;
  created_at: Generated<Date>;
}

export interface Quote {
  text: string;
  start: number;
  end: number;
  line: number;
  section: string;
}

export interface TurnsTable {
  id: Generated<string>;
  conversation_id: string;
  sequence: number;
  question: string;
  status: Generated<'pending' | 'completed' | 'failed'>;
  stage: string | null;
  outcome: 'answered' | 'not_in_document' | 'unsupported' | null;
  answer: string | null;
  note: string | null;
  quotes: ColumnType<Quote[], string | undefined, string>;
  search_question: string | null;
  answer_path: string | null;
  chat_model: string | null;
  error_code: string | null;
  // Never returned by the API: the model's draft, unverified quotes, raw provider errors.
  debug: ColumnType<unknown, string | null | undefined, string | null>;
  attempt: Generated<number>;
  heartbeat_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  documents: DocumentsTable;
  chunks: ChunksTable;
  conversations: ConversationsTable;
  turns: TurnsTable;
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
  // ends the process. Handled, the query in flight fails and the broken client is discarded; a query sent before
  // the pool has noticed can fail too, later ones get new connections. The client listener covers both cases, so
  // the pool's copy is only acknowledged.
  pool.on('connect', (client) => client.on('error', onConnectionLost));
  pool.on('error', () => {});
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
