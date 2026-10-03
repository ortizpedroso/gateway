import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonOk, jsonError, handleError, authenticateSecretKey } from "@/lib/http";
import { createCharge } from "@/services/charges.service";
import {
  enforceRateLimit, applyRateHeaders, requireIdempotencyKey,
  getCachedIdempotentResponse, lockIdempotency, storeIdempotentResponse, releaseIdempotencyLock,
} from "@/lib/ratelimit";

/**
 * POST /api/v1/charges — API transparente para e-commerces.
 * Auth: Authorization: Bearer sk_live_...
 * Idempotência (Módulo A): header Idempotency-Key UUIDv4 OBRIGATÓRIO, com
 * cache de resposta no Redis + deduplicação persistida no banco como
 * segunda camada (constraint única em Charge). Rate limiting por IP.
 */

const schema = z.object({
  billingType: z.enum(["PIX", "CREDIT_CARD", "BOLETO"]),
  value: z.number().positive(),
  description: z.string().max(200).optional(),
  external_reference: z.string().max(100).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customer: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    document: z.string().optional(), // CPF/CNPJ (dígitos ou formatado)
    address: z
      .object({
        street: z.string(),
        number: z.string(),
        complement: z.string().optional(),
        district: z.string(),
        city: z.string(),
        state: z.string().length(2),
        zipCode: z.string(),
      })
      .optional(),
  }),
  card: z
    .object({
      creditCardToken: z.string().min(8),
      installments: z.number().int().min(1).max(12).default(1),
      holderInfo: z.record(z.any()).optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    const rate = await enforceRateLimit(req, "charges", Number(process.env.API_RATE_LIMIT_MAX ?? 60));
    if (!rate.ok) {
      return applyRateHeaders(jsonError(429, "rate_limited", "Limite de requisições excedido (Retry-After)."), rate);
    }

    // Idempotency-Key UUIDv4 obrigatório em operações de escrita financeira.
    const idemKey = requireIdempotencyKey(req);

    const { merchant } = await authenticateSecretKey(req);

    // Reentrega exata da resposta anterior (cache Redis 24h) — evita cobrar duas vezes.
    const cached = await getCachedIdempotentResponse("charges", merchant.id, idemKey);
    if (cached) {
      const res = NextResponse.json(JSON.parse(cached.body), {
        status: cached.status,
        headers: { "Idempotent-Replay": "true" },
      });
      return applyRateHeaders(res, rate);
    }

    // Lock curto anti-corrida: duas reqs simultâneas com a mesma chave → 409.
    if (!(await lockIdempotency("charges", merchant.id, idemKey))) {
      return jsonError(409, "idempotency_in_progress", "Uma requisição com esta Idempotency-Key está em processamento.");
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      releaseIdempotencyLock("charges", merchant.id, idemKey);
      return jsonError(400, "invalid_json", "Corpo da requisição não é JSON válido.");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      releaseIdempotencyLock("charges", merchant.id, idemKey);
      return jsonError(
        422,
        "validation_error",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }

    try {
      const charge = await createCharge({
        merchant,
        billingType: parsed.data.billingType,
        value: parsed.data.value,
        description: parsed.data.description,
        externalReference: parsed.data.external_reference,
        idempotencyKey: idemKey,
        dueDate: parsed.data.due_date,
        customer: {
          name: parsed.data.customer.name,
          email: parsed.data.customer.email,
          phone: parsed.data.customer.phone,
          document: parsed.data.customer.document?.replace(/\D/g, ""),
          address: parsed.data.customer.address,
        },
        card: parsed.data.card && {
          creditCardToken: parsed.data.card.creditCardToken,
          installments: parsed.data.card.installments,
          holderInfo: parsed.data.card.holderInfo as any,
        },
      });

      const envelope = { success: true, data: charge };
      await storeIdempotentResponse("charges", merchant.id, idemKey, 201, envelope);
      return applyRateHeaders(jsonOk(charge, 201), rate);
    } catch (err) {
      releaseIdempotencyLock("charges", merchant.id, idemKey);
      throw err;
    }
  } catch (err) {
    return handleError(err);
  }
}
