import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { renderAdminFarmHtml } from '../src/routes/views/adminFarmView.js';

const A = '01_nightshade';
const B = '02_tomb_shroom';
const C = '03_corpse_lily';
const D = '04_black_lotus';

type Tab = 'sell' | 'plant';
type Point = { x: number; y: number };
type Handler = (event: Record<string, unknown>) => void;
type Reply = { ok: boolean; json: () => Promise<unknown> };
type Sent = { route: string; body: Record<string, unknown>; resolve: (data: unknown, ok?: boolean) => void; reject: (err: Error) => void };

const LISTS: Record<string, Tab> = { 'sell-items-list': 'sell', 'inventory-seeds-list': 'plant' };

function browser() {
  const handlers: Array<{ type: string; target: unknown; fn: Handler }> = [];
  const body = { tagName: 'BODY', closest: () => null };
  let tab: Tab = 'sell';
  let active: unknown = body;

  class Button {
    tagName = 'BUTTON';
    readonly attributes: Record<string, string>;
    private off: boolean;
    constructor(readonly tab: Tab, readonly text: string, markup: string, readonly box: { left: number; top: number }) {
      this.attributes = Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
      this.off = /\sdisabled(\s|$)/.test(markup);
    }
    get dataset() {
      const data = Object.entries(this.attributes).filter(([name]) => name.startsWith('data-'));
      return Object.fromEntries(data.map(([name, value]) => [name.slice(5).replace(/-(\w)/g, (_m, c) => c.toUpperCase()), value]));
    }
    get disabled() { return this.off; }
    set disabled(value: boolean) {
      this.off = Boolean(value);
      if (this.off && active === this) active = body;
    }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    getBoundingClientRect() {
      if (this.tab !== tab) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
      return { ...this.box, x: this.box.left, y: this.box.top, right: this.box.left + 100, bottom: this.box.top + 40, width: 100, height: 40 };
    }
    matches(selector: string) {
      return selector.split(',').some((part) => {
        const [, tagName, id, conditions] = part.trim().match(/^(button)?(?:#([\w-]+))?((?:\[[^\]]+\])*)$/) ?? [];
        if (!tagName && !id && !conditions) return false;
        const attributes = [...conditions.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
        return (!id || id === this.attributes.id) && attributes.every(([, name, value]) => (value === undefined ? name in this.attributes : this.attributes[name] === value));
      });
    }
    closest(selector: string) { return this.matches(selector) ? this : null; }
    addEventListener(type: string, fn: Handler) { handlers.push({ type, target: this, fn }); }
    focus() {
      if (this.off || active === this || this.tab !== tab || !buttons().includes(this)) return;
      active = this;
      emit('focusin', this);
    }
  }

  const lists: Record<string, Button[]> = { 'sell-items-list': [], 'inventory-seeds-list': [] };
  const sellAll = { current: undefined as Button | undefined };
  const buttons = () => [...(sellAll.current ? [sellAll.current] : []), ...Object.values(lists).flat()];

  function emit(type: string, target: unknown, fields: Record<string, unknown> = {}) {
    let prevented = false;
    const event = { type, target, currentTarget: target, timeStamp: performance.now(), preventDefault: () => { prevented = true; }, stopPropagation() {}, ...fields };
    for (const handler of handlers) if (handler.type === type && (handler.target === target || handler.target === document)) handler.fn(event);
    return { event, prevented };
  }

  function element(id?: string): Record<string, any> {
    let html = '';
    return {
      get innerHTML() { return html; },
      set innerHTML(value: string) {
        html = value;
        if (!id || !(id in LISTS)) return;
        lists[id] = value.split(/<div class="item-card[ "]/).slice(1).flatMap((card, row) =>
          [...card.matchAll(/<button((?:"[^"]*"|[^">])*)>([^<]*)<\/button>/g)].map(([, markup, text], column) =>
            new Button(LISTS[id], text.trim(), markup, { left: 100 + column * 130, top: 200 + row * 150 })));
        if (active !== body && !buttons().includes(active as Button)) active = body;
      },
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {},
      appendChild() {},
      querySelector: () => element(),
      querySelectorAll: () => [],
      closest: () => null,
      getBoundingClientRect: () => ({ top: 0, height: 0 }),
    };
  }

  const elements = new Map<string, Record<string, any>>();
  const byId = (id: string) => elements.get(id) ?? elements.set(id, element(id)).get(id)!;
  const document = {
    body,
    get activeElement() { return active; },
    getElementById: (id: string) => (id === sellAll.current?.attributes.id ? sellAll.current : byId(id)),
    createElement: () => element(),
    querySelector: (selector: string) => buttons().find((btn) => btn.matches(selector)) ?? null,
    querySelectorAll: (selector: string) => buttons().filter((btn) => btn.matches(selector)),
    elementFromPoint: (x: number, y: number) => at({ x, y }) ?? body,
    addEventListener(type: string, fn: Handler) { handlers.push({ type, target: document, fn }); },
  };

  const at = ({ x, y }: Point) => buttons().find((btn) => {
    const box = btn.getBoundingClientRect();
    return box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  });

  return {
    document,
    loadSellAll: (markup: string, text: string) => { sellAll.current = new Button('sell', text, markup, { left: 600, top: 100 }); },
    html: (id: string): string => byId(id).innerHTML,
    text: (id: string): string => byId(id).innerText,
    show: (next: Tab) => { tab = next; },
    find: (text: string, nth = 0) => {
      const found = buttons().filter((btn) => btn.tab === tab && btn.text.startsWith(text))[nth];
      if (!found) throw new Error(`botão "${text}" (${nth}) ausente`);
      return found;
    },
    at,
    focused: () => (active === body ? null : (active as Button)),
    blur: () => { active = body; },
    emit,
  };
}

function openPage(inventory: Array<{ itemId: string; quantity: number }>, readySlots = 0) {
  const sent: Sent[] = [];
  const dom = browser();
  const html = renderAdminFarmHtml({
    status: {
      playerId: '5511999990001',
      uuid: '00000000-0000-4000-8000-000000000001',
      coins: 1000,
      slots: Array.from({ length: 9 }, (_, i) => (i < readySlots ? { slotIndex: i + 1, plantId: A, stage: 'ready' } : { slotIndex: i + 1, plantId: null, stage: 'empty' })),
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
  const [, markup, text] = html.match(/<button((?:"[^"]*"|[^">])*id="btn-sell-all"(?:"[^"]*"|[^">])*)>([^<]*)<\/button>/)!;
  dom.loadSellAll(markup, text);

  const page = vm.createContext({
    window: { location: { href: 'http://localhost:3040/farm' }, addEventListener() {}, innerWidth: 1280 },
    document: dom.document,
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
          route: url.match(/sell|plant|buy|harvest/)![0],
          body: JSON.parse(init.body),
          resolve: (data, ok = true) => resolve({ ok, json: async () => data }),
          reject,
        });
      }),
  });
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script, page);

  const activate = async (btn: NonNullable<ReturnType<typeof dom.at>>, fields: Record<string, unknown>) => {
    const { event } = dom.emit('click', btn, fields);
    if (btn.attributes.onclick) vm.runInContext(`(function (event) { ${btn.attributes.onclick} })`, page)(event);
    await settle();
  };
  const center = (label: string, nth?: number): Point => {
    const { left, top } = dom.find(label, nth).box;
    return { x: left + 50, y: top + 20 };
  };
  const clickAt = async (point: Point, deliveredLateBy = 0) => {
    const btn = dom.at(point);
    dom.emit('pointerdown', btn ?? dom.document.body);
    dom.blur();
    if (!btn || btn.disabled) return;
    btn.focus();
    await activate(btn, { detail: 1, clientX: point.x, clientY: point.y, timeStamp: performance.now() - deliveredLateBy });
  };
  return {
    sent,
    show: dom.show,
    html: dom.html,
    text: dom.text,
    center,
    clickAt,
    click: (label: string, nth?: number) => clickAt(center(label, nth)),
    isLit: (label: string, nth?: number) => !dom.find(label, nth).disabled,
    isLitAt: (point: Point) => dom.at(point)?.disabled === false,
    focus: (label: string, nth?: number) => dom.find(label, nth).focus(),
    focused: () => dom.focused()?.text ?? null,
    press: async (key: string, repeat = false) => {
      const btn = dom.focused();
      const { prevented } = dom.emit('keydown', btn ?? dom.document.body, { key, repeat });
      if (btn && !btn.disabled && !prevented) await activate(btn, { detail: 0, clientX: 0, clientY: 0 });
    },
    buySeed: async (itemId: string) => {
      vm.runInContext(`buyItem('${itemId}', 1, 'Semente', 1, 'seed')`, page);
      await settle();
      sent.find((s) => s.route === 'buy')!.resolve({ remainingCoins: 999 });
      await settle();
    },
    harvestAll: async () => {
      vm.runInContext('harvestAllFromCanvas()', page);
      await settle();
      sent.find((s) => s.route === 'harvest')!.resolve({ totalCoinsEarned: 0, harvested: [] });
      await wait(380);
    },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const sold = (coins: number) => ({ newCoinsBalance: 1000 + coins, totalCoinsEarned: coins });
const planted = (slots: number[]) => ({ slots, harvestAt: new Date(Date.now() + 60_000).toISOString() });
const crop = (id: string, quantity: number) => ({ itemId: `crop_${id}`, quantity });
const seed = (id: string, quantity: number) => ({ itemId: id, quantity });

describe('cliques rápidos em Plantar e Vender na fazenda web', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });

  describe.each([
    ['antes da resposta', 120, 900],
    ['com a resposta no meio', 120, 40],
    ['lento, com a resposta no meio', 450, 40],
  ])('duplo clique %s', (_caso, gap, reply) => {
    const double = async (page: ReturnType<typeof openPage>, label: string, data: unknown) => {
      const point = page.center(label);
      await page.clickAt(point);
      if (reply < gap) {
        await wait(reply);
        page.sent[0].resolve(data);
      }
      await wait(gap - Math.min(reply, gap));
      await page.clickAt({ x: point.x + 8, y: point.y + 4 });
      if (reply >= gap) page.sent[0].resolve(data);
      await wait(2000);
    };

    it('em Vender 1 vende uma vez', async () => {
      const page = openPage([crop(A, 5)]);
      await double(page, 'Vender 1', sold(10));
      expect(page.sent.map((s) => s.body)).toEqual([{ itemId: `crop_${A}`, quantity: 1 }]);
    });

    it('em Vender Tudo não vende a colheita que subiu para o lugar da primeira', async () => {
      const page = openPage([crop(A, 3), crop(B, 4)]);
      await double(page, 'Vender Tudo', sold(30));
      expect(page.sent.map((s) => s.body)).toEqual([{ itemId: `crop_${A}`, quantity: 3 }]);
    });

    it('em Vender Todas gera um pedido', async () => {
      const page = openPage([crop(A, 5)]);
      await double(page, '🌱 Vender Todas', sold(50));
      expect(page.sent.map((s) => s.body)).toEqual([{ all: true }]);
    });

    it.each([['1x', 1], ['3x', 3]])('em Plantar %s planta uma vez', async (label, amount) => {
      const page = openPage([seed(A, 9)]);
      page.show('plant');
      await double(page, label, planted([1, 2, 3].slice(0, amount)));
      expect(page.sent.map((s) => s.body)).toEqual([{ itemId: A, amount }]);
    });

    it('em plantar a última semente não planta a que subiu para o lugar dela', async () => {
      const page = openPage([seed(A, 1), seed(B, 4)]);
      page.show('plant');
      await double(page, '1x', planted([1]));
      expect(page.sent.map((s) => s.body)).toEqual([{ itemId: A, amount: 1 }]);
    });
  });

  it('o segundo clique de um duplo clique entregue com atraso pelo navegador não vende a colheita que subiu', async () => {
    const page = openPage([crop(A, 3), crop(B, 4)]);
    const point = page.center('Vender Tudo');
    await page.clickAt(point);
    page.sent[0].resolve(sold(30));
    await wait(700);
    await page.clickAt(point, 250);
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`]);
    await page.clickAt(point);
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`]);
  });

  describe('teclado', () => {
    it.each([
      ['Vender 1', 'sell', [crop(A, 5)], sold(10)],
      ['🌱 Vender Todas', 'sell', [crop(A, 5)], sold(50)],
      ['1x', 'plant', [seed(A, 5)], planted([1])],
    ] as const)('Enter repetido em %s gera um pedido', async (label, tab, inventory, data) => {
      const page = openPage([...inventory]);
      page.show(tab);
      page.focus(label);
      await page.press('Enter');
      await wait(40);
      page.sent[0].resolve(data);
      for (let i = 0; i < 4; i++) { await wait(100); await page.press('Enter'); }
      expect(page.sent).toHaveLength(1);
    });

    it('Enter segurado em Vender 1 vende uma vez', async () => {
      const page = openPage([crop(A, 20)]);
      page.focus('Vender 1');
      await page.press('Enter');
      page.sent[0].resolve(sold(10));
      for (let i = 0; i < 60; i++) { await wait(35); await page.press('Enter', true); }
      expect(page.sent).toHaveLength(1);
    });

    it.each([
      ['sucesso', (s: Sent) => s.resolve(sold(10))],
      ['recusa da API', (s: Sent) => s.resolve({ message: 'Você não possui colheitas' }, false)],
      ['falha de rede', (s: Sent) => s.reject(new TypeError('Failed to fetch'))],
    ])('depois de %s o foco volta ao botão e o Enter seguinte funciona', async (_caso, finish) => {
      const page = openPage([crop(A, 5), crop(B, 5)]);
      page.focus('Vender Tudo', 1);
      page.focus('Vender 1', 1);
      await page.press('Enter');
      finish(page.sent[0]);
      await wait(1000);
      expect(page.focused()).toBe('Vender 1');
      await page.press('Enter');
      expect(page.sent.map((s) => s.body)).toEqual([{ itemId: `crop_${B}`, quantity: 1 }, { itemId: `crop_${B}`, quantity: 1 }]);
    });

    it.each([
      ['Vender 1', 'sell', [crop(A, 5)], sold(10)],
      ['1x', 'plant', [seed(A, 5)], planted([1])],
    ] as const)('depois de clicar em %s, Espaço e Enter não repetem a ação', async (label, tab, inventory, data) => {
      const page = openPage([...inventory]);
      page.show(tab);
      await page.click(label);
      page.sent[0].resolve(data);
      await wait(1200);
      for (const key of [' ', ' ', 'Enter']) { await page.press(key); await wait(600); }
      expect(page.sent).toHaveLength(1);
    });

    it('depois do mouse, o teclado volta a guardar o foco', async () => {
      const page = openPage([crop(A, 5), crop(B, 5)]);
      await page.click('Vender 1');
      page.sent[0].resolve(sold(10));
      await wait(1200);
      await page.press('Tab');
      page.focus('Vender 1', 1);
      await page.press('Enter');
      page.sent[1].resolve(sold(10));
      await wait(1000);
      await page.press('Enter');
      expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`, `crop_${B}`]);
    });

    it.each(['Enter', ' ', 'Shift', 'ArrowDown'])('a tecla %s durante a trava não perde o foco', async (key) => {
      const page = openPage([crop(A, 5), crop(B, 5)]);
      page.focus('Vender 1', 1);
      await page.press('Enter');
      await wait(250);
      await page.press(key);
      page.sent[0].resolve(sold(10));
      await wait(1000);
      expect(page.focused()).toBe('Vender 1');
      await page.press('Enter');
      expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${B}`, `crop_${B}`]);
    });

    it.each(['Enter', ' '])('%s sobre o botão já focado pelo mouse, depois de uma recusa, é ação do teclado', async (key) => {
      const page = openPage([crop(A, 5)]);
      await page.click('Vender 1');
      page.sent[0].resolve({ message: 'Você não possui colheitas' }, false);
      await wait(1200);
      page.focus('Vender 1');
      await page.press(key);
      page.sent[1].resolve(sold(10));
      await wait(1200);
      expect(page.focused()).toBe('Vender 1');
    });

    it('plantar 3x devolve o foco ao 3x', async () => {
      const page = openPage([seed(A, 9)]);
      page.show('plant');
      page.focus('3x');
      await page.press('Enter');
      page.sent[0].resolve(planted([1, 2, 3]));
      await wait(1000);
      expect(page.focused()).toBe('3x');
    });

    it('o foco não volta se o jogador já clicou em outro lugar', async () => {
      const page = openPage([crop(A, 5)]);
      await page.click('Vender 1');
      await page.clickAt({ x: 5, y: 5 });
      page.sent[0].resolve(sold(10));
      await wait(1000);
      expect(page.focused()).toBeNull();
    });

    it('o foco que o jogador levou a outra colheita fica nela', async () => {
      const page = openPage([crop(A, 5), crop(B, 5)]);
      page.focus('Vender 1');
      await page.press('Enter');
      page.focus('Vender Tudo', 1);
      page.sent[0].resolve(sold(10));
      await wait(1000);
      await page.press('Enter');
      expect(page.sent[1].body).toEqual({ itemId: `crop_${B}`, quantity: 5 });
    });

    it('Enter em duas colheitas seguidas vende as duas', async () => {
      const page = openPage([crop(A, 5), crop(B, 5)]);
      page.focus('Vender 1');
      await page.press('Enter');
      page.sent[0].resolve(sold(10));
      await wait(80);
      page.focus('Vender 1', 1);
      await page.press('Enter');
      expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`]);
    });
  });

  describe.each([20, 120, 300, 600, 1500])('com rede de %i ms', (latency) => {
    const answer = (page: ReturnType<typeof openPage>, data: unknown) => setTimeout(() => page.sent[page.sent.length - 1].resolve(data), latency);

    it.each([500, 600, 800, 1000])('nenhum clique a cada %i ms se perde com o botão aceso', async (gap) => {
      const page = openPage([crop(A, 3), crop(B, 3), crop(C, 3), crop(D, 3)]);
      const point = page.center('Vender Tudo');
      const lost: number[] = [];
      for (let i = 0; i < 4; i++) {
        const lit = page.isLitAt(point);
        const before = page.sent.length;
        await page.clickAt(point);
        if (page.sent.length > before) answer(page, sold(30));
        else if (lit) lost.push(i);
        await wait(gap);
      }
      expect(lost).toEqual([]);
    });

    it('Vender 1 fica apagado durante a venda e reacende até 250 ms depois da resposta ou 500 ms depois do clique', async () => {
      const page = openPage([crop(A, 5), crop(B, 5)]);
      await page.click('Vender 1');
      answer(page, sold(10));
      expect([page.isLit('Vender 1'), page.isLit('Vender Tudo')]).toEqual([false, false]);
      expect([page.isLit('Vender 1', 1), page.isLit('Vender Tudo', 1), page.isLit('🌱 Vender Todas')]).toEqual([true, true, true]);
      await wait(latency - 1);
      expect(page.isLit('Vender 1')).toBe(false);
      await wait(Math.max(500 - latency, 250) + 50);
      expect([page.isLit('Vender 1'), page.isLit('Vender Tudo')]).toEqual([true, true]);
    });

    it('o reclique logo depois da resposta encontra apagada a colheita que subiu', async () => {
      const page = openPage([crop(A, 3), crop(B, 4)]);
      const point = page.center('Vender Tudo');
      await page.clickAt(point);
      answer(page, sold(30));
      await wait(latency + 60);
      expect(page.isLitAt(point)).toBe(false);
      await page.clickAt(point);
      expect(page.sent).toHaveLength(1);
      await wait(500);
      await page.clickAt(point);
      expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`]);
    });
  });

  it.each([
    ['Vender 1 e Vender Tudo', 'sell', 'Vender 1', 'Vender Tudo', [crop(A, 5)]],
    ['Vender Tudo e Vender 1', 'sell', 'Vender Tudo', 'Vender 1', [crop(A, 5)]],
    ['plantar 1x e 3x', 'plant', '1x', '3x', [seed(A, 9)]],
    ['plantar 3x e 9x', 'plant', '3x', '9x', [seed(A, 9)]],
  ] as const)('%s da mesma carta não correm juntos', async (_caso, tab, first, second, inventory) => {
    const page = openPage([...inventory]);
    page.show(tab);
    await page.click(first);
    await wait(2000);
    expect(page.isLit(second)).toBe(false);
    await page.click(second);
    expect(page.sent).toHaveLength(1);
  });

  it('Vender Todas em andamento apaga as vendas individuais e elas reacendem depois de uma falha', async () => {
    const page = openPage([crop(A, 5), crop(B, 5)]);
    await page.click('🌱 Vender Todas');
    await wait(2000);
    expect([page.isLit('🌱 Vender Todas'), page.isLit('Vender 1'), page.isLit('Vender Tudo', 1)]).toEqual([false, false, false]);
    await page.click('Vender 1', 1);
    expect(page.sent).toHaveLength(1);
    page.sent[0].reject(new TypeError('Failed to fetch'));
    await wait(1000);
    expect([page.isLit('🌱 Vender Todas'), page.isLit('Vender 1'), page.isLit('Vender Tudo', 1)]).toEqual([true, true, true]);
  });

  it('comprar sementes durante um plantio lento não reacende o botão da semente', async () => {
    const page = openPage([seed(A, 5)]);
    page.show('plant');
    await page.click('1x');
    await wait(1000);
    await page.buySeed(A);
    expect(page.html('inventory-seeds-list')).toContain('x6');
    expect(page.isLit('1x')).toBe(false);
  });

  it('colher durante uma venda lenta não reacende os botões da colheita em venda', async () => {
    const page = openPage([crop(A, 5), crop(B, 5)], 1);
    await page.click('Vender 1');
    await wait(1000);
    await page.harvestAll();
    expect([page.isLit('Vender 1'), page.isLit('Vender Tudo'), page.isLit('Vender 1', 1)]).toEqual([false, false, true]);
  });

  it('a colheita que sobe para o ponto de uma venda ainda pendente só fica apagada por um instante', async () => {
    const page = openPage([crop(A, 3), crop(B, 3), crop(C, 3)]);
    const second = page.center('Vender Tudo', 1);
    await page.click('Vender Tudo');
    await page.clickAt(second);
    await wait(1000);
    page.sent[0].resolve(sold(30));
    await wait(250);
    expect(page.isLitAt(second)).toBe(true);
    await page.clickAt(second);
    page.sent[1].resolve(sold(30));
    await settle();
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`, `crop_${C}`]);
  });

  it('o mesmo ponto em outra aba não conta como duplo clique', async () => {
    const page = openPage([crop(A, 5), seed(A, 5)]);
    const point = page.center('Vender 1');
    await page.clickAt(point);
    await wait(120);
    page.show('plant');
    page.sent[0].resolve(sold(10));
    await settle();
    expect([page.center('1x'), page.isLit('1x')]).toEqual([point, true]);
    await page.clickAt(point);
    expect(page.sent.map((s) => s.route)).toEqual(['sell', 'plant']);
  });

  it.each([
    ['sucesso', (s: Sent) => s.resolve(sold(10))],
    ['recusa da API', (s: Sent) => s.resolve({ message: 'Você não possui colheitas' }, false)],
    ['falha de rede', (s: Sent) => s.reject(new TypeError('Failed to fetch'))],
  ])('Vender 1 volta a funcionar depois de %s', async (_caso, finish) => {
    const page = openPage([crop(A, 5)]);
    await page.click('Vender 1');
    finish(page.sent[0]);
    await wait(1000);
    await page.click('Vender 1');
    expect(page.sent).toHaveLength(2);
  });

  it.each([
    ['sucesso', (s: Sent) => s.resolve(planted([1]))],
    ['recusa da API', (s: Sent) => s.resolve({ message: 'Você não possui sementes' }, false)],
    ['falha de rede', (s: Sent) => s.reject(new TypeError('Failed to fetch'))],
  ])('Plantar 1x volta a funcionar depois de %s', async (_caso, finish) => {
    const page = openPage([seed(A, 5)]);
    page.show('plant');
    await page.click('1x');
    finish(page.sent[0]);
    await wait(1000);
    await page.click('1x');
    expect(page.sent).toHaveLength(2);
  });

  it('clique em outra colheita durante uma venda lenta não se perde e sai depois da primeira', async () => {
    const page = openPage([crop(A, 3), crop(B, 4)]);
    await page.click('Vender 1');
    await wait(80);
    await page.click('Vender 1', 1);
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`]);
    page.sent[0].resolve(sold(10));
    await settle();
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`]);
  });

  it('clique na colheita vizinha logo depois da resposta da primeira vende a vizinha', async () => {
    const page = openPage([crop(A, 3), crop(B, 4)]);
    await page.click('Vender 1');
    page.sent[0].resolve(sold(10));
    await wait(80);
    await page.click('Vender 1', 1);
    expect(page.sent.map((s) => s.body.itemId)).toEqual([`crop_${A}`, `crop_${B}`]);
  });

  it('plantio de outra semente espera o primeiro e não disputa os mesmos canteiros', async () => {
    const page = openPage([seed(A, 9), seed(B, 9)]);
    page.show('plant');
    await page.click('9x');
    await page.click('9x', 1);
    expect(page.sent.map((s) => s.body)).toEqual([{ itemId: A, amount: 9 }]);
    page.sent[0].resolve(planted([1, 2, 3, 4, 5, 6]));
    await settle();
    expect(page.sent[1].body).toEqual({ itemId: B, amount: 3 });
  });

  it('venda lenta não segura o plantio', async () => {
    const page = openPage([seed(A, 3), crop(B, 4)]);
    await page.click('Vender 1');
    page.show('plant');
    await page.click('1x');
    expect(page.sent.map((s) => s.route)).toEqual(['sell', 'plant']);
  });

  it('Vender Todas atrás da venda da última colheita não troca o sucesso por erro', async () => {
    const page = openPage([crop(A, 3)]);
    await page.click('Vender Tudo');
    await page.click('🌱 Vender Todas');
    page.sent[0].resolve(sold(30));
    await wait(1000);
    expect(page.sent.map((s) => s.body)).toEqual([{ itemId: `crop_${A}`, quantity: 3 }]);
    expect(page.text('toast')).toContain('Vendeu 3x');
    expect(page.isLit('🌱 Vender Todas')).toBe(true);
  });

  it('Vender Todas sem nada à venda continua mostrando a recusa da API', async () => {
    const page = openPage([seed(A, 1)]);
    await page.click('🌱 Vender Todas');
    page.sent[0].resolve({ message: 'Nenhum item válido para vender.' }, false);
    await settle();
    expect(page.text('toast')).toBe('Nenhum item válido para vender.');
  });

  it('Vender Todas atrás de uma venda que falhou ainda vende', async () => {
    const page = openPage([crop(A, 3)]);
    await page.click('Vender Tudo');
    await page.click('🌱 Vender Todas');
    page.sent[0].reject(new TypeError('Failed to fetch'));
    await settle();
    expect(page.sent[1]?.body).toEqual({ all: true });
  });
});
