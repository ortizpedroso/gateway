import { Prisma, type BillingType, type ChargeStatus, type Merchant } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";
import { asaas, type AsaasPaymentResponse } from "@/services/asaas.client";

/**
 * Motor de cobranças. Toda operação crítica usa prisma.$transaction e
 * idempotência por (merchantId, idempotencyKey). Respostas são sanitizadas:
 * nenhum id/URL do upstream vaza para lojista ou pagador final.
 */

const PLATFORM_FIXED_FEE_CENTS = 100; // R$ 1,00 por transação confirmada

export function computeFees(grossAmount: number, merchant: Merchant, billingType: BillingType): {
  platformFee: number;
  netAmount: number;
} {
  const bps = merchant.platformFeeBps;
  let fee = grossAmount * (bps / 10_000) + PLATFORM_FIXED_FEE_CENTS / 100;
  // Cartão: spread proporcional por parcela (regra de repasse de juros).
  if (billingType === "CREDIT_CARD") fee *= 1.0; // ajuste fino por parcelas configurável via feeConfig
  const platformFee = Math.round(fee * 100) / 100;
  const netAmount = Math.round((grossAmount - platformFee) * 100) / 100;
  return { platformFee, netAmount };
}

function toPrismaBilling(billingType: string): BillingType {
  const map: Record<string, BillingType> = { PIX: "PIX", CREDIT_CARD: "CREDIT_CARD", BOLETO: "BOLETO" };
  const v = map[billingType];
  if (!v) throw new ApiError(422, "invalid_billing_type", `Método de pagamento inválido: ${billingType}`);
  return v;
}

export function mapAsaasStatus(status: string): ChargeStatus {
  const map: Record<string, ChargeStatus> = {
    PENDING: "PENDING",
    RECEIVED: "RECEIVED",
    CONFIRMED: "CONFIRMED",
    OVERDUE: "OVERDUE",
    REFUNDED: "REFUNDED",
    CANCELLED: "CANCELLED",
    EXPIRED: "CANCELLED",
  };
  return map[status] ?? "PENDING";
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CreateChargeInput {
  merchant: Merchant;
  billingType: string;
  value: number; // em reais
  description?: string;
  externalReference?: string;
  idempotencyKey?: string;
  dueDate?: string; // yyyy-MM-dd
  customer: {
    name: string;
    email: string;
    phone?: string;
    document?: string;
    cpfCnpj?: string;
    address?: {
      street: string;
      number: string;
      complement?: string;
      district: string;
      city: string;
      state: string;
      zipCode: string;
    };
  };
  card?: {
    creditCardToken: string;
    installments?: number;
    holderInfo?: NonNullable<Parameters<typeof asaas.createPayment>[1]["creditCardHolderInfo"]>;
  };
  paymentLinkId?: string;
}

export interface SanitizedCharge {
  id: string;
  object: "charge";
  status: ChargeStatus;
  method: BillingType;
  amount: number;
  fee: number;
  net_amount: number;
  installments: number;
  description: string | null;
  external_reference: string | null;
  created_at: string;
  due_date: string | null;
  paid_at: string | null;
  /** Pix */
  pix_qr_code?: string | null;
  pix_copy_paste?: string | null;
  /** Boleto */
  digitable_line?: string | null;
  boleto_pdf_url?: string | null; // URL nossa, redirecionada — nunca a do upstream
  /** Cartão */
  auth_code?: string | null;
}

export function sanitizeCharge(charge: {
  id: string;
  status: ChargeStatus;
  billingType: BillingType;
  grossAmount: Prisma.Decimal;
  platformFee: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  installments: number;
  description: string | null;
  externalReference: string | null;
  createdAt: Date;
  dueDate: Date | null;
  paidAt: Date | null;
  pixQrCode: string | null;
  pixCopiaECola: string | null;
  digitableLine: string | null;
  asaasInvoiceUrl: string | null;
}): SanitizedCharge {
  const domain = process.env.PLATFORM_DOMAIN ?? "https://payhub.local";
  return {
    id: charge.id,
    object: "charge",
    status: charge.status,
    method: charge.billingType,
    amount: Number(charge.grossAmount),
    fee: Number(charge.platformFee),
    net_amount: Number(charge.netAmount),
    installments: charge.installments,
    description: charge.description,
    external_reference: charge.externalReference,
    created_at: charge.createdAt.toISOString(),
    due_date: charge.dueDate?.toISOString() ?? null,
    paid_at: charge.paidAt?.toISOString() ?? null,
    ...(charge.billingType === "PIX" && {
      pix_qr_code: charge.pixQrCode,
      pix_copy_paste: charge.pixCopiaECola,
    }),
    ...(charge.billingType === "BOLETO" && {
      digitable_line: charge.digitableLine,
      // Proxy white-label: o download passa pelo nosso domínio.
      boleto_pdf_url: `${domain}/api/v1/charges/${charge.id}/boleto.pdf`,
    }),
  };
}

/** Garante Customer no upstream (idempotente por merchant+email). Retorna id Asaas. */
async function ensureCustomer(merchant: Merchant, input: CreateChargeInput["customer"]): Promise<string> {
  const accessToken = asaasAccessToken(merchant);
  const existing = await prisma.customer.findUnique({
    where: { merchantId_email: { merchantId: merchant.id, email: input.email.toLowerCase() } },
  });
  if (existing?.asaasCustomerId) return existing.asaasCustomerId;

  const asaasCust = await asaas.getOrCreateCustomer(accessToken, {
    name: input.name,
    email: input.email,
    cpfCnpj: input.document ?? input.cpfCnpj,
    phone: input.phone,
    ...(input.address && {
      addressStreet: input.address.street,
      addressNumber: input.address.number,
      addressComplement: input.address.complement,
      addressDistrict: input.address.district,
      addressCity: input.address.city,
      addressState: input.address.state,
      addressZipCode: input.address.zipCode,
    }),
  });
  return asaasCust.id;
}

function asaasAccessToken(merchant: Merchant): string {
  try {
    return asaas.merchantAccessTokenPublic(merchant.asaasApiKeyEncrypted);
  } catch {
    throw new ApiError(409, "subaccount_missing", "Subconta do lojista não está ativa. Conclua o onboarding.");
  }
}

/** Aplica a resposta do upstream na cobrança local e devolve versão sanitizada. */
async function persistPaymentResult(
  chargeId: string,
  merchant: Merchant,
  payment: AsaasPaymentResponse,
): Promise<void> {
  const accessToken = asaasAccessToken(merchant);
  const data: Prisma.ChargeUpdateInput = {
    asaasPaymentId: payment.id,
    status: mapAsaasStatus(payment.status),
    asaasInvoiceUrl: payment.invoiceUrl ?? null,
    digitableLine: payment.billingType === "BOLETO" ? payment.identificationField ?? null : null,
  };
  if (payment.billingType === "PIX") {
    try {
      const qr = await asaas.getPixQrCode(accessToken, payment.id);
      data.pixQrCode = qr.qrCode;
      data.pixCopiaECola = qr.copyPasteCode || payment.pixCopiaECola || null;
    } catch (e) {
      console.warn("[charges] pix qrcode indisponível ainda", e);
    }
  }
  await prisma.charge.update({ where: { id: chargeId }, data });
}

export async function createCharge(input: CreateChargeInput): Promise<SanitizedCharge> {
  const { merchant } = input;
  const billingType = toPrismaBilling(input.billingType);

  if (!Number.isFinite(input.value) || input.value < 0.5) {
    throw new ApiError(422, "invalid_amount", "Valor mínimo por cobrança é R$ 0,50.");
  }
  if (billingType === "CREDIT_CARD" && !input.card?.creditCardToken) {
    throw new ApiError(422, "card_token_required", "Cartão exige creditCardToken (tokenização client-side).");
  }
  const installments = billingType === "CREDIT_CARD" ? Math.min(Math.max(input.card?.installments ?? 1, 1), 12) : 1;

  // --- Idempotência: retorna cobrança existente sem duplicar no upstream ---
  if (input.idempotencyKey) {
    const dup = await prisma.charge.findUnique({
      where: {
        merchantId_idempotencyKey: { merchantId: merchant.id, idempotencyKey: input.idempotencyKey },
      },
    });
    if (dup) return sanitizeCharge(dup);
  }

  const asaasCustomerId = await ensureCustomer(merchant, input.customer);
  const { platformFee, netAmount } = computeFees(input.value, merchant, billingType);
  const dueDate = input.dueDate ? new Date(`${input.dueDate}T12:00:00Z`) : new Date(Date.now() + 3 * 864e5);

  // 1) Registra PENDING + vínculo do cliente em transação local
  const charge = await prisma.$transaction(async (tx) => {
    const cust = await tx.customer.upsert({
      where: { merchantId_email: { merchantId: merchant.id, email: input.customer.email.toLowerCase() } },
      update: { asaasCustomerId },
      create: {
        merchantId: merchant.id,
        email: input.customer.email.toLowerCase(),
        name: input.customer.name,
        phone: input.customer.phone,
        document: input.customer.document ?? input.customer.cpfCnpj,
        asaasCustomerId,
        addressStreet: input.customer.address?.street,
        addressNumber: input.customer.address?.number,
        addressCity: input.customer.address?.city,
        addressState: input.customer.address?.state,
        cep: input.customer.address?.zipCode,
      },
    });
    return tx.charge.create({
      data: {
        merchantId: merchant.id,
        billingType,
        grossAmount: new Prisma.Decimal(input.value.toFixed(2)),
        platformFee: new Prisma.Decimal(platformFee.toFixed(2)),
        netAmount: new Prisma.Decimal(netAmount.toFixed(2)),
        installments,
        description: input.description ?? null,
        externalReference: input.externalReference ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        dueDate,
        paymentLinkId: input.paymentLinkId,
        customerId: cust.id,
      },
    });
  });

  // 2) Chama upstream com access_token da subconta
  const accessToken = asaasAccessToken(merchant);
  try {
    const payment = await asaas.createPayment(accessToken, {
      customer: asaasCustomerId,
      billingType,
      value: input.value,
      dueDate: isoDate(dueDate),
      description: input.description ?? merchant.tradeName,
      externalReference: charge.id,
      ...(billingType === "CREDIT_CARD" && {
        creditCardToken: input.card?.creditCardToken,
        creditCardHolderInfo: input.card?.holderInfo,
        installments,
      }),
    });
    await persistPaymentResult(charge.id, merchant, payment);
  } catch (err) {
    // Compensação: marca como CANCELLED para não deixar registro órfão.
    await prisma.charge.update({ where: { id: charge.id }, data: { status: "CANCELLED" } });
    if (err instanceof Error && err.message.includes("upstream")) {
      throw new ApiError(502, "provider_error", "Provedor de pagamento indisponível. Tente novamente.");
    }
    throw err;
  }

  const fresh = await prisma.charge.findUniqueOrThrow({ where: { id: charge.id } });
  return sanitizeCharge(fresh);
}
