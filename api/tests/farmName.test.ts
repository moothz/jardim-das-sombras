import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { FastifyInstance } from 'fastify';
import { renderPublicFarmHtml } from '../src/routes/views/publicFarmView.js';
import { renderAdminFarmHtml } from '../src/routes/views/adminFarmView.js';
import { FarmService } from '../src/services/FarmService.js';
import { unsafeTestDbReason } from './helpers/testDbGuard.js';

const API_KEY = vi.hoisted(() => (process.env.API_KEY = 'chave-de-teste-nome'));
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYER = '5511999990002';
const UUID = '00000000-0000-4000-8000-000000000002';
const HOSTILE = '<svg onload=alert()>';
const BREAKOUT = '</script><img src=x onerror=alert(1)>';
const NORMAL = ['Rosa <3', 'Jardim da Conceição', 'Flor 🌹🥀', "D'Ávila & Cia"];

function status(farmName: string | null, playerName: string | null = null) {
  return {
    playerId: PLAYER,
    uuid: UUID,
    farmName,
    playerName,
    coins: 1000,
    stats: { totalHarvested: 3 },
    slots: Array.from({ length: 9 }, (_, i) => ({ slotIndex: i + 1, plantId: null, stage: 'empty' })),
    decorations: [],
    inventory: [],
  };
}

function admin(farmName: string | null) {
  return renderAdminFarmHtml({
    status: status(farmName),
    token: 'token-ficticio',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    publicUrl: 'http://localhost:3040',
    timeCycle: 'day',
    shopCatalog: { seeds: [], consumables: [], decorations: [] },
    slotCoordinates: {},
  });
}

function scripts(html: string) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, s]) => s);
}

function runScripts(html: string) {
  const any: any = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === Symbol.iterator ? undefined : any),
    apply: () => any,
    construct: () => any,
  });
  const page = vm.createContext({
    window: any,
    document: any,
    navigator: any,
    localStorage: any,
    ResizeObserver: any,
    MutationObserver: any,
    IntersectionObserver: any,
    Image: any,
    console,
    URL,
    URLSearchParams,
    performance,
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
    requestAnimationFrame() {},
    fetch: () => new Promise(() => {}),
  });
  for (const s of scripts(html)) vm.runInContext(s, page);
  return page;
}

describe('página pública: nome da fazenda e do jogador', () => {
  it.each([
    ['farmName', status(HOSTILE)],
    ['playerName', status(null, HOSTILE)],
  ])('%s hostil sai escapado', (_label, s) => {
    const html = renderPublicFarmHtml(s, UUID);
    expect(html).toContain('&lt;svg onload=alert()&gt;');
    expect(html).not.toContain('<svg onload');
  });

  it.each(NORMAL)('nome normal %s aparece legível', (name) => {
    const html = renderPublicFarmHtml(status(name), UUID);
    const subtitle = html.match(/<div class="subtitle">([^<]*)<\/div>/)![1];
    const decoded = subtitle.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    expect(decoded).toBe(`Santuário de Cultivo '${name}'`);
  });

  it('sem nome usa o padrão', () => {
    expect(renderPublicFarmHtml(status(null), UUID)).toContain('Santuário de Cultivo de Jardineiro');
  });

  it('o id da URL não fecha o script da página', () => {
    const base = scripts(renderPublicFarmHtml(status(null), UUID)).length;
    const html = renderPublicFarmHtml(status(null), `${UUID}'</script><script>alert(1)//`);
    expect(scripts(html)).toHaveLength(base);
    expect(html).not.toContain('<script>alert(1)');
    for (const s of scripts(html)) expect(s).not.toMatch(/<!--|<\/?script/i);
    for (const s of scripts(html)) expect(() => new vm.Script(s)).not.toThrow();
  });
});

describe('painel do dono: nome da fazenda no script', () => {
  it.each([...NORMAL, BREAKOUT, 'a\u2028b\u2029c', '<!--<script>'])('FARM_NAME %j chega intacto e o script roda', (name) => {
    const html = admin(name);
    expect(scripts(html)).toHaveLength(scripts(admin(null)).length);
    expect(html).not.toContain('<img src=x');
    for (const s of scripts(html)) expect(s).not.toMatch(/<!--|<\/?script/i);
    expect(vm.runInContext('FARM_NAME', runScripts(html))).toBe(name);
  });
});

describe('FarmService.updateFarmName', () => {
  function service() {
    const update = vi.fn(async ({ data }) => ({ id: PLAYER, farmName: data.farmName }));
    return { svc: new FarmService({ player: { update } } as any), update };
  }

  it.each([
    ['  Rosa <3  ', 'Rosa <3'],
    ['Jar\u0000dim\u001b[31m\n\tdo\u007f\u009bLuar', 'Jardim[31mdoLuar'],
    ['🌹'.repeat(25), '🌹'.repeat(20)],
    ['á'.repeat(30), 'á'.repeat(20)],
    ['\u0000\u0001  ', null],
    ['', null],
    [null, null],
  ])('%j vira %j', async (input, expected) => {
    const { svc, update } = service();
    await svc.updateFarmName(PLAYER, input);
    expect(update).toHaveBeenCalledWith({ where: { id: PLAYER }, data: { farmName: expected } });
  });
});

const DB_URL = process.env.JDS_TEST_DATABASE_URL;
const UNSAFE_DB = DB_URL ? unsafeTestDbReason(DB_URL) : null;
const SCHEMA = 'farm_name_test';
const CSP = ["base-uri 'self'", "object-src 'none'", "form-action 'self'"];

describe.skipIf(!DB_URL)('PATCH /farm/:user_id/name e CSP (Postgres)', () => {
  let app: FastifyInstance;
  let playerAuth: Record<string, string>;
  const exporter = new InMemorySpanExporter();

  const rename = (payload: string) =>
    app.inject({
      method: 'PATCH',
      url: `/farm/${PLAYER}/name`,
      headers: { 'content-type': 'application/json', ...playerAuth },
      payload,
    });
  const stored = async () => (await app.prisma.player.findUniqueOrThrow({ where: { id: PLAYER } })).farmName;

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
    await app.prisma.player.create({ data: { id: PLAYER, uuid: UUID, farmName: 'Antigo' } });
    exporter.reset();
  });

  it.each(['123', 'true', '["a"]', '{"x":"y"}'])('recusa farmName %s com 400 e mantém o nome', async (value) => {
    const res = await rename(`{"farmName":${value}}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PAYLOAD');
    expect(await stored()).toBe('Antigo');
  });

  it.each([
    ['{"farmName":"Rosa <3 \\u0000\\u001b\\n🌹"}', 'Rosa <3 🌹'],
    ['{"farmName":null}', null],
    ['{"farmName":""}', null],
    ['{}', null],
  ])('%s grava %j', async (payload, expected) => {
    const res = await rename(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, farmName: expected });
    expect(await stored()).toBe(expected);
  });

  it('com a API_KEY vale a mesma regra', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/farm/${PLAYER}/name`,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      payload: '{"farmName":"Cripta do Luar"}',
    });
    expect(res.json()).toEqual({ success: true, farmName: 'Cripta do Luar' });
  });

  it('o span farm rename não leva o nome e marca a recusa', async () => {
    await rename('{"farmName":"Nome Secreto"}');
    await rename('{"farmName":5}');
    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'farm rename');
    expect(spans).toHaveLength(2);
    expect(spans[1].attributes).toMatchObject({ 'app.outcome': 'rejected', 'app.reject.reason': 'invalid_payload' });
    expect(JSON.stringify(exporter.getFinishedSpans().map((s) => [s.attributes, s.events]))).not.toContain('Nome Secreto');
  });

  it('a página pública mostra o nome hostil escapado', async () => {
    await rename(JSON.stringify({ farmName: HOSTILE }));
    const res = await app.inject({ method: 'GET', url: `/farm?id=${UUID}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('&lt;svg onload=alert()&gt;');
    expect(res.body).not.toContain('<svg onload');
  });

  it.each([`/farm?id=${UUID}`, '/farm', '/calibrate', '/super-admin', '/health'])('CSP de %s traz base-uri, object-src e form-action', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    const csp = String(res.headers['content-security-policy']);
    for (const directive of CSP) expect(csp).toContain(directive);
  });
});
