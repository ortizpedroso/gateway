import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, jsonError, handleError } from "@/lib/http";
import { registerMerchant } from "@/services/onboarding.service";

/** POST /api/v1/merchants/register — registro + criação de subconta upstream. */

const schema = z.object({
  tradeName: z.string().min(2),
  legalName: z.string().min(2),
  document: z.string().min(11).max(18),
  email: z.string().email(),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  city: z.number().int().optional(),
  state: z.string().length(2).optional(),
  zipCode: z.string().optional(),
  street: z.string().optional(),
  streetNumber: z.string().optional(),
  district: z.string().optional(),
  complement: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError(422, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const result = await registerMerchant(parsed.data);
    return jsonOk(result, 201);
  } catch (err) {
    return handleError(err);
  }
}
