import { NextRequest } from "next/server";
import { jsonOk, jsonError, handleError, authenticateSecretKey } from "@/lib/http";
import { submitKycDocuments } from "@/services/onboarding.service";

/**
 * POST /api/v1/merchants/kyc — multipart/form-data
 * Campos: merchant_id (ou usa o da chave sk autenticada), files[] (documentos),
 * type (opcional: CONTRACT|BANK_PROOF|...)
 */
export async function POST(req: NextRequest) {
  try {
    const { merchant } = await authenticateSecretKey(req);
    const form = await req.formData();

    const targetMerchantId = String(form.get("merchant_id") ?? merchant.id);
    if (targetMerchantId !== merchant.id) {
      return jsonError(403, "forbidden", "Chave não pertence ao merchant_id informado.");
    }

    const entries = form.getAll("files");
    const files: Array<{ buffer: Buffer; fileName: string; mimeType: string; type: string }> = [];
    const docType = String(form.get("type") ?? "CONTRACT");
    for (const e of entries) {
      if (!(e instanceof File)) continue;
      files.push({
        buffer: Buffer.from(await e.arrayBuffer()),
        fileName: e.name,
        mimeType: e.type || "application/octet-stream",
        type: docType,
      });
    }

    const result = await submitKycDocuments(merchant.id, files);
    return jsonOk({ ...result, status: "PENDING" });
  } catch (err) {
    return handleError(err);
  }
}
