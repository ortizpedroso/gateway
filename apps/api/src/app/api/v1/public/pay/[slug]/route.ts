import { NextRequest } from "next/server";
import { jsonOk, jsonError, handleError, authenticatePublicKey } from "@/lib/http";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/v1/public/pay/{slug} — dados públicos do Payment Link para a SPA
 * de checkout (Vite). Retorna apenas o necessário: marca do lojista, valor,
 * métodos habilitados e regras de parcelamento. Nada do upstream vaza aqui.
 */
export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const merchant = await authenticatePublicKey(req);
    const link = await prisma.paymentLink.findFirst({
      where: { slug: params.slug, merchantId: merchant.id, active: true },
    });
    if (!link) return jsonError(404, "link_not_found", "Link de pagamento inválido ou expirado.");

    return jsonOk({
      id: link.id,
      slug: link.slug,
      title: link.title,
      description: link.description,
      amount: Number(link.amount),
      allow_custom_amount: link.allowCustomAmount,
      available_methods: link.availableMethods,
      max_installments: link.maxInstallments,
      fee_config: link.feeConfig,
      due_date: link.dueDate?.toISOString() ?? null,
      store: { name: merchant.tradeName, logoUrl: null },
    });
  } catch (err) {
    return handleError(err);
  }
}
