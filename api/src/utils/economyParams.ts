import { performance } from 'node:perf_hooks';
import { PLANTS, DECORATIONS, CONSUMABLES } from './catalog.js';
import {
  dailyBag,
  DAILY_BAG_GUARANTEED_SEEDS,
  DAILY_BAG_BONUS_CHANCE_PERCENT,
  DAILY_BAG_LUCK_WEIGHT,
  VOID_NECTAR_GROWTH_FACTOR,
  LIQUID_ASHES_BAG_BONUS,
  WIDOWS_FILTER_BAG_LUCK_MULTIPLIER,
  MIDAS_TEAR_COIN_BONUS,
  FARM_COIN_MULTIPLIER_CAP,
  FARM_GROWTH_REDUCTION_CAP,
  FARM_GROWTH_MULTIPLIER_FLOOR,
} from './economy.js';

/**
 * Parâmetros de balanceamento das Petalitas para o painel da ravena-ai (GET /internal/economy/params).
 * O painel lê a rota de hora em hora e anota sozinho uma "mudança de balanceamento" quando algum valor muda.
 *
 * Chave: `<grupo>.<NOME>.<chave>[.<campo>]` (objetos viram NOME.CHAVE, arrays NOME.0). O catálogo e a sacola
 * diária vêm de data/*.json e são relidos no reload do super admin: a rota lê os objetos vivos, então sempre
 * mostra o valor efetivo. `null` vira a string `"none"`. Só os campos que mexem na economia entram; nome,
 * descrição e sprite ficam de fora. Nada de segredo, URL ou dado de jogador.
 *
 * Constante ou campo novo precisa entrar aqui ou na lista de ignoradas de tests/economyParams.test.ts
 * (o teste de guarda falha caso contrário).
 */

export const ECONOMY_PARAMS_SCHEMA_VERSION = 1;

export type EconomyParamValue = number | string | boolean;

type Source = number | string | boolean | null | undefined | readonly Source[] | { readonly [key: string]: Source };

/** Campos de cada item do catálogo que entram na rota. */
export const PLANT_PARAM_FIELDS = [
  'category',
  'seedPrice',
  'sellPrice',
  'growthTimeSeconds',
  'witherTimeSeconds',
  'coinReward',
  'bonusType',
  'dailyLimit',
  'weeklyPlantLimit',
  'dailyBagTier',
] as const;
export const DECORATION_PARAM_FIELDS = ['tier', 'price', 'sellPrice'] as const;
export const CONSUMABLE_PARAM_FIELDS = ['effect', 'price', 'dailyLimit'] as const;

/** Momento (ms) em que o processo subiu. */
export const PROCESS_STARTED_AT = Math.round(performance.timeOrigin);

function pick<T extends object>(items: Record<string, T>, fields: readonly string[]): Record<string, Source> {
  const out: Record<string, Source> = {};
  for (const [key, item] of Object.entries(items)) {
    const row: Record<string, Source> = {};
    for (const f of fields) row[f] = (item as Record<string, Source>)[f];
    out[key] = row;
  }
  return out;
}

function groups(): Record<string, Record<string, Source>> {
  return {
    catalog: {
      PLANTS: pick(PLANTS, PLANT_PARAM_FIELDS),
      DECORATIONS: pick(DECORATIONS, DECORATION_PARAM_FIELDS),
      CONSUMABLES: pick(CONSUMABLES, CONSUMABLE_PARAM_FIELDS),
    },
    daily: {
      // Sacola diária efetiva (data/economy.json sobre o padrão de utils/economy.ts).
      DAILY_BAG: { ...dailyBag },
      DAILY_BAG_GUARANTEED_SEEDS,
      DAILY_BAG_BONUS_CHANCE_PERCENT,
      DAILY_BAG_LUCK_WEIGHT,
      LIQUID_ASHES_BAG_BONUS,
      WIDOWS_FILTER_BAG_LUCK_MULTIPLIER,
    },
    farm: {
      VOID_NECTAR_GROWTH_FACTOR,
      MIDAS_TEAR_COIN_BONUS,
      FARM_COIN_MULTIPLIER_CAP,
      FARM_GROWTH_REDUCTION_CAP,
      FARM_GROWTH_MULTIPLIER_FLOOR,
    },
  };
}

function flatten(prefix: string, value: Source, out: Record<string, EconomyParamValue>): void {
  if (value === undefined) return; // campo ausente no JSON
  if (value === null) {
    out[prefix] = 'none';
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(`${prefix}.${i}`, v, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as { readonly [key: string]: Source })) flatten(`${prefix}.${k}`, v, out);
  } else {
    out[prefix] = value as EconomyParamValue;
  }
}

/** Mapa plano e ordenado por chave com todos os parâmetros de balanceamento. */
export function buildEconomyParams(): Record<string, EconomyParamValue> {
  const flat: Record<string, EconomyParamValue> = {};
  for (const [group, entries] of Object.entries(groups())) {
    for (const [name, value] of Object.entries(entries)) flatten(`${group}.${name}`, value, flat);
  }
  const sorted: Record<string, EconomyParamValue> = {};
  for (const key of Object.keys(flat).sort()) sorted[key] = flat[key];
  return sorted;
}

export interface EconomyParamsResponse {
  currency: 'petalitas';
  schemaVersion: number;
  generatedAt: number;
  startedAt: number;
  version: string | null;
  params: Record<string, EconomyParamValue>;
}

export function getEconomyParams(now: number = Date.now()): EconomyParamsResponse {
  return {
    currency: 'petalitas',
    schemaVersion: ECONOMY_PARAMS_SCHEMA_VERSION,
    generatedAt: now,
    startedAt: PROCESS_STARTED_AT,
    version: process.env.GIT_SHA || process.env.APP_VERSION || null,
    params: buildEconomyParams(),
  };
}
