import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonOk, jsonError, handleError, authenticatePublicKey } from "@/lib/http";
import { createCharge } from "@/services/charges.service";
import { asaas } from "@/services/asaas.client";
import { enforceRateLimit, applyRateHeaders } from "@/lib/ratelimit";
import { prisma } from "@/lib/prisma";

/**
 * Rotas públicas do checkout (Vite SPA -> aqui), protegidas por pk_live_...
 * POST   /api/v1/public/charges            cria cobrança do checkout
 * POST   /api/v1/public/credit-card/tokenize  proxy de tokenização (PANs não persistidos)
 * GET    /api/v1/public/charges/:id/status    polling de status (Pix/boleto/cartão)
 *
 * Rate limiting: máx. 5 requisições/IP/minuto (anti card-testing/brute-force).
 */

const chargeSchema = z.object({
  paymentLinkId: z.string(),
  billingType: z.enum(["PIX", "CREDIT_CARD", "BOLETO"]),
  value: z.number().positive().optional(), // obrigatório se link permite valor custom
  installments: z.number().int().min(1).max(12).default(1),
  creditCardToken: z.string().min(8).optional(),
  customer: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    document: z.string().optional(),
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
});

export async function POST(req: NextRequest) {
  try {
    const rate = await enforceRateLimit(req, "public-charges", Number(process.env.CHECKOUT_RATE_LIMIT_MAX ?? 5));
    if (!rate.ok) {
      return applyRateHeaders(
        jsonError(429, "rate_limited", "Muitas tentativas de pagamento. Aguarde um instante e tente novamente."),
        rate,
      );
    }
    const merchant = await authenticatePublicKey(req);
    const parsed = chargeSchema.safeParse(await req.json());
    if (!parsed.success) {
      return jsonError(422, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const body = parsed.data;

    const link = await prisma.paymentLink.findFirst({ where: { id: body.paymentLinkId, merchantId: merchant.id, active: true } });
    if (!link) return jsonError(404, "link_not_found", "Link de pagamento inválido ou desativado.");

    const methods = (link.availableMethods as string[]) ?? [];
    if (!methods.includes(body.billingType)) {
      return jsonError(422, "method_unavailable", "Método de pagamento indisponível para este link.");
    }

    const value = link.allowCustomAmount ? body.value : Number(link.amount);
    if (!value || value <= 0) return jsonError(422, "invalid_amount", "Valor informado inválido.");

    const holderInfo = body.creditCardToken
      ? {
          name: body.customer.name,
          email: body.customer.email,
          cpfCnpj: body.customer.document?.replace(/\D/g, "") ?? "",
          phone: (body.customer.phone ?? "").replace(/\D/g, ""),
          addressPostalCode: body.customer.address?.zipCode?.replace(/\D/g, "") ?? "",
          addressStreet: body.customer.address?.street ?? "",
          addressNumber: body.customer.address?.number ?? "",
          addressComplement: body.customer.address?.complement,
          addressDistrict: body.customer.address?.district ?? "",
          addressCity: body.customer.address?.city ?? "",
          addressState: body.customer.address?.state ?? "",
        }
      : undefined;

    const charge = await createCharge({
      merchant,
      billingType: body.billingType,
      value,
      description: link.title,
      paymentLinkId: link.id,
      idempotencyKey: req.headers.get("idempotency-key")?.trim() || `plink:${link.id}:${Date.now()}`, // SPA envia UUIDv4 por tentativa; fallback gera attempt único
      customer: {
        name: body.customer.name,
        email: body.customer.email,
        phone: body.customer.phone,
        document: body.customer.document?.replace(/\D/g, ""),
        address: body.customer.address,
      },
      card: body.creditCardToken
        ? { creditCardToken: body.creditCardToken, installments: Math.min(body.installments, link.maxInstallments), holderInfo }
        : undefined,
    });

    return jsonOk(charge, 201);
  } catch (err) {
    return handleError(err);
  }
}
