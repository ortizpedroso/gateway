/** Cliente HTTP da API pública da plataforma (nunca fala com o upstream). */

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export type BillingMethod = "PIX" | "CREDIT_CARD" | "BOLETO";

export interface PaymentLinkInfo {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  amount: number;
  allow_custom_amount: boolean;
  available_methods: BillingMethod[];
  max_installments: number;
  fee_config: { interestBpsPerMonth?: number } | null;
  due_date: string | null;
  store: { name: string; logoUrl: string | null };
}

export interface ChargeResult {
  id: string;
  status: string;
  method: BillingMethod;
  amount: number;
  installments: number;
  pix_qr_code?: string | null;
  pix_copy_paste?: string | null;
  digitable_line?: string | null;
  boleto_pdf_url?: string | null;
}

export interface CustomerData {
  name: string;
  email: string;
  phone?: string;
  document?: string;
  address?: {
    street: string; number: string; complement?: string;
    district: string; city: string; state: string; zipCode: string;
  };
}

/** UUIDv4 sem dependências (crypto.randomUUID com fallback). */
export function uuidv4(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Publishable-Key": publishableKey(),
      // Idempotency-Key por tentativa de escrita (retries do navegador não duplicam cobrança)
      ...(init.method === "POST" ? { "Idempotency-Key": uuidv4() } : {}),
      ...(init.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message ?? `Erro ${res.status}`);
  return json as T;
}

function publishableKey(): string {
  // Injetado pelo SSR da página /pay/{slug} (data-pk) ou por env em dev.
  const el = document.getElementById("checkout-root");
  return el?.getAttribute("data-pk") ?? (import.meta.env.VITE_PUBLISHABLE_KEY as string) ?? "";
}

export const api = {
  getLink: (slug: string) => request<PaymentLinkInfo>(`/api/v1/public/pay/${slug}`),

  createCharge: (payload: {
    paymentLinkId: string;
    billingType: BillingMethod;
    value?: number;
    installments?: number;
    creditCardToken?: string;
    customer: CustomerData;
  }) => request<ChargeResult>("/api/v1/public/charges", { method: "POST", body: JSON.stringify(payload) }),

  tokenizeCard: (card: {
    holderName: string; number: string; expiryMonth: string; expiryYear: string;
    ccv: string; cpfCnpj: string; email: string;
  }) => request<{ creditCardToken: string }>("/api/v1/public/credit-card/tokenize", {
    method: "POST", body: JSON.stringify(card),
  }),

  chargeStatus: (id: string) => request<{ id: string; status: string }>(`/api/v1/public/charges/${id}/status`),
};
