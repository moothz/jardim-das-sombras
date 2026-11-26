import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, isExampleKeyInProduction } from '../config.js';
import { DomainError } from '../errors/DomainError.js';
import { verifyAdminToken } from '../utils/token.js';

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * Compara com a API_KEY em tempo constante: os dois lados viram SHA-256 (mesmo tamanho) antes do
 * timingSafeEqual, então nem o conteúdo nem o tamanho da chave vazam pelo tempo de resposta.
 */
export function isValidApiKey(
  token: unknown,
  apiKey: string = config.API_KEY,
  nodeEnv: string = config.NODE_ENV,
): boolean {
  if (typeof token !== 'string' || !token || !apiKey) return false;
  if (isExampleKeyInProduction({ NODE_ENV: nodeEnv, API_KEY: apiKey })) return false;
  return timingSafeEqual(hashToken(token), hashToken(apiKey));
}

export function isTrustedRequest(req: FastifyRequest): boolean {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  if (isValidApiKey(apiKeyHeader)) {
    return true;
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (isValidApiKey(token)) {
      return true;
    }
  }

  return false;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (isTrustedRequest(req)) {
    return;
  }

  // Check for temporary user admin token
  let userToken: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userToken = authHeader.substring(7).trim();
  } else if (req.headers['x-admin-token']) {
    userToken = String(req.headers['x-admin-token']).trim();
  } else if ((req.query as any)?.token) {
    userToken = String((req.query as any).token).trim();
  }

  if (userToken) {
    const verification = verifyAdminToken(userToken);
    if (verification.valid && verification.userId) {
      const paramsUserId = (req.params as any)?.user_id;
      const bodyUserId = (req.body as any)?.userId;

      if (paramsUserId && paramsUserId !== verification.userId) {
        throw new DomainError('Acesso não autorizado para esta fazenda.', 'FORBIDDEN', 403);
      }
      if (bodyUserId && bodyUserId !== verification.userId) {
        throw new DomainError('Acesso não autorizado para esta fazenda.', 'FORBIDDEN', 403);
      }

      (req as any).adminUserId = verification.userId;
      return;
    } else {
      throw new DomainError('Sessão administrativa expirada ou inválida. Obtenha um novo link no bot.', 'TOKEN_EXPIRED', 401);
    }
  }

  throw new DomainError('Chave de API ou Token inválido ou não fornecido', 'UNAUTHORIZED', 401);
}

export async function requireBotApiKey(req: FastifyRequest, reply: FastifyReply) {
  if (isTrustedRequest(req)) {
    return;
  }
  throw new DomainError('Acesso restrito exclusivamente para chamadas internas do bot (requer API_KEY).', 'UNAUTHORIZED', 401);
}

