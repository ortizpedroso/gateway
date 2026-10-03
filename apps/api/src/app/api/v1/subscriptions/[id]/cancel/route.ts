import { NextRequest } from "next/server";
import { jsonOk, handleError, authenticateSecretKey } from "@/lib/http";
import { cancelSubscription } from "@/services/subscriptions.service";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { merchant } = await authenticateSecretKey(req);
    const sub = await cancelSubscription(merchant, params.id);
    return jsonOk({ id: sub.id, status: sub.status });
  } catch (err) {
    return handleError(err);
  }
}
