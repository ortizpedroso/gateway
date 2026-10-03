import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, jsonError, handleError, authenticateSecretKey } from "@/lib/http";
import { createSubscription } from "@/services/subscriptions.service";

const schema = z.object({
  name: z.string().min(2),
  value: z.number().positive(),
  billingType: z.enum(["PIX", "CREDIT_CARD", "BOLETO"]),
  recurrence: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY"]),
  maxCycles: z.number().int().positive().optional(),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customer: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    document: z.string().optional(),
    phone: z.string().optional(),
  }),
  card: z.object({ creditCardToken: z.string(), holderInfo: z.record(z.any()).optional() }).optional(),
});

/** POST /api/v1/subscriptions — recorrência na subconta do lojista. */
export async function POST(req: NextRequest) {
  try {
    const { merchant } = await authenticateSecretKey(req);
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return jsonError(422, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const sub = await createSubscription({ merchant, ...parsed.data });
    return jsonOk(
      {
        id: sub.id,
        object: "subscription",
        name: sub.name,
        status: sub.status,
        value: Number(sub.value),
        billing_type: sub.billingType,
        recurrence: sub.recurrence,
        next_due_date: sub.nextDueDate?.toISOString() ?? null,
        created_at: sub.createdAt.toISOString(),
      },
      201,
    );
  } catch (err) {
    return handleError(err);
  }
}
