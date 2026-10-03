import { NextRequest } from "next/server";
import { jsonOk, jsonError, handleError, authenticatePublicKey } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { asaas } from "@/services/asaas.client";
import { mapAsaasStatus } from "@/services/charges.service";

/** GET /api/v1/public/charges/{id}/status — polling do checkout (Pix/boleto). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const merchant = await authenticatePublicKey(req);
    const charge = await prisma.charge.findFirst({ where: { id: params.id, merchantId: merchant.id } });
    if (!charge) return jsonError(404, "charge_not_found", "Cobrança não encontrada.");

    // Confirmação em tempo real quando ainda pendente (não depende só do webhook)
    if (["PENDING", "RECEIVED"].includes(charge.status) && charge.asaasPaymentId) {
      try {
        const token = asaas.merchantAccessTokenPublic(merchant.asaasApiKeyEncrypted);
        const remote = await asaas.getPayment(token, charge.asaasPaymentId);
        const mapped = mapAsaasStatus(remote.status);
        if (mapped !== charge.status) {
          const updated = await prisma.charge.update({
            where: { id: charge.id },
            data: {
              status: mapped,
              paidAt: ["CONFIRMED", "RECEIVED"].includes(mapped) && !charge.paidAt ? new Date() : charge.paidAt,
              confirmedAt: mapped === "CONFIRMED" && !charge.confirmedAt ? new Date() : charge.confirmedAt,
            },
          });
          return jsonOk({ id: updated.id, status: updated.status });
        }
      } catch {
        /* mantém status local */
      }
    }
    return jsonOk({ id: charge.id, status: charge.status });
  } catch (err) {
    return handleError(err);
  }
}
