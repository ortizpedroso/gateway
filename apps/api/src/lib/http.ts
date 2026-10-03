import { NextRequest, NextResponse } from "next/server";
import { Prisma, type Merchant } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sha256Hex, safeEqual } from "@/lib/crypto";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Envelope padronizado da API — sem qualquer vazamento do upstream. */
export function jsonOk(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export function handleError(err: unknown): NextResponse {
  if (err instanceof ApiError) return jsonError(err.status, err.code, err.message);
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return jsonError(409, "duplicate_resource", "Recurso já existe (violação de unicidade).");
  }
  console.error("[api] unhandled error", err);
  return jsonError(500, "internal_error", "Erro interno inesperado.");
}

// ---------------------------------------------------------------------------
// Autenticação server-to-server: Authorization: Bearer sk_live_... / sk_test_...
// ---------------------------------------------------------------------------

export interface AuthenticatedMerchant {
  merchant: Merchant;
  apiKeyId: string;
}

export async function authenticateSecretKey(req: NextRequest): Promise<AuthenticatedMerchant> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(sk_(?:live|test)_[A-Za-z0-9]+)$/.exec(header.trim());
  if (!match) {
    throw new ApiError(401, "missing_credentials", "Header Authorization: Bearer sk_live_... é obrigatório.");
  }
  const key = match[1];
  const hashed = sha256Hex(key);
  const apiKey = await prisma.apiKey.findUnique({ where: { hashedKey: hashed }, include: { merchant: true } });
  if (!apiKey || apiKey.revokedAt || apiKey.type !== "secret") {
    throw new ApiError(401, "invalid_api_key", "Chave secreta inválida ou revogada.");
  }
  if (apiKey.merchant.status !== "APPROVED") {
    throw new ApiError(403, "merchant_not_approved", "Conta do lojista ainda não aprovada (KYC pendente).");
  }
  void prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { merchant: apiKey.merchant, apiKeyId: apiKey.id };
}

// ---------------------------------------------------------------------------
// Autenticação pública do checkout: X-Publishable-Key: pk_live_...
// ---------------------------------------------------------------------------

export async function authenticatePublicKey(req: NextRequest): Promise<Merchant> {
  const key = req.headers.get("x-publishable-key") ?? "";
  if (!/^pk_(live|test)_[A-Za-z0-9]+$/.test(key)) {
    throw new ApiError(401, "invalid_publishable_key", "Header X-Publishable-Key ausente ou malformado.");
  }
  const apiKey = await prisma.apiKey.findUnique({ where: { publicKey: key }, include: { merchant: true } });
  if (!apiKey || apiKey.revokedAt || apiKey.type !== "public") {
    throw new ApiError(401, "invalid_publishable_key", "Chave pública inválida.");
  }
  if (apiKey.merchant.status !== "APPROVED") {
    throw new ApiError(403, "merchant_not_approved", "Loja indisponível no momento.");
  }
  return apiKey.merchant;
}

// ---------------------------------------------------------------------------
// Token de segurança inbound (Asaas -> PayHub): auth-header configurável
// ---------------------------------------------------------------------------

export function verifyInboundWebhookToken(req: NextRequest): void {
  const expected = process.env.WEBHOOK_INBOUND_TOKEN;
  if (!expected) throw new ApiError(500, "config_error", "WEBHOOK_INBOUND_TOKEN não configurado.");
  const received =
    req.headers.get("asaas-access-token") ?? req.headers.get("x-payhub-signature") ?? "";
  // Comparação em tempo constante contra o segredo compartilhado.
  if (!safeEqual(received, expected)) {
    throw new ApiError(401, "invalid_webhook_token", "Token de segurança do webhook inválido.");
  }
}
