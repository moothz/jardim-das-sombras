import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

/** Chave de exemplo (README/.env.example). Em produção, precisa ser trocada: ver apiKeyStartupWarning. */
export const DEFAULT_API_KEY = 'jardim_secret_api_key_2026';

const configSchema = z.object({
  PORT: z.coerce.number().default(3040),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/jardim_das_sombras?schema=public'),
  API_KEY: z.string().default(DEFAULT_API_KEY),
  CORS_ORIGINS: z.string().default('*'),
  ASSETS_PATH: z.string().default(path.resolve(__dirname, '../../assets')),
  PUBLIC_URL: z.string().default('http://localhost:3040'),
  DATA_PATH: z.string().default(path.resolve(__dirname, '../../data')),
  SUPER_ADMIN_PASSWORD: z.string().default(''),
  // BotAPI (ravena-ai). Vazio = push de colheita desligado; o bot reconcilia no próximo comando.
  BOT_API_URL: z.string().default(''),
  // Vazio = usa a API_KEY do Jardim como x-api-key do webhook.
  BOT_API_TOKEN: z.string().default(''),
});

export const config = configSchema.parse({
  DATA_PATH: process.env.DATA_PATH,
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD,
  PORT: process.env.PORT,
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  API_KEY: process.env.API_KEY,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  ASSETS_PATH: process.env.ASSETS_PATH,
  PUBLIC_URL: process.env.PUBLIC_URL || process.env.BASE_URL,
  BOT_API_URL: process.env.BOT_API_URL,
  BOT_API_TOKEN: process.env.BOT_API_TOKEN,
});

export type Config = z.infer<typeof configSchema>;

type ApiKeyConfig = { NODE_ENV: string; API_KEY: string };

export function isExampleKeyInProduction(cfg: ApiKeyConfig = config): boolean {
  return cfg.NODE_ENV === 'production' && cfg.API_KEY === DEFAULT_API_KEY;
}

/**
 * Aviso de subida quando a API_KEY de produção é a chave de exemplo (pública no repositório) ou está vazia.
 * Não impede a subida, mas nos dois casos as chamadas do bot e da ravena são recusadas. Devolve null se está tudo certo.
 */
export function apiKeyStartupWarning(cfg: ApiKeyConfig = config): string | null {
  if (cfg.NODE_ENV !== 'production') return null;
  if (isExampleKeyInProduction(cfg)) {
    return (
      'API_KEY de produção é a chave de exemplo do repositório (pública): as chamadas do bot e da ravena-ai estão ' +
      'sendo recusadas (401) e os links de administração da fazenda estão desligados. Gere uma chave (ex.: ' +
      'openssl rand -hex 32), defina API_KEY no .env do Jardim e a mesma em JARDIM_API_KEY na ravena-ai, e recrie os containers.'
    );
  }
  if (!cfg.API_KEY.trim()) {
    return 'API_KEY de produção está vazia: nenhuma chamada do bot autentica. Defina API_KEY no .env do Jardim (igual à JARDIM_API_KEY da ravena-ai).';
  }
  return null;
}
