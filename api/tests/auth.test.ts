import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

const API_KEY = 'chave-de-teste-auth-0123456789';
process.env.API_KEY = API_KEY;

const { isValidApiKey, requireBotApiKey } = await import('../src/plugins/auth.js');
const { apiKeyStartupWarning, DEFAULT_API_KEY } = await import('../src/config.js');

describe('isValidApiKey (comparação em tempo constante)', () => {
  it('aceita só a chave exata', () => {
    expect(isValidApiKey(API_KEY)).toBe(true);
    expect(isValidApiKey(`${API_KEY}x`)).toBe(false);
    expect(isValidApiKey(API_KEY.slice(0, -1))).toBe(false);
    expect(isValidApiKey('x')).toBe(false);
    expect(isValidApiKey('a'.repeat(10_000))).toBe(false);
  });
  it('recusa vazio, não string e cabeçalho repetido (array)', () => {
    expect(isValidApiKey('')).toBe(false);
    expect(isValidApiKey(undefined)).toBe(false);
    expect(isValidApiKey([API_KEY, API_KEY])).toBe(false);
  });
  it('API_KEY vazia não autentica ninguém', () => {
    expect(isValidApiKey('', '')).toBe(false);
    expect(isValidApiKey('qualquer', '')).toBe(false);
  });
  it('recusa a chave de exemplo em produção e aceita fora de produção', () => {
    expect(isValidApiKey(DEFAULT_API_KEY, DEFAULT_API_KEY, 'production')).toBe(false);
    expect(isValidApiKey(DEFAULT_API_KEY, DEFAULT_API_KEY, 'development')).toBe(true);
    expect(isValidApiKey(DEFAULT_API_KEY, DEFAULT_API_KEY, 'test')).toBe(true);
  });
});

describe('requireBotApiKey (rota)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler((err: any, _req, reply) => reply.status(err.statusCode || 500).send({ code: err.code }));
    app.get('/bot', { preHandler: [requireBotApiKey] }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/bot', headers });

  it('200 com x-api-key ou Bearer corretos', async () => {
    expect((await get({ 'x-api-key': API_KEY })).statusCode).toBe(200);
    expect((await get({ authorization: `Bearer ${API_KEY}` })).statusCode).toBe(200);
  });
  it('401 sem chave, com chave errada ou com prefixo da chave', async () => {
    expect((await get({})).statusCode).toBe(401);
    expect((await get({ 'x-api-key': 'errada' })).statusCode).toBe(401);
    expect((await get({ 'x-api-key': API_KEY.slice(0, 5) })).statusCode).toBe(401);
    expect((await get({ authorization: 'Bearer errada' })).statusCode).toBe(401);
  });
});

describe('apiKeyStartupWarning', () => {
  it('avisa em produção com a chave de exemplo ou vazia', () => {
    expect(apiKeyStartupWarning({ NODE_ENV: 'production', API_KEY: DEFAULT_API_KEY })).toMatch(/chave de exemplo/);
    expect(apiKeyStartupWarning({ NODE_ENV: 'production', API_KEY: '' })).toMatch(/vazia/);
  });
  it('não avisa com chave própria nem fora de produção', () => {
    expect(apiKeyStartupWarning({ NODE_ENV: 'production', API_KEY: 'outra-chave-forte' })).toBeNull();
    expect(apiKeyStartupWarning({ NODE_ENV: 'development', API_KEY: DEFAULT_API_KEY })).toBeNull();
    expect(apiKeyStartupWarning({ NODE_ENV: 'test', API_KEY: '' })).toBeNull();
  });
});
