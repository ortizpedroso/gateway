import { NextRequest } from "next/server";
import { jsonOk, jsonError, handleError, verifyInboundWebhookToken } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import {
  ingestInboundEvent,
  processPaymentEvent,
  processAccountStatusEvent,
  type AsaasWebhookPayload,
} from "@/services/webhooks.service";

/**
 * POST /api/v1/webhooks/asaas — listener inbound do provedor.
 * Validação: token compartilhado no header (auth-header configurado na
 * criação do webhook da subconta). Idempotência: unique dedupeKey.
 * Retorna 200 imediatamente após ingest para evitar re-tentativas do
 * provedor; efeitos colaterais (e-mail/fiscal/outbound) são enfileirados.
 */
export async function POST(req: NextRequest) {
  try {
    verifyInboundWebhookToken(req);

    const payload = (await req.json()) as AsaasWebhookPayload;
    if (!payload?.event || !payload?.data) {
      return jsonError(422, "invalid_payload", "Payload de webhook inválido.");
    }

    // Resolve o merchant pelo accountId na query string ou pelo customer/payment
    const accountId = req.nextUrl.searchParams.get("accountId");
    let merchantIdHint: string | null = null;
    if (accountId) {
      const m = await prisma.merchant.findFirst({ where: { asaasAccountId: accountId } });
      merchantIdHint = m?.id ?? null;
    }

    const { duplicate, eventId } = await ingestInboundEvent(payload, merchantIdHint);
    if (duplicate) {
      return jsonOk({ received: true, duplicate: true });
    }

    // Processamento inline leve (status update) — filas cuidam do resto.
    try {
      if (payload.event === "ACCOUNT_STATUS_CHANGED") {
        await processAccountStatusEvent(eventId, payload);
      } else if (payload.event.startsWith("PAYMENT_")) {
        await processPaymentEvent(eventId, payload);
      }
    } catch (err) {
      console.error("[webhooks] erro ao processar evento (provedor fará retry)", err);
      await prisma.webhookEvent
        .update({ where: { id: eventId }, data: { status: "FAILED", lastError: String(err).slice(0, 300) } })
        .catch(() => {});
      // 200 mesmo assim: dedupe já gravado; worker de reconciliação refaz.
    }

    return jsonOk({ received: true });
  } catch (err) {
    return handleError(err);
  }
}
