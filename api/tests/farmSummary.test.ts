import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { FastifyInstance } from 'fastify';
import { FarmSummaryService, getDailyCycleStart, resolveItemDisplayName } from '../src/services/FarmSummaryService.js';
import { renderAdminFarmHtml } from '../src/routes/views/adminFarmView.js';
import { unsafeTestDbReason } from './helpers/testDbGuard.js';

const API_KEY = vi.hoisted(() => (process.env.API_KEY = 'chave-de-teste-summary'));
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYER_A = '5511999990011';
const PLAYER_B = '5511999990012';

describe('FarmSummaryService (unit)', () => {
  it('resolve nomes de sementes, colheitas, consumíveis e decorações', () => {
    expect(resolveItemDisplayName('01_nightshade')).toBe('Erva-Moura');
    expect(resolveItemDisplayName('crop_01_nightshade')).toBe('Erva-Moura (Colhida)');
    expect(resolveItemDisplayName('blood_ruby')).toBe('Rubi Sanguíneo');
    expect(resolveItemDisplayName('decor_01_dark_mossy_boulders')).toBe('Pedregulhos com Musgo Sombrio');
  });

  it('calcula o início do ciclo diário às 06:00 UTC (03:00 BRT)', () => {
    const afterReset = new Date('2026-11-26T10:00:00Z');
    expect(getDailyCycleStart(afterReset).toISOString()).toBe('2026-11-26T06:00:00.000Z');

    const beforeReset = new Date('2026-11-26T04:00:00Z');
    expect(getDailyCycleStart(beforeReset).toISOString()).toBe('2026-11-25T06:00:00.000Z');
  });

  it('agrega janelas temporais, classificados, compras históricas e totais do jogador', async () => {
    const now = new Date('2026-11-26T15:00:00Z');
    const twoHoursAgo = new Date('2026-11-26T13:00:00Z');
    const futureWither = new Date('2026-11-26T22:00:00Z');
    const fiveDaysAgo = new Date('2026-11-21T15:00:00Z');
    const tenDaysAgo = new Date('2026-11-16T15:00:00Z');
    const twentyDaysAgo = new Date('2026-11-06T15:00:00Z');

    const mockPrisma = {
      player: {
        findUnique: vi.fn().mockResolvedValue({
          id: PLAYER_A,
          uuid: 'uuid-test',
          farmName: 'Cripta Teste',
          playerName: 'Tester',
          coins: 1200,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          lastDailyAt: null,
          totalPlanted: 50,
          totalHarvested: 40,
          totalWithered: 3,
          slots: [
            { slotIndex: 1, plantId: '01_nightshade', stage: 'ready', plantedAt: twoHoursAgo, harvestAt: twoHoursAgo, witherAt: futureWither },
            { slotIndex: 2, plantId: null, stage: 'empty', plantedAt: null, harvestAt: null, witherAt: null },
          ],
          decorations: [{ slotIndex: 1, decorId: 'decor_01_dark_mossy_boulders', x: 100, y: 100 }],
          inventory: [
            { itemId: '01_nightshade', quantity: 4 },
            { itemId: 'crop_01_nightshade', quantity: 2 },
            { itemId: 'blood_ruby', quantity: 1 },
          ],
          buffs: [],
        }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          coins: 1200,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          totalPlanted: 50,
          totalHarvested: 40,
          totalWithered: 3,
        }),
      },
      playerBuff: { findMany: vi.fn().mockResolvedValue([]) },
      farmEvent: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'plant', itemId: '01_nightshade', quantity: 2, coinsDelta: 0, createdAt: twoHoursAgo },
          { type: 'harvest', itemId: 'crop_01_nightshade', quantity: 2, coinsDelta: 100, createdAt: twoHoursAgo },
          { type: 'buy', itemId: '01_nightshade', quantity: 3, coinsDelta: -150, createdAt: twoHoursAgo },
          { type: 'sell', itemId: 'crop_01_nightshade', quantity: 1, coinsDelta: 80, createdAt: fiveDaysAgo },
          { type: 'wither', itemId: null, quantity: 1, coinsDelta: 0, createdAt: tenDaysAgo },
          { type: 'transfer_out', itemId: 'crop_01_nightshade', quantity: 2, coinsDelta: 0, createdAt: tenDaysAgo },
          { type: 'transfer_in', itemId: null, quantity: 0, coinsDelta: 300, createdAt: twentyDaysAgo },
          { type: 'daily', itemId: null, quantity: 1, coinsDelta: 200, createdAt: twoHoursAgo },
        ]),
      },
      dailyPurchase: {
        findMany: vi.fn().mockResolvedValue([
          // Mesma data do evento `buy` acima: não deve ser somado em dobro
          { itemId: '01_nightshade', quantity: 3, date: new Date('2026-11-26T00:00:00Z') },
          // Compra legada (12 dias atrás, sem FarmEvent): deve entrar em d15, d30 e total
          { itemId: '02_tomb_shroom', quantity: 5, date: new Date('2026-11-14T00:00:00Z') },
        ]),
      },
      cropHarvestTotal: {
        findMany: vi.fn().mockResolvedValue([
          { itemId: 'crop_01_nightshade', totalHarvested: 40 },
        ]),
      },
    } as any;

    const service = new FarmSummaryService(mockPrisma);
    const summary = await service.getPlayerSummary(PLAYER_A, now);

    expect(summary.coins).toBe(1200);
    expect(summary.inventorySummary.seedsCount).toBe(4);
    expect(summary.inventorySummary.cropsCount).toBe(2);
    expect(summary.inventorySummary.consumablesCount).toBe(1);
    expect(summary.inventorySummary.equippedDecorationsCount).toBe(1);
    expect(summary.slotsSummary.ready).toBe(1);
    expect(summary.slotsSummary.empty).toBe(1);

    // Hoje: 2 plantadas, 2 colhidas, 3 compradas, +100 colheita +200 sacola -150 loja = +150 net
    expect(summary.periods.today.planted).toBe(2);
    expect(summary.periods.today.harvested).toBe(2);
    expect(summary.periods.today.seedsBought).toBe(3);
    expect(summary.periods.today.coins.earned).toBe(300);
    expect(summary.periods.today.coins.spent).toBe(150);
    expect(summary.periods.today.coins.net).toBe(150);

    // 7 dias: inclui venda de 80
    expect(summary.periods.d7.itemsSold).toBe(1);
    expect(summary.periods.d7.coins.fromSales).toBe(80);

    // 15 dias: inclui withered (1), transfer_out (2 itens) e compra legada (5 sementes)
    expect(summary.periods.d15.withered).toBe(1);
    expect(summary.periods.d15.seedsBought).toBe(8);
    expect(summary.periods.d15.classifieds.itemsSent).toBe(2);

    // 30 dias: inclui transfer_in (+300 petalitas)
    expect(summary.periods.d30.classifieds.coinsReceived).toBe(300);

    // Totais: aproveita acumulado histórico do Player (50/40/3)
    expect(summary.periods.total.planted).toBe(50);
    expect(summary.periods.total.harvested).toBe(40);
    expect(summary.periods.total.withered).toBe(3);
    expect(summary.periods.total.topHarvested[0].quantity).toBe(40);
  });

  it('não conta em dobro a compra feita entre 00:00 e 06:00 UTC, que pertence ao ciclo do dia anterior', async () => {
    const now = new Date('2026-11-26T04:00:00Z');
    const boughtAt = new Date('2026-11-26T02:00:00Z');
    const mockPrisma = {
      player: {
        findUnique: vi.fn().mockResolvedValue({
          id: PLAYER_A,
          uuid: 'uuid-test',
          farmName: 'Cripta Teste',
          playerName: 'Tester',
          coins: 850,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          lastDailyAt: null,
          totalPlanted: 0,
          totalHarvested: 0,
          totalWithered: 0,
          slots: [],
          decorations: [],
          inventory: [{ itemId: '01_nightshade', quantity: 3 }],
          buffs: [],
        }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          coins: 850,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          totalPlanted: 0,
          totalHarvested: 0,
          totalWithered: 0,
        }),
      },
      playerBuff: { findMany: vi.fn().mockResolvedValue([]) },
      farmEvent: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'buy', itemId: '01_nightshade', quantity: 3, coinsDelta: -150, createdAt: boughtAt },
        ]),
      },
      dailyPurchase: {
        findMany: vi.fn().mockResolvedValue([
          { itemId: '01_nightshade', quantity: 3, date: new Date('2026-11-25T00:00:00Z') },
        ]),
      },
      cropHarvestTotal: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const summary = await new FarmSummaryService(mockPrisma).getPlayerSummary(PLAYER_A, now);

    expect(summary.periods.today.seedsBought).toBe(3);
    expect(summary.periods.d7.seedsBought).toBe(3);
    expect(summary.periods.total.seedsBought).toBe(3);
  });

  it('renderiza a aba Resumo e controles de período na interface web da fazenda', () => {
    const html = renderAdminFarmHtml({
      status: {
        playerId: PLAYER_A,
        uuid: 'uuid-test',
        farmName: 'Jardim Teste',
        coins: 500,
        slots: [],
        decorations: [],
        inventory: [],
        buffs: {
          effectiveCoinMultiplier: 1,
          effectiveGrowthMultiplier: 1,
          hasActiveBonus: false,
          witherFrozen: false,
          dailySpecialItemBonus: 0,
          dailyLuckMultiplier: 1,
          activeBuffs: [],
        },
        stats: { totalPlanted: 0, totalHarvested: 0, totalWithered: 0 },
      },
      token: 'tok',
      expiresAt: Date.now() + 60000,
      publicUrl: 'http://localhost:3040',
      timeCycle: 'night',
      shopCatalog: [],
      slotCoordinates: {},
    });

    expect(html).toContain('data-tab="tab-summary"');
    expect(html).toContain('id="tab-summary"');
    expect(html).toContain('data-period="today"');
    expect(html).toContain('data-period="d7"');
    expect(html).toContain('data-period="d15"');
    expect(html).toContain('data-period="d30"');
    expect(html).toContain('data-period="total"');
    expect(html).toContain("'/summary'");
  });
});

const DB_URL = process.env.JDS_TEST_DATABASE_URL;
const UNSAFE_DB = DB_URL ? unsafeTestDbReason(DB_URL) : null;
const SCHEMA = 'farm_summary_test';

describe.skipIf(!DB_URL)('GET /farm/:user_id/summary (Postgres)', () => {
  let app: FastifyInstance;
  let authA: Record<string, string>;
  const exporter = new InMemorySpanExporter();

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).__OTEL_ENABLED = true;
    if (UNSAFE_DB) throw new Error(`JDS_TEST_DATABASE_URL recusada: ${UNSAFE_DB}.`);
    const url = new URL(DB_URL!);
    url.searchParams.set('schema', SCHEMA);
    process.env.DATABASE_URL = url.href;
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: API_DIR, stdio: 'pipe' });
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    const { buildServer } = await import('../src/server.js');
    const { generateAdminToken } = await import('../src/utils/token.js');
    authA = { authorization: `Bearer ${generateAdminToken(PLAYER_A).token}` };
    app = await buildServer();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    (globalThis as Record<string, unknown>).__OTEL_ENABLED = false;
    if (!app) return;
    await app.prisma.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await app.close();
  });

  beforeEach(async () => {
    await app.prisma.player.deleteMany({});
    await app.prisma.player.create({
      data: {
        id: PLAYER_A,
        coins: 1000,
        slots: {
          create: Array.from({ length: 9 }, (_, i) => ({ slotIndex: i + 1, stage: 'empty' })),
        },
      },
    });
    exporter.reset();
  });

  it('recusa chamada sem autenticação com 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/farm/${PLAYER_A}/summary` });
    expect(res.statusCode).toBe(401);
  });

  it('registra eventos reais de compra, plantio e transferência e retorna no resumo', async () => {
    // 1. Compra 2 sementes de Erva-Moura
    const buyRes = await app.inject({
      method: 'POST',
      url: `/shop/buy/${PLAYER_A}`,
      headers: { 'content-type': 'application/json', ...authA },
      payload: JSON.stringify({ itemId: '01_nightshade', quantity: 2 }),
    });
    expect(buyRes.statusCode).toBe(200);

    // 2. Planta 1 semente
    const plantRes = await app.inject({
      method: 'POST',
      url: `/farm/${PLAYER_A}/plant`,
      headers: { 'content-type': 'application/json', ...authA },
      payload: JSON.stringify({ itemId: '01_nightshade', slot: 1 }),
    });
    expect(plantRes.statusCode).toBe(200);

    // 3. Recebe 150 petalitas via /admin/transfer (classificados)
    const transferRes = await app.inject({
      method: 'POST',
      url: '/admin/transfer',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      payload: JSON.stringify({ fromUserId: PLAYER_A, toUserId: PLAYER_B, coins: 50 }),
    });
    expect(transferRes.statusCode).toBe(200);

    // 4. Consulta o resumo do jogador A
    const sumRes = await app.inject({
      method: 'GET',
      url: `/farm/${PLAYER_A}/summary`,
      headers: authA,
    });
    expect(sumRes.statusCode).toBe(200);
    const body = sumRes.json();
    expect(body.periods.today.seedsBought).toBe(2);
    expect(body.periods.today.planted).toBe(1);
    expect(body.periods.today.classifieds.coinsSent).toBe(50);
    expect(body.periods.today.coins.spentShop).toBeGreaterThan(0);

    const summarySpans = exporter.getFinishedSpans().filter((s) => s.name === 'farm summary');
    expect(summarySpans).toHaveLength(1);
    expect(summarySpans[0].attributes['jds.user.id']).toBe(PLAYER_A);
  });
});
