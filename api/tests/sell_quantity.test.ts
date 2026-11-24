import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { FastifyInstance } from 'fastify';
import { FarmService } from '../src/services/FarmService.js';
import { unsafeTestDbReason } from './helpers/testDbGuard.js';

const API_KEY = vi.hoisted(() => (process.env.API_KEY = 'chave-de-teste-venda'));
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CROP = 'crop_01_nightshade';
const DECOR = 'decor_01_dark_mossy_boulders';
const CROP_PRICE = 80;

describe('FarmService.sell: quantity', () => {
  it.each([0.5, 1.5, -5, 0, NaN, Infinity])('recusa %s sem abrir transação', async (quantity) => {
    const prisma = {
      player: { findUnique: vi.fn().mockResolvedValue({ id: 'p1', coins: 0, slots: [] }), update: vi.fn() },
      inventory: {
        findMany: vi.fn().mockResolvedValue([{ itemId: CROP, quantity: 10 }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      playerBuff: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (cb) => cb(prisma)),
    } as any;

    await expect(new FarmService(prisma).sell('p1', { itemId: CROP, quantity })).rejects.toMatchObject({
      code: 'INVALID_QUANTITY',
      statusCode: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

const DB_URL = process.env.JDS_TEST_DATABASE_URL;
const UNSAFE_DB = DB_URL ? unsafeTestDbReason(DB_URL) : null;
const SCHEMA = 'sell_quantity_test';
const PLAYER = '5511999990001';

describe.skipIf(!DB_URL)('POST /farm/:user_id/sell: quantity (Postgres)', () => {
  let app: FastifyInstance;
  let playerAuth: Record<string, string>;
  const exporter = new InMemorySpanExporter();

  const sellRaw = (payload: string, headers = playerAuth) =>
    app.inject({
      method: 'POST',
      url: `/farm/${PLAYER}/sell`,
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });
  const sell = (body: object, headers = playerAuth) => sellRaw(JSON.stringify(body), headers);

  async function stateOf(itemId: string) {
    const player = await app.prisma.player.findUniqueOrThrow({ where: { id: PLAYER }, include: { inventory: true } });
    return { coins: player.coins, quantity: player.inventory.find((i) => i.itemId === itemId)?.quantity };
  }

  beforeAll(async () => {
    if (UNSAFE_DB) throw new Error(`JDS_TEST_DATABASE_URL recusada: ${UNSAFE_DB}. Use um banco descartável.`);
    const url = new URL(DB_URL!);
    url.searchParams.set('schema', SCHEMA);
    process.env.DATABASE_URL = url.href;
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: API_DIR, stdio: 'pipe' });
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    const { buildServer } = await import('../src/server.js');
    const { generateAdminToken } = await import('../src/utils/token.js');
    playerAuth = { authorization: `Bearer ${generateAdminToken(PLAYER).token}` };
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await app.prisma.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await app.close();
  });

  beforeEach(async () => {
    await app.prisma.player.deleteMany({});
    await app.prisma.player.create({
      data: {
        id: PLAYER,
        coins: 1000,
        inventory: { create: [{ itemId: CROP, quantity: 10 }, { itemId: DECOR, quantity: 10 }] },
      },
    });
    exporter.reset();
  });

  it.each([
    ['ausente', { itemId: CROP }, 1],
    ['1', { itemId: CROP, quantity: 1 }, 1],
    ['10', { itemId: CROP, quantity: 10 }, 10],
    ['acima do estoque', { itemId: CROP, quantity: 99 }, 10],
    ['acima do inteiro seguro', { itemId: CROP, quantity: 1e20 }, 10],
    ['all: true', { all: true }, 10],
    ['all: true com quantity', { all: true, quantity: 5 }, 10],
  ])('vende com quantity %s', async (_label, body, sold) => {
    const res = await sell(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      totalCoinsEarned: sold * CROP_PRICE,
      newCoinsBalance: 1000 + sold * CROP_PRICE,
      soldItems: [{ itemId: CROP, quantity: sold, unitPrice: CROP_PRICE }],
    });
    expect(await stateOf(CROP)).toEqual({ coins: 1000 + sold * CROP_PRICE, quantity: 10 - sold });
  });

  describe.each([CROP, DECOR])('%s', (itemId) => {
    it.each(['0.5', '1.5', '-5', '-0.5', '0', 'null', '"2"', '"abc"', '""', 'true', 'false', '[2]', '{}', '1e999'])(
      'recusa quantity %s com 400 e preserva saldo e estoque',
      async (quantity) => {
        const res = await sellRaw(`{"itemId":"${itemId}","quantity":${quantity}}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('INVALID_QUANTITY');
        expect(await stateOf(itemId)).toEqual({ coins: 1000, quantity: 10 });
      },
    );
  });

  it('vale a mesma regra com a API_KEY', async () => {
    const apiKey = { 'x-api-key': API_KEY };
    expect((await sell({ itemId: CROP, quantity: 0.5 }, apiKey)).statusCode).toBe(400);
    expect((await sell({ itemId: CROP, quantity: 2 }, apiKey)).statusCode).toBe(200);
    expect(await stateOf(CROP)).toEqual({ coins: 1000 + 2 * CROP_PRICE, quantity: 8 });
  });

  it('a recusa vira app.outcome=rejected no span, sem erro', async () => {
    await sell({ itemId: CROP, quantity: 0 });
    const span = exporter.getFinishedSpans().find((s) => s.name === 'farm sell')!;
    expect(span.attributes).toMatchObject({ 'app.outcome': 'rejected', 'app.reject.reason': 'invalid_quantity' });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });
});
