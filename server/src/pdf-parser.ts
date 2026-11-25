import { pino } from 'pino';
import { z } from 'zod';
import { createPdfParser } from './pdf/server.js';

// Its own few settings: the parser gets no database, queue or model configuration at all.
const config = z
  .object({
    HOST: z.string().default('127.0.0.1'),
    // Its own name: a host run reads the same .env as the API, whose PORT is 3000.
    PDF_PARSER_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PDF_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // The heap of each extraction's process; the container's memory limit caps the rest.
    PDF_PARSE_HEAP_MB: z.coerce.number().int().positive().default(256),
  })
  .parse(process.env);

const log = pino({ level: config.LOG_LEVEL });
const server = createPdfParser({
  timeoutMs: config.PDF_PARSE_TIMEOUT_MS,
  heapMb: config.PDF_PARSE_HEAP_MB,
  log,
});
server.listen(config.PDF_PARSER_PORT, config.HOST, () =>
  log.info({ port: config.PDF_PARSER_PORT }, 'pdf parser listening'),
);

const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
