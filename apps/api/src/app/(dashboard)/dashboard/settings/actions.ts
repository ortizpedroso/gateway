"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireMerchant } from "@/lib/session";
import { generateApiKey, sha256Hex, randomToken } from "@/lib/crypto";

export async function rotateSecretKeyAction(): Promise<void> {
  const merchant = await requireMerchant();
  const sk = generateApiKey("sk", "live");
  await prisma.$transaction([
    prisma.apiKey.updateMany({ where: { merchantId: merchant.id, type: "secret" }, data: { revokedAt: new Date() } }),
    prisma.apiKey.create({
      data: { merchantId: merchant.id, type: "secret", environment: "LIVE", prefix: sk.slice(0, 12), hashedKey: sha256Hex(sk), last4: sk.slice(-4), name: "Rotacionada" },
    }),
  ]);
  revalidatePath("/dashboard/settings");
  // Nova chave ativa; valor em claro não é mais recuperável após criação via API.
}

export async function updateWebhookAction(formData: FormData): Promise<void> {
  const merchant = await requireMerchant();
  const url = String(formData.get("webhookUrl") ?? "").trim() || null;
  if (url && !/^https:\/\//.test(url)) throw new Error("Webhook deve ser HTTPS.");
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { webhookUrl: url, webhookSecret: merchant.webhookSecret ?? `whsec_${randomToken(16)}` },
  });
  revalidatePath("/dashboard/settings");
}
