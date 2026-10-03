"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { setSessionCookie } from "@/lib/session";

/** Server Action: login no dashboard via e-mail + document (CPF/CNPJ). */
export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "").toLowerCase();
  const document = String(formData.get("document") ?? "").replace(/\D/g, "");
  if (!email || !document) return { error: "Preencha e-mail e documento." };

  const merchant = await prisma.merchant.findFirst({ where: { email, document } });
  if (!merchant) return { error: "Credenciais não encontradas." };
  if (merchant.status !== "APPROVED") return { error: "Conta em análise (KYC pendente)." };

  setSessionCookie(merchant.id);
  redirect("/dashboard");
}
