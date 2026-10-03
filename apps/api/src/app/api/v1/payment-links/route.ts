import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, jsonError, handleError, authenticateSecretKey } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { randomToken } from "@/lib/crypto";

const schema = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  amount: z.number().positive(),
  allowCustomAmount: z.boolean().default(false),
  availableMethods: z.array(z.enum(["PIX", "CREDIT_CARD", "BOLETO"])).min(1).default(["PIX", "CREDIT_CARD", "BOLETO"]),
  maxInstallments: z.number().int().min(1).max(12).default(12),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  feeConfig: z.record(z.any()).optional(),
});

/** POST /api/v1/payment-links — geração de link avulso (/pay/{slug}). */
export async function POST(req: NextRequest) {
  try {
    const { merchant } = await authenticateSecretKey(req);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return jsonError(422, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const slug = randomToken(6);
    const link = await prisma.paymentLink.create({
      data: {
        merchantId: merchant.id,
        slug,
        ...parsed.data,
        dueDate: parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T23:59:59Z`) : null,
      },
    });
    const domain = process.env.CHECKOUT_APP_URL ?? process.env.PLATFORM_DOMAIN ?? "";
    return jsonOk(
      {
        id: link.id,
        url: `${domain}/pay/${link.slug}`,
        amount: Number(link.amount),
        available_methods: link.availableMethods,
        active: link.active,
      },
      201,
    );
  } catch (err) {
    return handleError(err);
  }
}

/** GET /api/v1/payment-links — listagem para o dashboard. */
export async function GET(req: NextRequest) {
  try {
    const { merchant } = await authenticateSecretKey(req);
    const links = await prisma.paymentLink.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const domain = process.env.CHECKOUT_APP_URL ?? process.env.PLATFORM_DOMAIN ?? "";
    return jsonOk(
      links.map((l) => ({
        id: l.id,
        url: `${domain}/pay/${l.slug}`,
        title: l.title,
        amount: Number(l.amount),
        active: l.active,
        created_at: l.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    return handleError(err);
  }
}
