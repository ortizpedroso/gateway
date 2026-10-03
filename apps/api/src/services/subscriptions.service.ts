import { Prisma, type Merchant } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/http";
import { asaas } from "@/services/asaas.client";
import { computeFees, mapAsaasStatus } from "@/services/charges.service";

/** Recorrência: espelha subscriptions do upstream em modelo local. */

export interface CreateSubscriptionInput {
  merchant: Merchant;
  name: string;
  value: number;
  billingType: "PIX" | "CREDIT_CARD" | "BOLETO";
  recurrence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "YEARLY";
  maxCycles?: number;
  nextDueDate?: string; // yyyy-MM-dd
  customer: { name: string; email: string; document?: string; phone?: string };
  card?: { creditCardToken: string; holderInfo?: any };
}

export async function createSubscription(input: CreateSubscriptionInput) {
  const { merchant } = input;
  if (input.value < 0.5) throw new ApiError(422, "invalid_amount", "Valor mínimo da recorrência: R$ 0,50.");

  const accessToken = asaas.merchantAccessTokenPublic(merchant.asaasApiKeyEncrypted);

  // Customer upstream
  const cust = await asaas.getOrCreateCustomer(accessToken, {
    name: input.customer.name,
    email: input.customer.email,
    cpfCnpj: input.customer.document,
    phone: input.customer.phone,
  });

  const sub = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.upsert({
      where: { merchantId_email: { merchantId: merchant.id, email: input.customer.email.toLowerCase() } },
      update: { asaasCustomerId: cust.id },
      create: {
        merchantId: merchant.id,
        email: input.customer.email.toLowerCase(),
        name: input.customer.name,
        document: input.customer.document,
        phone: input.customer.phone,
        asaasCustomerId: cust.id,
      },
    });
    return tx.subscription.create({
      data: {
        merchantId: merchant.id,
        customerId: customer.id,
        name: input.name,
        value: new Prisma.Decimal(input.value.toFixed(2)),
        billingType: input.billingType,
        recurrence: input.recurrence,
        maxCycles: input.maxCycles ?? null,
        nextDueDate: input.nextDueDate ? new Date(`${input.nextDueDate}T12:00:00Z`) : null,
      },
    });
  });

  try {
    const upstream = await asaas.createSubscription(accessToken, {
      customer: cust.id,
      billingType: input.billingType,
      value: input.value,
      cycle: input.recurrence === "MONTHLY" ? "MONTHLY" : (input.recurrence as any),
      nextDueDate: input.nextDueDate,
      maxPayments: input.maxCycles,
      description: `${merchant.tradeName} — ${input.name}`,
      ...(input.billingType === "CREDIT_CARD" && {
        creditCardToken: input.card?.creditCardToken,
        creditCardHolderInfo: input.card?.holderInfo,
      }),
    });
    return await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        asaasSubscriptionId: upstream.id,
        status: upstream.status === "ACTIVE" ? "ACTIVE" : "PENDING",
        nextDueDate: upstream.nextDueDate ? new Date(upstream.nextDueDate) : sub.nextDueDate,
      },
    });
  } catch (err) {
    await prisma.subscription.delete({ where: { id: sub.id } });
    throw new ApiError(502, "provider_error", "Falha ao criar assinatura no provedor de pagamento.");
  }
}

export async function cancelSubscription(merchant: Merchant, subscriptionId: string) {
  const sub = await prisma.subscription.findFirst({ where: { id: subscriptionId, merchantId: merchant.id } });
  if (!sub) throw new ApiError(404, "subscription_not_found", "Assinatura não encontrada.");
  if (sub.asaasSubscriptionId) {
    const accessToken = asaas.merchantAccessTokenPublic(merchant.asaasApiKeyEncrypted);
    await asaas.cancelSubscription(accessToken, sub.asaasSubscriptionId);
  }
  return prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}

// Re-export para uso no handler de webhooks (dedupe de status de cobrança)
export { mapAsaasStatus, computeFees };
