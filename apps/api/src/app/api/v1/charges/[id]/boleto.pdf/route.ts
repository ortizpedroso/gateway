import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { asaas } from "@/services/asaas.client";
import { jsonError, handleError, authenticateSecretKey } from "@/lib/http";

/**
 * GET /api/v1/charges/{id}/boleto.pdf — proxy white-label do PDF do boleto.
 * A URL upstream NUNCA é exposta: baixamos o bytes e servimos sob nosso domínio.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { merchant } = await authenticateSecretKey(req);
    const charge = await prisma.charge.findFirst({ where: { id: params.id, merchantId: merchant.id } });
    if (!charge) return jsonError(404, "charge_not_found", "Cobrança não encontrada.");
    if (!charge.asaasInvoiceUrl) return jsonError(409, "not_available", "PDF do boleto ainda não disponível.");

    const accessToken = asaas.merchantAccessTokenPublic(merchant.asaasApiKeyEncrypted);
    const res = await fetch(charge.asaasInvoiceUrl, { headers: { access_token: accessToken } });
    if (!res.ok) return jsonError(502, "provider_error", "Falha ao obter o boleto.");
    const buf = Buffer.from(await res.arrayBuffer());
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="boleto-${charge.id}.pdf"`,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
