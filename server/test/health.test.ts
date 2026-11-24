import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createQueues } from '../src/queue.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const queues = createQueues(config.REDIS_URL, 'test-health');
const build = (r: Redis) => buildApp({ db, redis: r, queues, embeddingModel: 'none' });
const redis = new Redis(config.REDIS_URL, {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
// Nothing listens on port 1. With the offline queue off, a command on this unconnected client fails at once, as
// it does in the API while Redis is down.
const deadRedis = new Redis('redis://127.0.0.1:1', {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 0,
});

deadRedis.on('error', () => {}); // its connection errors are the point of the test

// Without an offline queue, a command sent before the connection is open fails, so connect first.
beforeAll(() => redis.connect());

afterAll(async () => {
  await Promise.allSettled([
    db.destroy(),
    redis.quit(),
    deadRedis.disconnect(),
    ...Object.values(queues).map((q) => q.close()),
  ]);
});

describe('health and readiness', () => {
  it('reports liveness without touching dependencies', async () => {
    const app = build(deadRedis);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is ready when Postgres and Redis answer', async () => {
    const app = build(redis);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok' } });
  });

  it('is not ready, and says which dependency is missing, when Redis is down', async () => {
    const app = build(deadRedis);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'ok', redis: 'unavailable' },
    });
  });

  it('gives up on a dependency that never answers after about two seconds', async () => {
    const hungRedis = { ping: () => new Promise(() => {}) } as unknown as Redis;
    const app = build(hungRedis);
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: 'ok', redis: 'unavailable' });
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_000);
  });
});
