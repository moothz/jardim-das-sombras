import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { renderAdminFarmHtml } from '../src/routes/views/adminFarmView.js';

const A = '01_nightshade';
const B = '02_tomb_shroom';
const PRESS = { detail: 1, clientX: 200, clientY: 300 };

type Reply = { ok: boolean; json: () => Promise<unknown> };
type Sent = { route: string; body: Record<string, unknown>; resolve: (data: unknown, ok?: boolean) => void; reject: (err: Error) => void };

function fakeElement(): Record<string, any> {
  const handlers: Record<string, (event: unknown) => void> = {};
  return {
    innerHTML: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn; },
    fire: (type: string, event: unknown) => handlers[type]?.(event),
    appendChild() {},
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, height: 0 }),
  };
}

function openPage(inventory: Array<{ itemId: string; quantity: number }>) {
  const sent: Sent[] = [];
  const elements = new Map<string, Record<string, any>>();
  const byId = (id: string) => elements.get(id) ?? elements.set(id, fakeElement()).get(id)!;
  const html = renderAdminFarmHtml({
    status: {
      playerId: '5511999990001',
      uuid: '00000000-0000-4000-8000-000000000001',
      coins: 1000,
      slots: Array.from({ length: 9 }, (_, i) => ({ slotIndex: i + 1, plantId: null, stage: 'empty' })),
      decorations: [],
      inventory,
    },
    token: 'token-ficticio',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    publicUrl: 'http://localhost:3040',
    timeCycle: 'day',
    shopCatalog: { seeds: [], consumables: [], decorations: [] },
    slotCoordinates: {},
  });
  const window = { location: { href: 'http://localhost:3040/farm' }, addEventListener() {}, innerWidth: 1280 };
  const page = vm.createContext({
    window,
    document: {
      getElementById: byId,
      createElement: fakeElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance,
    console,
    URL,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
    setInterval() {},
    fetch: (url: string, init: { body: string }) =>
      new Promise<Reply>((resolve, reject) => {
        sent.push({
          route: url.split('/').pop()!,
          body: JSON.parse(init.body),
          resolve: (data, ok = true) => resolve({ ok, json: async () => data }),
          reject,
        });
      }),
  });
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script, page);

  const press = async (list: string, label: string, event: Record<string, unknown> = PRESS, nth = 0) => {
    const buttons = [...byId(list).innerHTML.matchAll(/<button((?:"[^"]*"|[^">])*)>([^<]*)<\/button>/g)].filter(([, , text]) => text.startsWith(label));
    const handler = buttons[nth]?.[1].match(/onclick="([^"]*)"/)?.[1];
    if (!handler) throw new Error(`botão "${label}" ausente em ${list}`);
    vm.runInContext(`(function (event) { ${handler} })`, page)(event);
    await settle();
  };
  return {
    sent,
    sell: (label: string, event?: Record<string, unknown>, nth?: number) => press('sell-items-list', label, event, nth),
    plant: (label: string, event?: Record<string, unknown>, nth?: number) => press('inventory-seeds-list', label, event, nth),
    sellAll: async (event: Record<string, unknown> = PRESS) => { byId('btn-sell-all').fire('click', event); await settle(); },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const sold = (coins: number) => ({ newCoinsBalance: 1000 + coins, totalCoinsEarned: coins });
const planted = (slots: number[]) => ({ slots, harvestAt: new Date(Date.now() + 60_000).toISOString() });
const elsewhere = { detail: 1, clientX: 700, clientY: 600 };

describe('cliques rápidos em Plantar e Vender na fazenda web', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('Vender 1: o segundo clique não vira outra venda, mesmo com a API respondendo entre os dois', async () => {
    const page = openPage([{ itemId: `crop_${A}`, quantity: 5 }]);
    await page.sell('Vender 1');
    page.sent[0].resolve(sold(10));
    await vi.advanceTimersByTimeAsync(120);
    await page.sell('Vender 1');
    expect(page.sent.map((s) => s.body)).toEqual([{ itemId: `crop_${A}`, quantity: 1 }]);
  });

  it('Plantar 1x: o segundo clique não planta outra semente', async () => {
    const page = openPage([{ itemId: A, quantity: 5 }]);
    await page.plant('1x');
    page.sent[0].resolve(planted([1]));
    await vi.advanceTimersByTimeAsync(120);
    await page.plant('1x');
    expect(page.sent.map((s) => s.body)).toEqual([{ itemId: A, amount: 1 }]);
  });

  it('Vender Todas: o segundo clique não gera outro pedido', async () => {
    const page = openPage([{ itemId: `crop_${A}`, quantity: 5 }]);
    await page.sellAll();
    page.sent[0].resolve(sold(50));
    await vi.advanceTimersByTimeAsync(120);
    await page.sellAll();
    expect(page.sent.map((s) => s.body)).toEqual([{ all: true }]);
  });

  it('Vender Tudo: o segundo clique no mesmo ponto não vende a colheita que subiu para o lugar da primeira', async () => {
    const page = openPage([{ itemId: `crop_${A}`, quantity: 3 }, { itemId: `crop_${B}`, quantity: 4 }]);
    await page.sell('Vender Tudo');
    page.sent[0].resolve(sold(30));
    await vi.advanceTimersByTimeAsync(250);
    await page.sell('Vender Tudo');
    expect(page.sent.map((s) => s.body)).toEqual([{ itemId: `crop_${A}`, quantity: 3 }]);
  });

  it.each([
    ['sucesso', (s: Sent) => s.resolve(sold(10))],
    ['recusa da API', (s: Sent) => s.resolve({ message: 'Você não possui colheitas' }, false)],
    ['falha de rede', (s: Sent) => s.reject(new TypeError('Failed to fetch'))],
  ])('Vender 1 volta a funcionar depois de %s', async (_caso, finish) => {
    const page = openPage([{ itemId: `crop_${A}`, quantity: 5 }]);
    await page.sell('Vender 1');
    finish(page.sent[0]);
    await vi.advanceTimersByTimeAsync(1000);
    await page.sell('Vender 1');
    expect(page.sent).toHaveLength(2);
  });

  it.each([
    ['sucesso', (s: Sent) => s.resolve(planted([1]))],
    ['recusa da API', (s: Sent) => s.resolve({ message: 'Você não possui sementes' }, false)],
    ['falha de rede', (s: Sent) => s.reject(new TypeError('Failed to fetch'))],
  ])('Plantar 1x volta a funcionar depois de %s', async (_caso, finish) => {
    const page = openPage([{ itemId: A, quantity: 5 }]);
    await page.plant('1x');
    finish(page.sent[0]);
    await vi.advanceTimersByTimeAsync(1000);
    await page.plant('1x');
    expect(page.sent).toHaveLength(2);
  });

  it('clique em outra colheita durante uma venda lenta não se perde e sai depois da primeira', async () => {
    const page = openPage([{ itemId: `crop_${A}`, quantity: 3 }, { itemId: `crop_${B}`, quantity: 4 }]);
    await page.sell('Vender 1');
    await page.sell('Vender 1', elsewhere, 1);
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`]);
    page.sent[0].resolve(sold(10));
    await settle();
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`]);
  });

  it('plantio de outra semente espera o primeiro e não disputa os mesmos canteiros', async () => {
    const page = openPage([{ itemId: A, quantity: 9 }, { itemId: B, quantity: 9 }]);
    await page.plant('9x');
    await page.plant('9x', elsewhere, 1);
    expect(page.sent.map((s) => s.body)).toEqual([{ itemId: A, amount: 9 }]);
    page.sent[0].resolve(planted([1, 2, 3, 4, 5, 6]));
    await settle();
    expect(page.sent[1].body).toEqual({ itemId: B, amount: 3 });
  });

  it('venda lenta não segura o plantio', async () => {
    const page = openPage([{ itemId: A, quantity: 3 }, { itemId: `crop_${B}`, quantity: 4 }]);
    await page.sell('Vender 1');
    await page.plant('1x', elsewhere);
    expect(page.sent.map((s) => s.route)).toEqual(['sell', 'plant']);
  });
});
