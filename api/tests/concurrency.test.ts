import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { FarmService } from '../src/services/FarmService.js';
import { ShopService, getDailyResetDate } from '../src/services/ShopService.js';
import { BotNotifier } from '../src/services/BotNotifier.js';
import { PLANTS } from '../src/utils/catalog.js';
import { unsafeTestDbReason } from './helpers/testDbGuard.js';

const API_KEY = vi.hoisted(() => (process.env.API_KEY = 'chave-de-teste-concorrencia'));
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = process.env.JDS_TEST_DATABASE_URL;
const UNSAFE_DB = DB_URL ? unsafeTestDbReason(DB_URL) : null;
const SCHEMA = 'concurrency_test';
const PLAYER = '5511999990002';
const RECEIVER = '5511999990003';
const BURST = 8;
const ROUNDS = 5;
const REWARD_PLANT = Object.values(PLANTS).find((p) => p.coinReward > 0)!;
const SEED = PLANTS['01_nightshade'];
const HOUR = 3600_000;

function readySlot(slotIndex: number, plantId = REWARD_PLANT.id) {
  const now = Date.now();
  return {
    slotIndex,
    plantId,
    stage: 'ready',
    plantedAt: new Date(now - 2 * HOUR),
    harvestAt: new Date(now - HOUR),
    witherAt: new Date(now + 10 * HOUR),
  };
}

function emptySlots(except: number[] = []) {
  return Array.from({ length: 9 }, (_, i) => i + 1)
    .filter((i) => !except.includes(i))
    .map((slotIndex) => ({ slotIndex, stage: 'empty' }));
}

function codesOf(responses: LightMyRequestResponse[]) {
  return responses.map((r) => (r.statusCode === 200 ? 200 : `${r.statusCode} ${r.json().code}`)).sort();
}

describe.skipIf(!DB_URL)('gravação condicional sob requisições simultâneas (Postgres)', () => {
  let app: FastifyInstance;
  let playerAuth: Record<string, string>;
  let round = 0;

  const burst = (method: 'POST', url: string, payload: object, headers = playerAuth) => {
    round += 1;
    return Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        app.inject({
          method,
          url,
          remoteAddress: `10.0.${round % 250}.${i + 1}`,
          headers: { 'content-type': 'application/json', ...headers },
          payload: JSON.stringify(payload),
        }),
      ),
    );
  };

  const player = () =>
    app.prisma.player.findUniqueOrThrow({ where: { id: PLAYER }, include: { inventory: true, harvestTotals: true } });

  const events = (type: string) =>
    app.prisma.farmEvent.findMany({ where: { playerId: PLAYER, type }, select: { quantity: true, coinsDelta: true } });

  async function resetPlayer(data: { coins?: number; lastDailyAt?: Date | null; slots?: object[]; inventory?: object[] } = {}) {
    await app.prisma.player.deleteMany({});
    await app.prisma.player.create({
      data: {
        id: PLAYER,
        coins: data.coins ?? 1000,
        lastDailyAt: data.lastDailyAt ?? null,
        slots: { create: (data.slots ?? emptySlots()) as any },
        inventory: { create: (data.inventory ?? []) as any },
      },
    });
  }

  beforeAll(async () => {
    if (UNSAFE_DB) throw new Error(`JDS_TEST_DATABASE_URL recusada: ${UNSAFE_DB}. Use um banco descartável.`);
    const url = new URL(DB_URL!);
    url.searchParams.set('schema', SCHEMA);
    process.env.DATABASE_URL = url.href;
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: API_DIR, stdio: 'pipe' });
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

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('colheita de um canteiro paga uma vez só', async () => {
    const notify = vi.spyOn(BotNotifier, 'notifyHarvest').mockImplementation(() => {});
    for (let r = 0; r < ROUNDS; r++) {
      notify.mockClear();
      await resetPlayer({ slots: [readySlot(1), ...emptySlots([1])] });
      const res = await burst('POST', `/farm/${PLAYER}/harvest`, { slot: 1 });

      expect(codesOf(res)).toEqual([200, ...Array(BURST - 1).fill('400 NOT_READY_FOR_HARVEST')]);
      const ok = res.find((x) => x.statusCode === 200)!.json();
      expect(ok.totalCoinsEarned).toBeGreaterThan(0);
      const p = await player();
      expect(p.coins).toBe(1000 + ok.totalCoinsEarned);
      expect(p.totalHarvested).toBe(1);
      expect(p.inventory.find((i) => i.itemId === `crop_${REWARD_PLANT.id}`)?.quantity).toBe(1);
      expect(p.harvestTotals.find((t) => t.itemId === `crop_${REWARD_PLANT.id}`)?.totalHarvested).toBe(1);
      expect(notify.mock.calls.flatMap(([, items]) => items).reduce((n, it) => n + it.count, 0)).toBe(1);
      expect(await events('harvest')).toEqual([{ quantity: 1, coinsDelta: ok.totalCoinsEarned }]);
    }
  });

  it('colheita de todos os canteiros conta cada canteiro uma vez', async () => {
    vi.spyOn(BotNotifier, 'notifyHarvest').mockImplementation(() => {});
    for (let r = 0; r < ROUNDS; r++) {
      await resetPlayer({ slots: [readySlot(1), readySlot(2), readySlot(3), ...emptySlots([1, 2, 3])] });
      const res = await burst('POST', `/farm/${PLAYER}/harvest`, { all: true });

      expect(res.every((x) => x.statusCode === 200 || x.json().code === 'NOT_READY_FOR_HARVEST')).toBe(true);
      const oks = res.filter((x) => x.statusCode === 200).map((x) => x.json());
      const items = oks.flatMap((o) => o.harvested).reduce((n, h) => n + h.count, 0);
      const coins = oks.reduce((n, o) => n + o.totalCoinsEarned, 0);
      expect(items).toBe(3);
      const p = await player();
      expect(p.coins).toBe(1000 + coins);
      expect(p.totalHarvested).toBe(3);
      expect(p.inventory.find((i) => i.itemId === `crop_${REWARD_PLANT.id}`)?.quantity).toBe(3);
      const harvestEvents = await events('harvest');
      expect(harvestEvents.reduce((n, e) => n + e.quantity, 0)).toBe(3);
      expect(harvestEvents.reduce((n, e) => n + e.coinsDelta, 0)).toBe(coins);
    }
  });

  it('sacola diária sai uma vez por ciclo', async () => {
    for (let r = 0; r < ROUNDS; r++) {
      await resetPlayer();
      const res = await burst('POST', `/farm/${PLAYER}/daily`, {});

      expect(res.every((x) => x.statusCode === 200)).toBe(true);
      const bodies = res.map((x) => x.json());
      const claimed = bodies.filter((b) => b.claimed);
      expect(claimed).toHaveLength(1);
      expect(bodies.filter((b) => b.alreadyClaimed && b.claimed === false && b.message)).toHaveLength(BURST - 1);
      const p = await player();
      expect(p.coins).toBe(1000 + claimed[0].coinsWon);
      const seeds = p.inventory.reduce((n, i) => n + i.quantity, 0);
      expect(seeds).toBe(claimed[0].itemsWon.reduce((n: number, i: { count: number }) => n + i.count, 0));
      expect(await events('daily')).toEqual([{ quantity: 1, coinsDelta: claimed[0].coinsWon }]);
    }
  });

  it('compra com o saldo exato passa uma vez e o saldo não fica negativo', async () => {
    for (let r = 0; r < ROUNDS; r++) {
      await resetPlayer({ coins: SEED.seedPrice });
      const res = await burst('POST', `/shop/buy/${PLAYER}`, { itemId: SEED.id, quantity: 1 });

      expect(codesOf(res)).toEqual([200, ...Array(BURST - 1).fill('400 INSUFFICIENT_COINS')]);
      expect(res.find((x) => x.statusCode === 200)!.json()).toMatchObject({ remainingCoins: 0, newInventoryQuantity: 1 });
      const p = await player();
      expect(p.coins).toBe(0);
      expect(p.inventory.find((i) => i.itemId === SEED.id)?.quantity).toBe(1);
      expect(await events('buy')).toEqual([{ quantity: 1, coinsDelta: -SEED.seedPrice }]);
    }
  });

  it('compras simultâneas não passam do limite diário', async () => {
    const limit = SEED.dailyLimit!;
    const quantity = 3;
    for (let r = 0; r < ROUNDS; r++) {
      await resetPlayer({ coins: 100_000 });
      const res = await burst('POST', `/shop/buy/${PLAYER}`, { itemId: SEED.id, quantity });

      const okCount = res.filter((x) => x.statusCode === 200).length;
      expect(codesOf(res)).toEqual([
        ...Array(okCount).fill(200),
        ...Array(BURST - okCount).fill('400 PLAYER_LIMIT_EXCEEDED'),
      ]);
      expect(okCount).toBe(Math.floor(limit / quantity));
      const daily = await app.prisma.dailyPurchase.findUniqueOrThrow({
        where: { playerId_itemId_date: { playerId: PLAYER, itemId: SEED.id, date: getDailyResetDate(new Date()) } },
      });
      expect(daily.quantity).toBe(okCount * quantity);
      const p = await player();
      expect(p.coins).toBe(100_000 - okCount * quantity * SEED.seedPrice);
      expect(p.inventory.find((i) => i.itemId === SEED.id)?.quantity).toBe(okCount * quantity);
      expect(await events('buy')).toEqual(Array(okCount).fill({ quantity, coinsDelta: -quantity * SEED.seedPrice }));
    }
  });

  it('primeira compra do dia em paralelo não vira erro 500', async () => {
    for (let r = 0; r < ROUNDS; r++) {
      await resetPlayer({ coins: 100_000 });
      const res = await burst('POST', `/shop/buy/${PLAYER}`, { itemId: SEED.id, quantity: 1 });

      expect(codesOf(res)).toEqual(Array(BURST).fill(200));
      const p = await player();
      expect(p.inventory.find((i) => i.itemId === SEED.id)?.quantity).toBe(BURST);
      expect(p.coins).toBe(100_000 - BURST * SEED.seedPrice);
    }
  });

  it('plantio no mesmo canteiro gasta a semente uma vez', async () => {
    for (let r = 0; r < ROUNDS; r++) {
      await resetPlayer({ inventory: [{ itemId: SEED.id, quantity: BURST }] });
      const res = await burst('POST', `/farm/${PLAYER}/plant`, { itemId: SEED.id, slot: 1 });

      expect(codesOf(res)).toEqual([200, ...Array(BURST - 1).fill('400 SLOT_OCCUPIED')]);
      const p = await player();
      expect(p.inventory.find((i) => i.itemId === SEED.id)?.quantity).toBe(BURST - 1);
      expect(p.totalPlanted).toBe(1);
      expect(await events('plant')).toEqual([{ quantity: 1, coinsDelta: 0 }]);
    }
  });

  it('transferência de petalitas não deixa o saldo negativo', async () => {
    for (let r = 0; r < ROUNDS; r++) {
      await resetPlayer({ coins: 100 });
      await app.prisma.player.create({ data: { id: RECEIVER, coins: 0 } });
      const res = await burst(
        'POST',
        '/admin/transfer',
        { fromUserId: PLAYER, toUserId: RECEIVER, coins: 100 },
        { 'x-api-key': API_KEY },
      );

      expect(codesOf(res)).toEqual([200, ...Array(BURST - 1).fill('400 INSUFFICIENT_COINS')]);
      expect((await player()).coins).toBe(0);
      expect((await app.prisma.player.findUniqueOrThrow({ where: { id: RECEIVER } })).coins).toBe(100);
      expect(await events('transfer_out')).toEqual([{ quantity: 0, coinsDelta: -100 }]);
    }
  });
});

describe('gravação condicional: guarda perdida não grava o resto', () => {
  const tx = (prisma: any) => vi.fn(async (cb: any) => cb(prisma));

  it('sacola: a guarda perdida responde "já coletou" sem creditar sementes', async () => {
    const prisma: any = {
      player: {
        findUnique: vi.fn().mockResolvedValue({ id: 'p1', coins: 100, lastDailyAt: null, slots: [] }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      playerBuff: { findMany: vi.fn().mockResolvedValue([]) },
      playerDecoration: { findMany: vi.fn().mockResolvedValue([]) },
      inventory: { upsert: vi.fn() },
    };
    prisma.$transaction = tx(prisma);

    const r = await new FarmService(prisma).claimDaily('p1');
    expect(r).toMatchObject({ claimed: false, alreadyClaimed: true });
    expect(prisma.inventory.upsert).not.toHaveBeenCalled();
  });

  it('loja: a guarda de saldo perdida recusa sem entregar o item', async () => {
    const prisma: any = {
      player: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: 'p1', coins: SEED.seedPrice })
          .mockResolvedValue({ id: 'p1', coins: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      dailyPurchase: {
        findUnique: vi.fn().mockResolvedValue(null),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      inventory: { upsert: vi.fn() },
    };
    prisma.$transaction = tx(prisma);

    await expect(new ShopService(prisma).buy('p1', SEED.id, 1)).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });
    expect(prisma.inventory.upsert).not.toHaveBeenCalled();
  });

  it('plantio: a guarda do canteiro perdida recusa sem contar o plantio', async () => {
    const prisma: any = {
      player: {
        findUnique: vi.fn().mockResolvedValue({ id: 'p1', coins: 0, slots: [{ id: 1, slotIndex: 1, stage: 'empty', plantId: null, plantedAt: null }] }),
        update: vi.fn(),
      },
      inventory: {
        findUnique: vi.fn().mockResolvedValue({ itemId: SEED.id, quantity: 5 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      playerBuff: { findMany: vi.fn().mockResolvedValue([]) },
      playerDecoration: { findMany: vi.fn().mockResolvedValue([]) },
      farmSlot: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction = tx(prisma);

    await expect(new FarmService(prisma).plant('p1', { itemId: SEED.id, slot: 1 })).rejects.toMatchObject({ code: 'SLOT_OCCUPIED' });
    expect(prisma.player.update).not.toHaveBeenCalled();
  });

  it('colheita: nenhum canteiro conquistado recusa sem pagar', async () => {
    const notify = vi.spyOn(BotNotifier, 'notifyHarvest').mockImplementation(() => {});
    const slot = { id: 1, ...readySlot(1) };
    const prisma: any = {
      player: { findUnique: vi.fn().mockResolvedValue({ id: 'p1', coins: 0, slots: [slot] }), update: vi.fn() },
      playerBuff: { findMany: vi.fn().mockResolvedValue([]) },
      playerDecoration: { findMany: vi.fn().mockResolvedValue([]) },
      inventory: { upsert: vi.fn() },
      cropHarvestTotal: { upsert: vi.fn() },
      farmSlot: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction = tx(prisma);

    await expect(new FarmService(prisma).harvest('p1', { slot: 1 })).rejects.toMatchObject({ code: 'NOT_READY_FOR_HARVEST' });
    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(prisma.inventory.upsert).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
