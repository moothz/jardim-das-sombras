import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import Fastify, { FastifyInstance } from 'fastify';
import { farmRoutes } from '../src/routes/farm.js';
import { generateAdminToken } from '../src/utils/token.js';
import { unsafeTestDbReason } from './helpers/testDbGuard.js';

const API_KEY = vi.hoisted(() => (process.env.API_KEY = 'chave-de-teste-plantio'));
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYER = '5511999990001';
const OTHER_PLAYER = '5511999990002';
const SEED = '01_nightshade';
const WITHER_SECONDS = 14400;

const playerToken = generateAdminToken(PLAYER).token;
const playerAuth = { authorization: `Bearer ${playerToken}` };
const otherAuth = { authorization: `Bearer ${generateAdminToken(OTHER_PLAYER).token}` };
const xApiKey = { 'x-api-key': API_KEY };
const bearerApiKey = { authorization: `Bearer ${API_KEY}` };

const plant = (app: FastifyInstance, headers: Record<string, string>, witherMultiplier?: string, query = '') =>
  app.inject({
    method: 'POST',
    url: `/farm/${PLAYER}/plant${query}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: `{"itemId":"${SEED}","amount":1${witherMultiplier === undefined ? '' : `,"witherMultiplier":${witherMultiplier}`}}`,
  });

describe('POST /farm/:user_id/plant: witherMultiplier (sem banco)', () => {
  const prisma = {
    player: { findUnique: vi.fn().mockResolvedValue({ id: PLAYER, slots: [{ id: 1, slotIndex: 1, stage: 'empty' }] }), update: vi.fn() },
    inventory: {
      findUnique: vi.fn().mockResolvedValue({ itemId: SEED, quantity: 5 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    playerBuff: { findMany: vi.fn().mockResolvedValue([]) },
    farmSlot: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (cb) => cb(prisma)),
  } as any;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorate('prisma', prisma);
    await app.register(farmRoutes);
  });
  afterAll(() => app.close());
  beforeEach(() => {
    prisma.$transaction.mockClear();
  });

  it('recusa o token do jogador sem abrir transação', async () => {
    const res = await plant(app, playerAuth, '1.5');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recusa valor fora do alcance de uma data sem abrir transação', async () => {
    const res = await plant(app, xApiKey, '1e12');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PAYLOAD');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('aceita a API_KEY', async () => {
    expect((await plant(app, xApiKey, '1.5')).statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

const DB_URL = process.env.JDS_TEST_DATABASE_URL;
const UNSAFE_DB = DB_URL ? unsafeTestDbReason(DB_URL) : null;
const SCHEMA = 'plant_wither_multiplier_test';

describe.skipIf(!DB_URL)('POST /farm/:user_id/plant: witherMultiplier (Postgres)', () => {
  let app: FastifyInstance;
  const exporter = new InMemorySpanExporter();

  async function farm() {
    const player = await app.prisma.player.findUniqueOrThrow({
      where: { id: PLAYER },
      include: { inventory: true, slots: { where: { plantId: { not: null } } } },
    });
    return {
      seeds: player.inventory[0].quantity,
      totalPlanted: player.totalPlanted,
      witherSeconds: player.slots.map((s) => (s.witherAt!.getTime() - s.harvestAt!.getTime()) / 1000),
    };
  }
  const untouched = { seeds: 5, totalPlanted: 0, witherSeconds: [] };
  const planted = (witherSeconds: number) => ({ seeds: 4, totalPlanted: 1, witherSeconds: [witherSeconds] });

  beforeAll(async () => {
    if (UNSAFE_DB) throw new Error(`JDS_TEST_DATABASE_URL recusada: ${UNSAFE_DB}. Use um banco descartável.`);
    const url = new URL(DB_URL!);
    url.searchParams.set('schema', SCHEMA);
    process.env.DATABASE_URL = url.href;
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: API_DIR, stdio: 'pipe' });
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    const { buildServer } = await import('../src/server.js');
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
        inventory: { create: [{ itemId: SEED, quantity: 5 }] },
        slots: { create: Array.from({ length: 9 }, (_, i) => ({ slotIndex: i + 1, stage: 'empty' })) },
      },
    });
    exporter.reset();
  });

  describe('token do jogador', () => {
    it('planta sem o campo', async () => {
      expect((await plant(app, playerAuth)).statusCode).toBe(200);
      expect(await farm()).toEqual(planted(WITHER_SECONDS));
    });

    it.each(['1.5', '1000', '1', '0', '-1', 'null', '"2"', 'true', '[2]', '{}', '1e999'])(
      'recusa witherMultiplier %s com 403 e não planta',
      async (witherMultiplier) => {
        const res = await plant(app, playerAuth, witherMultiplier);
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('FORBIDDEN');
        expect(await farm()).toEqual(untouched);
      },
    );

    it.each([
      ['x-admin-token', { 'x-admin-token': playerToken }, ''],
      ['?token=', {}, `?token=${playerToken}`],
      ['Bearer com x-api-key errada', { ...playerAuth, 'x-api-key': 'errada' }, ''],
    ])('recusa também por %s', async (_label, headers: Record<string, string>, query) => {
      expect((await plant(app, headers, '1.5', query)).json().code).toBe('FORBIDDEN');
      expect(await farm()).toEqual(untouched);
      expect((await plant(app, headers, undefined, query)).statusCode).toBe(200);
    });

    it('a recusa vira app.outcome=rejected no span, sem erro', async () => {
      await plant(app, playerAuth, '1.5');
      const span = exporter.getFinishedSpans().find((s) => s.name === 'farm plant')!;
      expect(span.attributes).toMatchObject({ 'app.outcome': 'rejected', 'app.reject.reason': 'forbidden' });
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    });
  });

  describe.each([undefined, '1.5'])('sem permissão na fazenda, witherMultiplier %s', (witherMultiplier) => {
    it.each([
      ['token de outro jogador', otherAuth, 403],
      ['sem credencial', {}, 401],
      ['x-api-key errada', { 'x-api-key': 'errada' }, 401],
    ])('%s', async (_label, headers: Record<string, string>, status) => {
      expect((await plant(app, headers, witherMultiplier)).statusCode).toBe(status);
      expect(await farm()).toEqual(untouched);
    });
  });

  describe.each([
    ['x-api-key', xApiKey],
    ['Bearer', bearerApiKey],
    ['x-api-key junto do token do jogador', { ...xApiKey, ...playerAuth }],
  ])('API_KEY por %s', (_label, headers) => {
    it.each([
      [undefined, WITHER_SECONDS],
      ['1', WITHER_SECONDS],
      ['1.5', WITHER_SECONDS * 1.5],
      ['0.5', WITHER_SECONDS * 0.5],
      ['1000', WITHER_SECONDS * 1000],
      ['"2"', WITHER_SECONDS * 2],
      ['0', WITHER_SECONDS],
      ['-1', WITHER_SECONDS],
      ['null', WITHER_SECONDS],
      ['"abc"', WITHER_SECONDS],
    ])('witherMultiplier %s planta com janela de %i s', async (witherMultiplier, seconds) => {
      expect((await plant(app, headers, witherMultiplier)).statusCode).toBe(200);
      expect(await farm()).toEqual(planted(seconds));
    });

    it.each(['1.8e7', '1e12', '1e308', '1e999', '"Infinity"'])(
      'witherMultiplier %s volta 400 e não planta',
      async (witherMultiplier) => {
        const res = await plant(app, headers, witherMultiplier);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('INVALID_PAYLOAD');
        expect(await farm()).toEqual(untouched);
      },
    );
  });

  it('a maior janela que o banco grava continua aceita', async () => {
    expect((await plant(app, xApiKey, '1.7e7')).statusCode).toBe(200);
    expect(await farm()).toEqual(planted(WITHER_SECONDS * 1.7e7));
  });

  it('o valor fora do alcance vira app.outcome=rejected no span, sem erro', async () => {
    await plant(app, xApiKey, '1e12');
    const span = exporter.getFinishedSpans().find((s) => s.name === 'farm plant')!;
    expect(span.attributes).toMatchObject({ 'app.outcome': 'rejected', 'app.reject.reason': 'invalid_payload' });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });
});
