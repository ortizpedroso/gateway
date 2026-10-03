import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";
import { encryptSecret, generateApiKey, sha256Hex, randomToken } from "@/lib/crypto";
import { asaas, type AsaasAccountInput } from "@/services/asaas.client";

/**
 * Onboarding de lojistas: registro local + criação de subconta no upstream
 * (POST /v3/accounts) + emissão das credenciais da plataforma (pk/sk).
 */

export interface RegisterMerchantInput {
  tradeName: string;
  legalName: string;
  document: string; // CNPJ/CPF somente dígitos
  email: string;
  phone?: string;
  website?: string;
  city?: number; // código IBGE do município (exigido pelo upstream)
  state?: string;
  zipCode?: string;
  street?: string;
  streetNumber?: string;
  district?: string;
  complement?: string;
}

export interface RegisterMerchantResult {
  merchantId: string;
  status: "PENDING";
  publicKey: string;
  secretKey: string; // exibida UMA única vez no cadastro
  webhookSecret: string;
}

export async function registerMerchant(input: RegisterMerchantInput): Promise<RegisterMerchantResult> {
  const document = input.document.replace(/\D/g, "");
  if (![11, 14].includes(document.length)) {
    throw new ApiError(422, "invalid_document", "Documento deve ser CPF (11) ou CNPJ (14) válido.");
  }

  const dup = await prisma.merchant.findFirst({
    where: { OR: [{ document }, { email: input.email.toLowerCase() }] },
  });
  if (dup) throw new ApiError(409, "merchant_exists", "Já existe um lojista com este documento ou e-mail.");

  // 1) Cria a subconta no provedor upstream ANTES de persistir local.
  const accountInput: AsaasAccountInput = {
    name: input.legalName,
    email: input.email,
    document,
    type: document.length === 14 ? "COMPANY" : "INDIVIDUAL",
    mobilePhone: input.phone?.replace(/\D/g, ""),
    country: "BR",
    city: input.city,
    state: input.state,
    zipCode: input.zipCode?.replace(/\D/g, ""),
    street: input.street,
    number: input.streetNumber,
    district: input.district,
    complement: input.complement,
  };

  let account;
  try {
    account = await asaas.createSubAccount(accountInput);
  } catch (err) {
    console.error("[onboarding] falha ao criar subconta upstream", err);
    throw new ApiError(502, "provider_error", "Não foi possível concluir o onboarding junto ao provedor.");
  }

  // 2) Persistência local transacional: merchant + api keys + segredo de webhook
  const pk = generateApiKey("pk", "live");
  const sk = generateApiKey("sk", "live");
  const webhookSecret = `whsec_${randomToken(16)}`;

  const merchant = await prisma.$transaction(async (tx) => {
    const m = await tx.merchant.create({
      data: {
        tradeName: input.tradeName,
        legalName: input.legalName,
        document,
        email: input.email.toLowerCase(),
        phone: input.phone,
        website: input.website,
        city: input.city ? String(input.city) : null,
        state: input.state,
        zipCode: input.zipCode,
        asaasAccountId: account.id,
        asaasApiKeyEncrypted: encryptSecret(account.apiKeyToken), // token da SUBCONTA
        status: "PENDING",
        webhookUrl: null,
        webhookSecret,
      },
    });
    await tx.apiKey.createMany({
      data: [
        {
          merchantId: m.id,
          type: "public",
          environment: "LIVE",
          prefix: pk.slice(0, 12),
          publicKey: pk,
          last4: pk.slice(-4),
          name: "Chave pública padrão",
        },
        {
          merchantId: m.id,
          type: "secret",
          environment: "LIVE",
          prefix: sk.slice(0, 12),
          hashedKey: sha256Hex(sk),
          last4: sk.slice(-4),
          name: "Chave secreta padrão",
        },
      ],
    });
    return m;
  });

  // 3) Registra webhook inbound na subconta (ACCOUNT_STATUS_CHANGED + PAYMENT_*)
  try {
    await asaas.configureWebhook(account.id, {
      accessToken: account.apiKeyToken,
      url: `${process.env.PLATFORM_DOMAIN}/api/v1/webhooks/asaas?accountId=${account.id}`,
      authToken: process.env.WEBHOOK_INBOUND_TOKEN,
      autoRetry: true,
      events: [
        "PAYMENT_RECEIVED",
        "PAYMENT_CONFIRMED",
        "PAYMENT_OVERDUE",
        "PAYMENT_REFUNDED",
        "PAYMENT_CREATED",
        "ACCOUNT_STATUS_CHANGED",
      ],
    });
  } catch (e) {
    console.warn("[onboarding] webhook não configurado agora (será re-tentado pelo worker)", e);
  }

  return { merchantId: merchant.id, status: "PENDING", publicKey: pk, secretKey: sk, webhookSecret };
}

/** Upload multipart de documentos KYC para validação na subconta. */
export async function submitKycDocuments(
  merchantId: string,
  files: Array<{ buffer: Buffer; fileName: string; mimeType: string; type: string }>,
): Promise<{ uploaded: number }> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new ApiError(404, "merchant_not_found", "Lojista não encontrado.");
  if (!merchant.asaasAccountId) throw new ApiError(409, "no_subaccount", "Subconta ainda não criada.");
  if (files.length === 0) throw new ApiError(422, "no_files", "Envie ao menos um documento.");

  let uploaded = 0;
  for (const f of files) {
    if (f.buffer.byteLength > 10 * 1024 * 1024) {
      throw new ApiError(413, "file_too_large", `Arquivo ${f.fileName} excede 10MB.`);
    }
    const docType = ["CONTRACT", "SIMPLIFIED_STATEMENT", "ARTICLES_OF_INCORPORATION", "BANK_PROOF", "SOCIAL_CONTRACT"].includes(f.type)
      ? (f.type as any)
      : "CONTRACT";
    await asaas.uploadKycDocument(merchant.asaasAccountId, { bytes: f.buffer, fileName: f.fileName, mimeType: f.mimeType }, docType);
    await prisma.kycDocument.create({
      data: {
        merchantId: merchant.id,
        type: docType as any,
        fileName: f.fileName,
        mimeType: f.mimeType,
        sizeBytes: f.buffer.byteLength,
      },
    });
    uploaded++;
  }
  return { uploaded };
}
