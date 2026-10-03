"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireMerchant } from "@/lib/session";
import { randomToken } from "@/lib/crypto";

export async function createPaymentLinkAction(formData: FormData): Promise<void> {
  try {
    const merchant = await requireMerchant();
    const title = String(formData.get("title") ?? "").trim();
    const amount = Number(formData.get("amount") ?? "0");
    if (!title || !(amount > 0)) throw new Error("Informe título e valor válido.");

    const methods = ["PIX", "CREDIT_CARD", "BOLETO"].filter((m) => formData.get(m) === "on");
    const link = await prisma.paymentLink.create({
      data: {
        merchantId: merchant.id,
        slug: randomToken(6),
        title,
        amount,
        availableMethods: methods.length ? methods : ["PIX"],
        maxInstallments: Math.min(Number(formData.get("maxInstallments") ?? 12), 12),
        dueDate: formData.get("dueDate") ? new Date(String(formData.get("dueDate"))) : null,
      },
    });
    revalidatePath("/dashboard/links");
    // URL disponível na listagem abaixo (revalidatePath)
  } finally {
    void 0;
  }
}
