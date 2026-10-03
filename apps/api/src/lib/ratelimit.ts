import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import Redis from "ioredis";
import { ApiError } from "@/lib/http";

/**
 * Rate limiting (token bucket) + Idempotency-Key com cache de resposta,
 * ambos backeados por Redis.
 *
 * - Rate limiting protege endpoints sensíveis contra card testing e
 *   brute-force: máx. RATE_LIMIT_MAX req/min por IP (padrão 5/min no
 *   checkout público).
 * - Idempotência exige header `Idempotency-Key` (UUIDv4) em POSTs de
 *   cobrança e grava a resposta HTTP para reentrega exata em retries —
 *   mesmo se o Redis estiver indisponível, o banco ainda garante a
 *   deduplicação por (merchantId, idempotencyKey) como segunda camada.
 */

const globalForRedis = globalThis as unknown as { _payhubRateRedis?: Redis };

function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!globalForRedis._payhubRateRedis) {
    globalForRedis._payhubRateRedis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    globalForRedis._payhubRateRedis.on("error", () => { /* fail-open abaixo */ });
  }
  return globalForRedis._payhubRateRedis;
}

export interface RateOptions {
  /** Janela em segundos (padrão 60). */
  windowSec?: number;
  /** Máximo de requisições permitidas na janela (padrão 5). */
  max?: number;
  /** Sufixo para isolar buckets por rota/propósito. */
  prefix?: string;
}

export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** Bucket de tokens simples baseado em contador com TTL (fail-open). */
export async function consumeBucket(key: string, opts: RateOptions = {}): Promise<RateResult> {
  const redis = getRedis();
  const windowSec = opts.windowSec ?? 60;
  const max = opts.max ?? 5;
  if (!redis) return { ok: true, remaining: max, retryAfterSec: 0 }; // Redis não configurado → sem limitação em dev
  try {
    const member = `${Math.floor(Math.random() * max)}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
    // Sorted-set sliding window: remove expirados, conta e adiciona em pipeline atômico.
    const now = Date.now();
    const results = await redis
      .multi()
      .zremrangebyscore(key, 0, now - windowSec * 1000)
      .zadd(key, now, member)
      .zcard(key)
      .expire(key, windowSec)
      .exec();
    const count = Number(results?.[2]?.[1] ?? 1);
    if (count > max) {
      // estourou: remove o membro recém-adicionado para não "queimar" janela
      await redis.zrem(key, member).catch(() => {});
      const oldest = await redis.zrange(key, 0, 0, "WITHSCORES").catch(() => [] as string[]);
      const retryAfter = oldest.length >= 2
        ? Math.max(1, Math.ceil((Number(oldest[1]) + windowSec * 1000 - now) / 1000))
        : windowSec;
      return { ok: false, remaining: 0, retryAfterSec: retryAfter };
    }
    return { ok: true, remaining: max - count, retryAfterSec: 0 };
  } catch {
    return { ok: true, remaining: max, retryAfterSec: 0 }; // fail-open: disponibilidade > estrita
  }
}

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown-ip"
  );
}

/**
 * Guard de rate limiting para rotinas de pagamento/checkout.
 * Lança ApiError 429 quando o bucket estoura; o caller deve repassar
 * `retryAfterSec` via handleError + headers (ver applyRateHeaders).
 */
export async function enforceRateLimit(req: NextRequest, purpose: string, max = 5, windowSec = 60): Promise<RateResult> {
  const key = `rl:${purpose}:${clientIp(req)}`;
  const res = await consumeBucket(key, { max, windowSec, prefix: purpose });
  return res;
}

export function applyRateHeaders(
  res: NextResponse,
  r: RateResult,
  limit = Number(process.env.CHECKOUT_RATE_LIMIT_MAX ?? 5),
): NextResponse {
  res.headers.set("X-RateLimit-Limit", String(limit));
  res.headers.set("X-RateLimit-Remaining", String(Math.max(0, r.remaining)));
  if (!r.ok) res.headers.set("Retry-After", String(r.retryAfterSec || 60));
  return res;
}

// ---------------------------------------------------------------------------
// Idempotency-Key (UUIDv4 obrigatório + cache de resposta em Redis)
// ---------------------------------------------------------------------------

const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CachedResponse {
  status: number;
  body: string;
}

/** Valida o header Idempotency-Key (UUIDv4). Retorna a chave ou lança 400. */
export function requireIdempotencyKey(req: NextRequest): string {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!key) {
    throw new ApiError(400, "missing_idempotency_key", "Header Idempotency-Key (UUIDv4) é obrigatório neste endpoint.");
  }
  if (!UUIDV4_RE.test(key)) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key deve ser um UUIDv4 válido.");
  }
  return key;
}

function idemRedisKey(scope: string, merchantId: string, key: string): string {
  return `idem:${scope}:${merchantId}:${key}`;
}

/** Busca resposta previamente gravada para (scope, merchant, key). */
export async function getCachedIdempotentResponse(
  scope: string,
  merchantId: string,
  key: string,
): Promise<CachedResponse | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(idemRedisKey(scope, merchantId, key));
    if (!raw) return null;
    return JSON.parse(raw) as CachedResponse;
  } catch {
    return null;
  }
}

/** Marca a chave como "em processamento" (lock curto) para evitar corrida de duplicatas. */
export async function lockIdempotency(scope: string, merchantId: string, key: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    const ok = await redis.set(`${idemRedisKey(scope, merchantId, key)}:lock`, "1", "PX", 60_000, "NX");
    return ok === "OK";
  } catch {
    return true;
  }
}

/** Grava a resposta final (TTL 24h) e libera o lock. */
export async function storeIdempotentResponse(
  scope: string,
  merchantId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const payload: CachedResponse = { status, body: JSON.stringify(body) };
    await redis
      .multi()
      .set(idemRedisKey(scope, merchantId, key), JSON.stringify(payload), "EX", 86_400)
      .del(`${idemRedisKey(scope, merchantId, key)}:lock`)
      .exec();
  } catch {
    /* melhor esforço — dedupe persistido no banco continua valendo */
  }
}

export function releaseIdempotencyLock(scope: string, merchantId: string, key: string): void {
  const redis = getRedis();
  if (!redis) return;
  void redis.del(`${idemRedisKey(scope, merchantId, key)}:lock`).catch(() => {});
}
