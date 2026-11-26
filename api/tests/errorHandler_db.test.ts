import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { unsafeTestDbReason } from './helpers/testDbGuard.js';

const API_KEY = vi.hoisted(() => (process.env.API_KEY = 'chave-de-teste-erro-db'));
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = process.env.JDS_TEST_DATABASE_URL;
const UNSAFE_DB = DB_URL ? unsafeTestDbReason(DB_URL) : null;
const SCHEMA = 'error_handler_test';

describe.skipIf(!DB_URL)('tratador de erro com Prisma real (Postgres)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (UNSAFE_DB) throw new Error(`JDS_TEST_DATABASE_URL recusada: ${UNSAFE_DB}. Use um banco descartável.`);
    const url = new URL(DB_URL!);
    url.searchParams.set('schema', SCHEMA);
    process.env.DATABASE_URL = url.href;
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: API_DIR, stdio: 'pipe' });
    const { buildServer } = await import('../src/server.js');
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await app.prisma.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await app.close();
  });

  it('renomear fazenda inexistente devolve 500 sem o texto do Prisma', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/farm/5511999990999/name',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: '{"farmName":"x"}',
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      error: 'Internal Server Error',
      message: 'Erro interno no Jardim das Sombras',
    });
    expect(res.body).not.toMatch(/prisma|invocation/i);
  });
});
