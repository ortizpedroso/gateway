import { prisma } from "@/lib/prisma";
import { hmacSha256 } from "@/lib/crypto";
import { mapAsaasStatus, sanitizeCharge } from "@/services/charges.service";
import { webhookOutQueue, emailQueue, fiscalQueue, type WebhookOutJobData } from "@/queues/queues";

/**
 * Pipeline de processamento do webhook inbound do provedor.
 * Idempotência garantida pela unique key `dedupeKey` em WebhookEvent:
 * inserção duplicada => SKIPPED_DUPLICATE e nada é re-processado.
 */

export interface AsaasWebhookPayload {
  id?: string; // event id (quando enviado pelo provedor)
  event: string; // PAYMENT_RECEIVED | PAYMENT_CONFIRMED | ...
  data: Record<string, any> & { id?: string; status?: string; customer?: string };
}

const CHARGE_EVENTS = new Set([
  "PAYMENT_CREATED",
  "PAYMENT_UPDATED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_RESTORED",
  "PAYMENT_DUNNED",
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
]);

export interface IngestResult {
  duplicate: boolean;
  eventId: string;
}

/** Persiste evento inbound com dedupe. Retorna duplicate=true se já visto. */
export async function ingestInboundEvent(
  payload: AsaasWebhookPayload,
  merchantIdHint: string | null,
): Promise<IngestResult> {
  const dedupeKey = `in:${payload.event}:${payload.id ?? payload.data?.id ?? Date.now()}`;
  try {
    const evt = await prisma.webhookEvent.create({
      data: {
        direction: "INBOUND",
        merchantId: merchantIdHint,
        event: payload.event,
        dedupeKey,
        payload: payload as object,
        status: "RECEIVED",
      },
    });
    return { duplicate: false, eventId: evt.id };
  } catch (err: any) {
    if (err?.code === "P2002") {
      const existing = await prisma.webhookEvent.findUnique({ where: { dedupeKey } });
      return { duplicate: true, eventId: existing?.id ?? "" };
    }
    throw err;
  }
}

/** Atualiza a Charge local a partir do evento PAYMENT_* (idempotente). */
export async function processPaymentEvent(eventId: string, payload: AsaasWebhookPayload): Promise<void> {
  const charge = await prisma.charge.findFirst({ where: { asaasPaymentId: payload.data?.id } });
  if (!charge) {
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: "SKIPPED_DUPLICATE", processedAt: new Date(), lastError: "charge_not_found" },
    });
    return;
  }

  const newStatus = mapAsaasStatus(String(payload.data?.status ?? ""));
  const wasConfirmed = ["CONFIRMED", "RECEIVED"].includes(charge.status);
  const isConfirmed = ["CONFIRMED", "RECEIVED"].includes(newStatus);

  await prisma.$transaction(async (tx) => {
    await tx.charge.update({
      where: { id: charge.id },
      data: {
        status: newStatus,
        paidAt: isConfirmed && !charge.paidAt ? new Date() : charge.paidAt,
        confirmedAt: newStatus === "CONFIRMED" && !charge.confirmedAt ? new Date() : charge.confirmedAt,
        refundedAt: newStatus === "REFUNDED" ? new Date() : charge.refundedAt,
      },
    });
    await tx.webhookEvent.update({
      where: { id: eventId },
      data: { status: "PROCESSED", processedAt: new Date(), chargeId: charge.id },
    });
  });

  // ---- Efeitos colaterais apenas na PRIMEIRA confirmação (evita re-disparo) ----
  const justConfirmed = isConfirmed && !wasConfirmed;
  const full = await prisma.charge.findUniqueOrThrow({
    where: { id: charge.id },
    include: { customer: true, merchant: true },
  });

  if (justConfirmed) {
    // 1) E-mail transacional de comprovante ao pagador final
    if (full.customer?.email) {
      await emailQueue.add(
        `receipt:${full.id}`,
        {
          to: full.customer.email,
          subject: `Pagamento confirmado — ${full.merchant.tradeName}`,
          html: buildReceiptEmail(full),
          chargeId: full.id,
        },
        { jobId: `receipt:${full.id}` },
      );
    }

    // 2) Enfileira emissão de NFS-e (trigger fiscal)
    const invoice = await prisma.invoice.upsert({
      where: { id: `inv_${full.id}` },
      update: {},
      create: {
        id: `inv_${full.id}`,
        merchantId: full.merchantId,
        chargeId: full.id,
        provider: process.env.FISCAL_PROVIDER ?? "focusnfe",
        status: "QUEUED",
      },
    });
    await fiscalQueue.add("issue", { invoiceId: invoice.id, chargeId: full.id }, { jobId: `fiscal:${invoice.id}` });
  }

  // 3) Webhook de saída assinado para a URL do lojista (todos os eventos relevantes)
  if (CHARGE_EVENTS.has(payload.event) && full.merchant.webhookUrl && full.merchant.webhookSecret) {
    const outPayload = {
      object: "payment",
      event: mapToPlatformEvent(payload.event, newStatus),
      created_at: new Date().toISOString(),
      data: sanitizeCharge(full),
    };
    const body = JSON.stringify(outPayload);
    const signature = hmacSha256(full.merchant.webhookSecret, body);
    const outbound = await prisma.webhookEvent.create({
      data: {
        direction: "OUTBOUND",
        merchantId: full.merchantId,
        chargeId: full.id,
        event: payload.event,
        dedupeKey: `out:${payload.event}:${full.id}:${payload.id ?? "x"}`,
        payload: outPayload as object,
        signature,
        status: "PENDING",
      },
    });
    await webhookOutQueue.add(
      "deliver",
      {
        webhookEventId: outbound.id,
        url: full.merchant.webhookUrl,
        payload: outPayload,
        secret: full.merchant.webhookSecret!,
      } satisfies WebhookOutJobData,
      { jobId: `wh:${outbound.id}` },
    );
  }
}

function mapToPlatformEvent(asasEvent: string, status: string): string {
  if (asasEvent === "PAYMENT_REFUNDED" || status === "REFUNDED") return "charge.refunded";
  if (status === "OVERDUE") return "charge.overdue";
  if (["CONFIRMED", "RECEIVED"].includes(status)) return "charge.confirmed";
  return "charge.pending";
}

/** Comprovante white-label — sem qualquer menção ao provedor upstream. */
function buildReceiptEmail(charge: any): string {
  const domain = process.env.PLATFORM_DOMAIN ?? "";
  const fmt = (v: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
  return `<!doctype html><html><body style="font-family:Inter,Arial;background:#f6f8fb;padding:24px">
  <div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:32px">
    <h2 style="color:#0f1f4b">${charge.merchant.tradeName}</h2>
    <p>Pagamento confirmado ✅</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#64748b">Identificador</td><td align="right"><b>${charge.id}</b></td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Valor</td><td align="right"><b>${fmt(Number(charge.grossAmount))}</b></td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Método</td><td align="right">${charge.billingType}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Data/hora</td><td align="right">${new Date().toLocaleString("pt-BR")}</td></tr>
    </table>
    <p style="color:#94a3b8;font-size:12px;margin-top:24px">Recibo emitido por ${domain.replace(/^https?:\/\//, "")}</p>
  </div></body></html>`;
}

/** ACCOUNT_STATUS_CHANGED: atualiza KYC do merchant (PENDING -> APPROVED/REJECTED). */
export async function processAccountStatusEvent(eventId: string, payload: AsaasWebhookPayload): Promise<void> {
  const accountId = String(payload.data?.id ?? "");
  const upstreamStatus = String((payload.data as any)?.status ?? payload.data?.object ?? "").toUpperCase();
  const merchant = await prisma.merchant.findFirst({ where: { asaasAccountId: accountId } });
  if (!merchant) return;

  const next =
    upstreamStatus.includes("ACTIVE") || upstreamStatus.includes("APPROVED")
      ? "APPROVED"
      : upstreamStatus.includes("REJECT") || upstreamStatus.includes("LOCKED")
        ? "REJECTED"
        : null;

  if (next) {
    await prisma.$transaction([
      prisma.merchant.update({
        where: { id: merchant.id },
        data: { status: next as any, kycReviewedAt: new Date() },
      }),
      prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: "PROCESSED", processedAt: new Date(), merchantId: merchant.id },
      }),
    ]);
  }
}
