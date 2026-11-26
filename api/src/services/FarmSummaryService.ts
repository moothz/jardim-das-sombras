import { PrismaClient } from '@prisma/client';
import { PLANTS, DECORATIONS, CONSUMABLES, findPlant } from '../utils/catalog.js';
import { FarmService } from './FarmService.js';
import { setAttrs } from '../telemetry.js';

export type SummaryPeriodKey = 'today' | 'd7' | 'd15' | 'd30' | 'total';

export interface RankedItemStat {
  itemId: string;
  name: string;
  quantity: number;
}

export interface PeriodSummary {
  planted: number;
  harvested: number;
  withered: number;
  seedsBought: number;
  itemsBought: number;
  itemsSold: number;
  consumablesUsed: number;
  dailyBagsOpened: number;
  coins: {
    earned: number;
    spent: number;
    net: number;
    fromHarvest: number;
    fromSales: number;
    fromDailyBag: number;
    fromClassifiedsIn: number;
    fromAdmin: number;
    spentShop: number;
    spentClassifiedsOut: number;
  };
  classifieds: {
    coinsReceived: number;
    coinsSent: number;
    itemsReceived: number;
    itemsSent: number;
    topSentItems: RankedItemStat[];
    topReceivedItems: RankedItemStat[];
  };
  topPlanted: RankedItemStat[];
  topHarvested: RankedItemStat[];
  topBought: RankedItemStat[];
}

export interface PlayerFarmSummary {
  generatedAt: string;
  coins: number;
  createdAt: string;
  inventorySummary: {
    totalItems: number;
    seedsCount: number;
    seedsDistinct: number;
    cropsCount: number;
    cropsDistinct: number;
    consumablesCount: number;
    decorationsCount: number;
    equippedDecorationsCount: number;
    estimatedCropsSellValue: number;
  };
  slotsSummary: {
    empty: number;
    growing: number;
    ready: number;
    withered: number;
  };
  buffs: {
    effectiveCoinMultiplier: number;
    effectiveGrowthMultiplier: number;
    witherFrozen: boolean;
    dailySpecialItemBonus: number;
    dailyLuckMultiplier: number;
    activeCount: number;
  };
  periods: Record<SummaryPeriodKey, PeriodSummary>;
}

/**
 * Início do ciclo diário atual do Jardim (03:00 BRT = 06:00 UTC).
 */
export function getDailyCycleStart(now: Date = new Date()): Date {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0, 0));
  if (now.getTime() < reset.getTime()) {
    reset.setUTCDate(reset.getUTCDate() - 1);
  }
  return reset;
}

export function resolveItemDisplayName(itemId: string | null): string {
  if (!itemId) return 'Item desconhecido';
  const isCrop = itemId.startsWith('crop_');
  const baseId = isCrop ? itemId.slice(5) : itemId;
  const plant = PLANTS[baseId];
  if (plant) {
    return isCrop ? `${plant.name} (Colhida)` : plant.name;
  }
  const consumable = CONSUMABLES[baseId];
  if (consumable) return consumable.name;
  const decor = DECORATIONS[baseId];
  if (decor) return decor.name;
  return itemId;
}

function isSeedItemId(itemId: string | null): boolean {
  if (!itemId || itemId.startsWith('crop_')) return false;
  return Boolean(PLANTS[itemId]);
}

function topNFromMap(map: Map<string, number>, limit = 5): RankedItemStat[] {
  return Array.from(map.entries())
    .filter(([, qty]) => qty > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([itemId, quantity]) => ({
      itemId,
      name: resolveItemDisplayName(itemId),
      quantity,
    }));
}

interface RawEventRow {
  type: string;
  itemId: string | null;
  quantity: number;
  coinsDelta: number;
  createdAt: Date;
}

interface RawDailyPurchaseRow {
  itemId: string;
  quantity: number;
  date: Date;
}

function buildPeriodSummary(
  events: RawEventRow[],
  legacyPurchases: RawDailyPurchaseRow[],
  cutoff: Date | null
): PeriodSummary {
  const filteredEvents = cutoff ? events.filter((e) => e.createdAt >= cutoff) : events;

  let planted = 0;
  let harvested = 0;
  let withered = 0;
  let seedsBought = 0;
  let itemsBought = 0;
  let itemsSold = 0;
  let consumablesUsed = 0;
  let dailyBagsOpened = 0;

  let earned = 0;
  let spent = 0;
  let fromHarvest = 0;
  let fromSales = 0;
  let fromDailyBag = 0;
  let fromClassifiedsIn = 0;
  let fromAdmin = 0;
  let spentShop = 0;
  let spentClassifiedsOut = 0;

  let classifiedsItemsReceived = 0;
  let classifiedsItemsSent = 0;

  const plantedMap = new Map<string, number>();
  const harvestedMap = new Map<string, number>();
  const boughtMap = new Map<string, number>();
  const sentItemsMap = new Map<string, number>();
  const receivedItemsMap = new Map<string, number>();

  for (const ev of filteredEvents) {
    if (ev.coinsDelta > 0) earned += ev.coinsDelta;
    else if (ev.coinsDelta < 0) spent += Math.abs(ev.coinsDelta);

    switch (ev.type) {
      case 'plant':
        planted += ev.quantity;
        if (ev.itemId) plantedMap.set(ev.itemId, (plantedMap.get(ev.itemId) ?? 0) + ev.quantity);
        break;
      case 'harvest':
        harvested += ev.quantity;
        fromHarvest += ev.coinsDelta;
        if (ev.itemId) harvestedMap.set(ev.itemId, (harvestedMap.get(ev.itemId) ?? 0) + ev.quantity);
        break;
      case 'wither':
        withered += ev.quantity;
        break;
      case 'buy':
        itemsBought += ev.quantity;
        if (isSeedItemId(ev.itemId)) seedsBought += ev.quantity;
        spentShop += Math.abs(ev.coinsDelta);
        if (ev.itemId) boughtMap.set(ev.itemId, (boughtMap.get(ev.itemId) ?? 0) + ev.quantity);
        break;
      case 'sell':
        itemsSold += ev.quantity;
        fromSales += ev.coinsDelta;
        break;
      case 'daily':
        dailyBagsOpened += ev.quantity;
        fromDailyBag += ev.coinsDelta;
        break;
      case 'use_consumable':
        consumablesUsed += ev.quantity;
        break;
      case 'transfer_in':
        fromClassifiedsIn += ev.coinsDelta;
        if (ev.itemId && ev.quantity > 0) {
          classifiedsItemsReceived += ev.quantity;
          receivedItemsMap.set(ev.itemId, (receivedItemsMap.get(ev.itemId) ?? 0) + ev.quantity);
        }
        break;
      case 'transfer_out':
        spentClassifiedsOut += Math.abs(ev.coinsDelta);
        if (ev.itemId && ev.quantity > 0) {
          classifiedsItemsSent += ev.quantity;
          sentItemsMap.set(ev.itemId, (sentItemsMap.get(ev.itemId) ?? 0) + ev.quantity);
        }
        break;
      case 'admin_give':
      case 'give_all':
        if (ev.coinsDelta > 0) fromAdmin += ev.coinsDelta;
        break;
    }
  }

  // Complementa compras históricas anteriores ao início do registro em farm_events
  const cutoffDateOnly = cutoff ? new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate())) : null;
  for (const p of legacyPurchases) {
    if (cutoffDateOnly && p.date < cutoffDateOnly) continue;
    itemsBought += p.quantity;
    if (isSeedItemId(p.itemId)) seedsBought += p.quantity;
    boughtMap.set(p.itemId, (boughtMap.get(p.itemId) ?? 0) + p.quantity);
  }

  return {
    planted,
    harvested,
    withered,
    seedsBought,
    itemsBought,
    itemsSold,
    consumablesUsed,
    dailyBagsOpened,
    coins: {
      earned,
      spent,
      net: earned - spent,
      fromHarvest,
      fromSales,
      fromDailyBag,
      fromClassifiedsIn,
      fromAdmin,
      spentShop,
      spentClassifiedsOut,
    },
    classifieds: {
      coinsReceived: fromClassifiedsIn,
      coinsSent: spentClassifiedsOut,
      itemsReceived: classifiedsItemsReceived,
      itemsSent: classifiedsItemsSent,
      topSentItems: topNFromMap(sentItemsMap),
      topReceivedItems: topNFromMap(receivedItemsMap),
    },
    topPlanted: topNFromMap(plantedMap),
    topHarvested: topNFromMap(harvestedMap),
    topBought: topNFromMap(boughtMap),
  };
}

export class FarmSummaryService {
  private farmService: FarmService;

  constructor(private prisma: PrismaClient) {
    this.farmService = new FarmService(prisma);
  }

  public async getPlayerSummary(playerId: string, now: Date = new Date()): Promise<PlayerFarmSummary> {
    const status = await this.farmService.getFarmStatus(playerId);

    const [player, events, dailyPurchases, cropHarvestTotals] = await Promise.all([
      this.prisma.player.findUniqueOrThrow({
        where: { id: playerId },
        select: {
          coins: true,
          createdAt: true,
          totalPlanted: true,
          totalHarvested: true,
          totalWithered: true,
        },
      }),
      this.prisma.farmEvent.findMany({
        where: { playerId },
        select: {
          type: true,
          itemId: true,
          quantity: true,
          coinsDelta: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.dailyPurchase.findMany({
        where: { playerId, quantity: { gt: 0 } },
        select: { itemId: true, quantity: true, date: true },
      }),
      this.prisma.cropHarvestTotal.findMany({
        where: { playerId, totalHarvested: { gt: 0 } },
        select: { itemId: true, totalHarvested: true },
        orderBy: { totalHarvested: 'desc' },
      }),
    ]);

    // Evita dupla contagem de compras com DailyPurchase quando já existem eventos `buy` naquela data
    const buyEventDates = new Set<string>();
    for (const ev of events) {
      if (ev.type === 'buy') {
        buyEventDates.add(ev.createdAt.toISOString().slice(0, 10));
      }
    }
    const legacyPurchases = dailyPurchases.filter(
      (p) => !buyEventDates.has(p.date.toISOString().slice(0, 10))
    );

    const todayStart = getDailyCycleStart(now);
    const d7Start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d15Start = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
    const d30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const periods: Record<SummaryPeriodKey, PeriodSummary> = {
      today: buildPeriodSummary(events, legacyPurchases, todayStart),
      d7: buildPeriodSummary(events, legacyPurchases, d7Start),
      d15: buildPeriodSummary(events, legacyPurchases, d15Start),
      d30: buildPeriodSummary(events, legacyPurchases, d30Start),
      total: buildPeriodSummary(events, legacyPurchases, null),
    };

    // Garante que o acumulado histórico anterior ao FarmEvent apareça nos Totais
    periods.total.planted = Math.max(periods.total.planted, player.totalPlanted);
    periods.total.harvested = Math.max(periods.total.harvested, player.totalHarvested);
    periods.total.withered = Math.max(periods.total.withered, player.totalWithered);

    if (cropHarvestTotals.length > 0) {
      const mergedHarvestMap = new Map<string, number>();
      for (const c of cropHarvestTotals) {
        mergedHarvestMap.set(c.itemId, c.totalHarvested);
      }
      for (const h of periods.total.topHarvested) {
        const existing = mergedHarvestMap.get(h.itemId) ?? 0;
        if (h.quantity > existing) mergedHarvestMap.set(h.itemId, h.quantity);
      }
      periods.total.topHarvested = topNFromMap(mergedHarvestMap);
    }

    // Resumo do inventário atual
    let totalItems = 0;
    let seedsCount = 0;
    let seedsDistinct = 0;
    let cropsCount = 0;
    let cropsDistinct = 0;
    let consumablesCount = 0;
    let decorationsCount = 0;
    let estimatedCropsSellValue = 0;

    for (const inv of status.inventory || []) {
      if (inv.quantity <= 0) continue;
      totalItems += inv.quantity;
      if (inv.itemId.startsWith('crop_')) {
        cropsCount += inv.quantity;
        cropsDistinct += 1;
        const plant = findPlant(inv.itemId);
        if (plant) {
          estimatedCropsSellValue += Math.round(plant.sellPrice * status.buffs.effectiveCoinMultiplier) * inv.quantity;
        }
      } else if (PLANTS[inv.itemId]) {
        seedsCount += inv.quantity;
        seedsDistinct += 1;
      } else if (CONSUMABLES[inv.itemId]) {
        consumablesCount += inv.quantity;
      } else if (DECORATIONS[inv.itemId]) {
        decorationsCount += inv.quantity;
      }
    }

    const slotsSummary = { empty: 0, growing: 0, ready: 0, withered: 0 };
    for (const s of status.slots || []) {
      if (s.stage === 'ready') slotsSummary.ready += 1;
      else if (s.stage === 'withered') slotsSummary.withered += 1;
      else if (s.stage === 'seed' || s.stage === 'growing') slotsSummary.growing += 1;
      else slotsSummary.empty += 1;
    }

    setAttrs({
      'jds.summary.events': events.length,
      'jds.summary.total_planted': periods.total.planted,
      'jds.summary.total_harvested': periods.total.harvested,
    });

    return {
      generatedAt: now.toISOString(),
      coins: player.coins,
      createdAt: player.createdAt.toISOString(),
      inventorySummary: {
        totalItems,
        seedsCount,
        seedsDistinct,
        cropsCount,
        cropsDistinct,
        consumablesCount,
        decorationsCount,
        equippedDecorationsCount: status.decorations?.length ?? 0,
        estimatedCropsSellValue,
      },
      slotsSummary,
      buffs: {
        effectiveCoinMultiplier: status.buffs.effectiveCoinMultiplier,
        effectiveGrowthMultiplier: status.buffs.effectiveGrowthMultiplier,
        witherFrozen: status.buffs.witherFrozen,
        dailySpecialItemBonus: status.buffs.dailySpecialItemBonus,
        dailyLuckMultiplier: status.buffs.dailyLuckMultiplier,
        activeCount: status.buffs.activeBuffs?.length ?? 0,
      },
      periods,
    };
  }
}
