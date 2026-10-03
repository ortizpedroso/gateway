import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

/**
 * Sessão do Dashboard (JWT-like HMAC assinado, armazenado em cookie httpOnly).
 * Simples e suficiente para o escopo; trocar por Auth.js/OpenID em produção.
 */

const COOKIE = "payhub_session";

function sign(payload: string): string {
  return crypto.createHmac("sha256", process.env.JWT_SECRET ?? "dev-secret").update(payload).digest("hex");
}

export function createSessionToken(merchantId: string): string {
  const payload = JSON.stringify({ merchantId, exp: Date.now() + 1000 * 60 * 60 * 8 });
  const body = Buffer.from(payload).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readSessionMerchantId(): string | null {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || sign(body) !== sig) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof parsed.exp === "number" && parsed.exp < Date.now()) return null;
    return typeof parsed.merchantId === "string" ? parsed.merchantId : null;
  } catch {
    return null;
  }
}

export async function requireMerchant() {
  const merchantId = readSessionMerchantId();
  if (!merchantId) redirect("/dashboard/login");
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) redirect("/dashboard/login");
  return merchant;
}

export function setSessionCookie(merchantId: string) {
  cookies().set(COOKIE, createSessionToken(merchantId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
}
