import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, jsonError, handleError, authenticatePublicKey } from "@/lib/http";
import { asaas } from "@/services/asaas.client";
import { enforceRateLimit, applyRateHeaders } from "@/lib/ratelimit";

/**
 * POST /api/v1/public/credit-card/tokenize — proxy seguro de tokenização.
 * O PAN trafega HTTPS ponta-a-ponta e NÃO é persistido; devolvemos apenas o
 * creditCardToken para uso na criação da cobrança.
 * Rate limiting por IP (anti card-testing): máx. 5 tentativas/minuto.
 */
const schema = z.object({
  holderName: z.string().min(3),
  number: z.string().regex(/^\d{13,19}$/),
  expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/),
  expiryYear: z.string().regex(/^\d{2}$/),
  ccv: z.string().regex(/^\d{3,4}$/),
  cpfCnpj: z.string().regex(/^\d{11,14}$/),
  email: z.string().email(),
});

export async function POST(req: NextRequest) {
  try {
    const rate = await enforceRateLimit(req, "tokenize", Number(process.env.CHECKOUT_RATE_LIMIT_MAX ?? 5));
    if (!rate.ok) {
      return applyRateHeaders(
        jsonError(429, "rate_limited", "Muitas tentativas. Aguarde alguns minutos e tente novamente."),
        rate,
      );
    }
    const merchant = await authenticatePublicKey(req);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return jsonError(422, "validation_error", "Dados do cartão inválidos.");

    const token = asaas.merchantAccessTokenPublic(merchant.asaasApiKeyEncrypted);
    const result = await asaas.tokenizeCreditCard(token, parsed.data);
    return applyRateHeaders(jsonOk({ creditCardToken: result.creditCardToken }), rate);
  } catch (err) {
    return handleError(err);
  }
}
