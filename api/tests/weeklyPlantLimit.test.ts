import { describe, it, expect, vi } from 'vitest';
import { PLANTS } from '../src/utils/catalog.js';
import { FarmService } from '../src/services/FarmService.js';

describe('Limite semanal de plantio por espécie', () => {
  it('mantém categoria economia sem limite e demais categorias com 30/semana', () => {
    const plants = Object.values(PLANTS);
    expect(plants.length).toBeGreaterThan(0);

    for (const p of plants) {
      if (p.category === 'economia') {
        expect(p.weeklyPlantLimit).toBeNull();
      } else {
        expect(p.weeklyPlantLimit).toBe(30);
      }
    }
  });

  it('bloqueia plantio quando atinge o limite semanal da espécie', async () => {
    const nonEconPlant = Object.values(PLANTS).find((p) => p.category !== 'economia')!;
    const mockPrisma: any = {
      player: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          coins: 1000,
          slots: [
            { id: 1, slotIndex: 1, stage: 'empty', plantId: null, plantedAt: null, harvestAt: null, witherAt: null },
          ],
          decorations: [],
          buffs: [],
        }),
      },
      inventory: {
        findUnique: vi.fn().mockResolvedValue({ playerId: 'p1', itemId: nonEconPlant.id, quantity: 10 }),
      },
      farmEvent: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 30 } }),
      },
    };

    const svc = new FarmService(mockPrisma);
    await expect(svc.plant('p1', { itemId: nonEconPlant.id, slot: 1 })).rejects.toMatchObject({
      code: 'WEEKLY_PLANT_LIMIT_REACHED',
    });
  });

  it('limita !plantar_tudo ao restante semanal da espécie', async () => {
    const nonEconPlant = Object.values(PLANTS).find((p) => p.category !== 'economia')!;
    const slots = [1, 2, 3, 4, 5].map((idx) => ({
      id: idx,
      slotIndex: idx,
      stage: 'empty',
      plantId: null,
      plantedAt: null,
      harvestAt: null,
      witherAt: null,
    }));

    const mockPrisma: any = {
      player: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          coins: 1000,
          slots,
          decorations: [],
          buffs: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      inventory: {
        findUnique: vi.fn().mockResolvedValue({ playerId: 'p1', itemId: nonEconPlant.id, quantity: 10 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      playerBuff: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      farmEvent: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 28 } }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      farmSlot: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
    };

    const svc = new FarmService(mockPrisma);
    const res = await svc.plant('p1', { itemId: nonEconPlant.id, amount: 9 });
    expect(res.plantedCount).toBe(2);
  });
});
