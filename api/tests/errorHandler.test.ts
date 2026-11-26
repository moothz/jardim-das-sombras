import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const API_KEY = vi.hoisted(() => (process.env.API_KEY = 'chave-de-teste-erro'));
const PRISMA_ERROR = vi.hoisted(() =>
  Object.assign(new Error('Invalid `this.prisma.player.update()` invocation in /app/src/services/FarmService.ts'), {
    code: 'P2025',
  })
);
const recordError = vi.hoisted(() => vi.fn());

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    player = { update: vi.fn().mockRejectedValue(PRISMA_ERROR) };
    async $connect() {}
    async $disconnect() {}
  },
}));

vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  recordError,
}));

const GENERIC_500 = {
  statusCode: 500,
  code: 'INTERNAL_ERROR',
  error: 'Internal Server Error',
  message: 'Erro interno no Jardim das Sombras',
};

describe('tratador de erro nas rotas', () => {
  let app: FastifyInstance;
  const key = { 'x-api-key': API_KEY, 'content-type': 'application/json' };

  beforeAll(async () => {
    const { buildServer } = await import('../src/server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('500 inesperado devolve mensagem genérica e marca o span', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/farm/5511999990001/name', headers: key, payload: '{"farmName":"x"}' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(GENERIC_500);
    expect(res.body).not.toMatch(/prisma|invocation|FarmService/i);
    expect(recordError).toHaveBeenCalledWith(undefined, PRISMA_ERROR);
  });

  it('DomainError mantém statusCode, code, error e message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/farm/5511999990001/sell',
      headers: key,
      payload: JSON.stringify({ itemId: 'crop_01_nightshade', quantity: 0.5 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      statusCode: 400,
      code: 'INVALID_QUANTITY',
      error: 'Bad Request',
      message: 'A quantidade para vender deve ser um número inteiro maior que zero.',
    });
  });

  it('DomainError de autenticação mantém o formato', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/farm/5511999990001/name',
      headers: { 'content-type': 'application/json' },
      payload: '{"farmName":"x"}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
      message: 'Chave de API ou Token inválido ou não fornecido',
    });
  });

  it('JSON inválido continua 400 do Fastify', async () => {
    const res = await app.inject({ method: 'POST', url: '/farm/5511999990001/sell', headers: key, payload: '{nao json' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ statusCode: 400, error: 'Bad Request', message: expect.stringContaining('JSON') });
  });

  it('limite de requisições continua 429 com retry-after', async () => {
    let res = await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.9.9.9' });
    for (let i = 0; i < 120; i++) res = await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.9.9.9' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.json()).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' });
  });
});
