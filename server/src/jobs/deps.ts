import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import type { Model } from '../model.js';

export interface JobDeps {
  db: Kysely<Database>;
  model: Model;
  log: Logger;
  config: Config;
}
