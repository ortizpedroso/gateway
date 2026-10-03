/**
 * Workers BullMQ — processamento assíncrono de:
 *  - webhook-out: entrega com retry exponencial + assinatura HMAC-SHA256
 *  - email-transactions: comprovantes via Resend (fallback log)
 *  - fiscal-nfse: emissão de NFS-e via driver fiscal configurado
 *
 * Executar com: npm run worker
 */
import { Job } from "bullmq";
import { prisma } from "@/lib/prisma";
import { hmacSha256 } from "@/lib/crypto";
import { makeWorker, QUEUE, type WebhookOutJobData, type EmailJobData, type FiscalJobData } from "@/queues/queues";
import { issueInvoice } from "@/fiscal";

// --------------------------- webhook delivery ------------------------------

async function deliverWebhook(job: Job<WebhookOutJobData>): Promise<void> {
  const { webhookEventId, url, payload, secret } = job.data;
  const body = JSON.stringify(payload);
  const signature = hmacSha256(secret, body);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PayHub-Signature": `t=${Date.now()},v1=${signature}`,
        "X-PayHub-Event-Id": webhookEventId,
        "User-Agent": "PayHub-Webhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const ok = res.ok;
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: {
        status: ok ? "DELIVERED" : "FAILED",
        attempts: { increment: 1 },
        deliveredAt: ok ? new Date() : null,
        lastError: ok ? null : `http_${res.status}`,
        signature: `v1=${signature}`,
      },
    });
    if (!ok) throw new Error(`webhook_http_${res.status}`);
  } catch (err) {
    await prisma.webhookEvent
      .update({
        where: { id: webhookEventId },
        data: { status: "FAILED", attempts: { increment: 1 }, lastError: String(err).slice(0, 300) },
      })
      .catch(() => {});
    throw err; // BullMQ aplica backoff exponencial
  }
}

// ------------------------------- e-mails -----------------------------------

async function sendEmail(job: Job<EmailJobData>): Promise<void> {
  const { to, subject, html } = job.data;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.info(`[email:dry-run] to=${to} subject=${subject}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM ?? "PayHub <onboarding@resend.dev>", to, subject, html }),
  });
  if (!res.ok) throw new Error(`email_send_failed:${res.status}:${await res.text()}`);
}

// ------------------------------ fiscal -------------------------------------

async function fiscalJob(job: Job<FiscalJobData>): Promise<void> {
  await issueInvoice(job.data.invoiceId);
}

// ------------------------------- bootstrap ----------------------------------

export function startWorkers(): void {
  makeWorker(QUEUE.WEBHOOK_OUT, deliverWebhook);
  makeWorker(QUEUE.EMAIL, sendEmail);
  makeWorker(QUEUE.FISCAL, fiscalJob);
  console.log("[workers] webhook-out | email-transactions | fiscal-nfse prontos");
}

if (require.main === module) startWorkers();
