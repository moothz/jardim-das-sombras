import { describe, it, expect, vi } from 'vitest';
import { FarmService } from '../src/services/FarmService.js';

describe('Inventory Concurrency & Atomic Decrement Guards', () => {
  it('plant() should abort and throw DomainError if concurrent operation depleted inventory', async () => {
    const mockPrisma = {
      player: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'test-user',
          coins: 500,
          slots: [
            { id: 1, slotIndex: 1, stage: 'empty', plantId: null },
            { id: 2, slotIndex: 2, stage: 'empty', plantId: null },
          ],
        }),
      },
      inventory: {
        findUnique: vi.fn().mockResolvedValue({ itemId: '11_purple_heart', quantity: 2 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // Simula que outra requisição já gastou o saldo
      },
      playerBuff: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      farmSlot: {
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation(async (cb) => cb(mockPrisma)),
    } as any;

    const farmService = new FarmService(mockPrisma);

    await expect(
      farmService.plant('test-user', { itemId: '11_purple_heart', amount: 2 })
    ).rejects.toThrow('Quantidade insuficiente de Coração Púrpuro no inventário. Operação cancelada devido a concorrência.');

    expect(mockPrisma.inventory.updateMany).toHaveBeenCalledWith({
      where: {
        playerId: 'test-user',
        itemId: '11_purple_heart',
        quantity: { gte: 2 },
      },
      data: {
        quantity: { decrement: 2 },
      },
    });
    // Garante que os slots não foram alterados
    expect(mockPrisma.farmSlot.update).not.toHaveBeenCalled();
  });

  it('sell() should abort and throw DomainError if concurrent operation depleted crops', async () => {
    const mockPrisma = {
      player: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'test-user',
          coins: 100,
          slots: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      playerBuff: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      inventory: {
        findMany: vi.fn().mockResolvedValue([
          { itemId: 'crop_10_golden_clover', quantity: 10 },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // Simula race condition
      },
      $transaction: vi.fn().mockImplementation(async (cb) => cb(mockPrisma)),
    } as any;

    const farmService = new FarmService(mockPrisma);

    await expect(
      farmService.sell('test-user', { itemId: 'crop_10_golden_clover', quantity: 10 })
    ).rejects.toThrow('Operação cancelada devido a concorrência.');

    expect(mockPrisma.inventory.updateMany).toHaveBeenCalledWith({
      where: {
        playerId: 'test-user',
        itemId: 'crop_10_golden_clover',
        quantity: { gte: 10 },
      },
      data: {
        quantity: { decrement: 10 },
      },
    });
  });

  it('useConsumable() should abort and throw DomainError if concurrent operation depleted consumable', async () => {
    const mockPrisma = {
      player: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'test-user',
          coins: 100,
          slots: [
            {
              id: 1,
              slotIndex: 1,
              plantId: '11_purple_heart',
              stage: 'seed',
              harvestAt: new Date(Date.now() + 600000),
            },
          ],
        }),
      },
      inventory: {
        findUnique: vi.fn().mockResolvedValue({ itemId: 'blood_ruby', quantity: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // Simula race condition
      },
      farmSlot: {
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation(async (cb) => cb(mockPrisma)),
    } as any;

    const farmService = new FarmService(mockPrisma);

    await expect(
      farmService.useConsumable('test-user', 'blood_ruby')
    ).rejects.toThrow('Operação cancelada devido a concorrência.');

    expect(mockPrisma.inventory.updateMany).toHaveBeenCalledWith({
      where: {
        playerId: 'test-user',
        itemId: 'blood_ruby',
        quantity: { gte: 1 },
      },
      data: {
        quantity: { decrement: 1 },
      },
    });
    expect(mockPrisma.farmSlot.update).not.toHaveBeenCalled();
  });
});
