import { decryptSecret } from "@/lib/crypto";

/**
 * Client de integração com a Asaas API v3 (conta master marketplace).
 *
 * Isolamento de contas: toda chamada de cobrança usa o `access_token`
 * (api key) da SUBCONTA do merchant — nunca a chave master, exceto nas
 * operações administrativas de onboarding (/v3/accounts).
 *
 * Regra white-label: NENHUMA resposta deste client é repassada ao pagador
 * final ou ao lojista sem antes ser sanitizada pela camada de serviço.
 */

export class AsaasError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AsaasError";
  }
}

// ------------------------------ Tipos upstream -----------------------------

export interface AsaasAccountInput {
  name: string;
  email: string;
  document: string; // CNPJ/CPF somente dígitos
  type: "COMPANY" | "INDIVIDUAL";
  mobilePhone?: string;
  city?: number;
  state?: string;
  country?: string;
  streetType?: string;
  street?: string;
  number?: string;
  district?: string;
  complement?: string;
  zipCode?: string;
}

export interface AsaasAccountResponse {
  id: string; // hash da subconta
  apiKeyToken: string; // access_token da subconta (retornado 1x)
  status?: string;
  [k: string]: unknown;
}

export interface AsaasCustomerInput {
  name: string;
  email: string;
  cpfCnpj?: string;
  phone?: string;
  externalReference?: string;
  addressStreet?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressDistrict?: string;
  addressCity?: string;
  addressState?: string;
  addressZipCode?: string;
}

export type AsaasBillingType = "PIX" | "CREDIT_CARD" | "BOLETO";

export interface AsaasPaymentInput {
  customer: string; // id Asaas do cliente
  billingType: AsaasBillingType;
  value: number;
  dueDate: string; // yyyy-MM-dd
  description?: string;
  externalReference?: string;
  creditCardToken?: string; // tokenização transparente
  creditCardHolderInfo?: {
    name: string;
    email: string;
    cpfCnpj: string;
    phone: string;
    birthDate?: string;
    addressPostalCode: string;
    addressStreet: string;
    addressNumber: string;
    addressComplement?: string;
    addressDistrict: string;
    addressCity: string;
    addressState: string;
  };
  installments?: number; // 1..12
  pixQrCodeExpirationIntervalSeconds?: number;
  interestOverdue?: number;
  discountDates?: Array<{ value: number; date: string }>;
}

export interface AsaasPaymentResponse {
  id: string;
  status: string;
  invoiceUrl?: string; // boleto PDF (URL upstream — sanitizar!)
  bankInvoiceUrl?: string;
  qrCodeUrl?: string;
  pixCopiaECola?: string;
  identificationField?: string; // linha digitável / copia-e-cola
  totalValue: number;
  netValue: number;
  dueDate: string;
  [k: string]: unknown;
}

export interface AsaasSubscriptionInput {
  customer: string;
  billingType: AsaasBillingType;
  value: number;
  cycle: "MONTHLY" | "WEEKLY" | "BIWEEKLY" | "QUARTERLY" | "SEMIANNUAL" | "YEARLY";
  nextDueDate?: string;
  description?: string;
  endDate?: string;
  maxPayments?: number;
  creditCardToken?: string;
  creditCardHolderInfo?: AsaasPaymentInput["creditCardHolderInfo"];
}

export interface AsaasSubscriptionResponse {
  id: string;
  status: string;
  nextDueDate: string;
  [k: string]: unknown;
}

export interface AsaasWebhookInput {
  url: string;
  authToken?: string;
  autoRetry?: boolean;
  events: string[];
  kind?: string[];
}

// ------------------------------- O client ----------------------------------

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  formData?: FormData;
  /** access_token da SUBCONTA do merchant (isolamento de contas). */
  accessToken: string;
}

export class AsaasClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.ASAAS_BASE_URL ?? "https://api.asaas.com/v3").replace(/\/$/, "");
  }

  /** Chave master — SOMENTE para gestão de subcontas (onboarding/KYC). */
  static masterApiKey(): string {
    const key = process.env.ASAAS_MASTER_API_KEY;
    if (!key) throw new AsaasError(0, "config", "ASAAS_MASTER_API_KEY ausente.");
    return key;
  }

  /** Resolve o access_token criptografado da subconta de um merchant. */
  static merchantAccessToken(asaasApiKeyEncrypted: string | null | undefined): string {
    if (!asaasApiKeyEncrypted) {
      throw new AsaasError(0, "no_subaccount", "Merchant sem subconta Asaas criada.");
    }
    return decryptSecret(asaasApiKeyEncrypted);
  }

  /** Alias de instância para conveniência das camadas de serviço. */
  merchantAccessTokenPublic(asaasApiKeyEncrypted: string | null | undefined): string {
    return AsaasClient.merchantAccessToken(asaasApiKeyEncrypted);
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      access_token: opts.accessToken,
      Accept: "application/json",
    };
    let body: BodyInit | undefined;
    if (opts.formData) {
      body = opts.formData; // multipart: o fetch define o boundary
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(`${this.baseUrl}${opts.path}`, {
      method: opts.method ?? "POST",
      headers,
      body,
      cache: "no-store",
    });

    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* resposta não-JSON */
    }

    if (!res.ok) {
      throw new AsaasError(
        res.status,
        json?.errors?.[0]?.code ?? json?.type,
        `Falha na upstream payment provider (HTTP ${res.status}).`,
        json?.errors ?? text,
      );
    }
    return json as T;
  }

  // --------------------------- Onboarding / KYC ----------------------------

  /** POST /v3/accounts — cria a subconta e retorna apiKeyToken (1x apenas). */
  async createSubAccount(input: AsaasAccountInput): Promise<AsaasAccountResponse> {
    return this.request({
      method: "POST",
      path: "/accounts",
      body: input,
      accessToken: AsaasClient.masterApiKey(),
    });
  }

  /** Upload multipart de documento KYC: fileUpload -> POST /accounts/{id}/documents */
  async uploadKycDocument(
    accountId: string,
    file: { bytes: ArrayBuffer | Buffer; fileName: string; mimeType: string },
    type: "CONTRACT" | "SIMPLIFIED_STATEMENT" | "ARTICLES_OF_INCORPORATION" | "BANK_PROOF" | "SOCIAL_CONTRACT",
  ): Promise<void> {
    const form = new FormData();
    const blob = new Blob([file.bytes as ArrayBuffer | Uint8Array] as BlobPart[], { type: file.mimeType });
    form.append("file", blob, file.fileName);
    // 1) Envia arquivo -> retorna id do upload
    const uploaded = await this.request<{ id: string }>({
      method: "POST",
      path: "/file/upload?isPrivate=true",
      formData: form,
      accessToken: AsaasClient.masterApiKey(),
    });
    // 2) Vincula o documento à subconta
    await this.request({
      method: "POST",
      path: `/accounts/${accountId}/documents`,
      body: { type, files: [uploaded.id] },
      accessToken: AsaasClient.masterApiKey(),
    });
  }

  /** GET /accounts/{id} — consulta status de aprovação da subconta. */
  async getSubAccount(accountId: string): Promise<Record<string, unknown>> {
    return this.request({
      method: "GET",
      path: `/accounts/${accountId}`,
      accessToken: AsaasClient.masterApiKey(),
    });
  }

  /** Configura webhook ACCOUNT_STATUS_CHANGED + PAYMENT_* na subconta. */
  async configureWebhook(
    accountId: string,
    input: AsaasWebhookInput & { accessToken: string },
  ): Promise<{ id: string }> {
    const { accessToken, ...payload } = input;
    return this.request({ method: "POST", path: "/webhooks", body: payload, accessToken });
  }

  // ------------------------------ Cobranças --------------------------------

  /** POST /v3/payments — Pix, Cartão (token) ou Boleto, na subconta do merchant. */
  async createPayment(accessToken: string, input: AsaasPaymentInput): Promise<AsaasPaymentResponse> {
    return this.request({ method: "POST", path: "/payments", body: input, accessToken });
  }

  async getPayment(accessToken: string, paymentId: string): Promise<AsaasPaymentResponse> {
    return this.request({ method: "GET", path: `/payments/${paymentId}`, accessToken });
  }

  /** GET /pixConnect/{paymentId} — QR Code dinâmico do Pix (copia-e-cola). */
  async getPixQrCode(accessToken: string, paymentId: string): Promise<{ qrCode: string; copyPasteCode: string }> {
    const json = await this.request<{ qrCode?: string; copyPasteCode?: string; copiaECola?: string }>({
      method: "GET",
      path: `/payments/${paymentId}/pixQrCode`,
      accessToken,
    });
    return {
      qrCode: json.qrCode ?? "",
      copyPasteCode: json.copyPasteCode ?? json.copiaECola ?? "",
    };
  }

  /** POST /v3/payments/{id}/refund — estorno total/parcial. */
  async refundPayment(accessToken: string, paymentId: string, value?: number): Promise<Record<string, unknown>> {
    return this.request({
      method: "POST",
      path: `/payments/${paymentId}/refund`,
      body: value ? { value } : {},
      accessToken,
    });
  }

  // ------------------------------ Clientes ---------------------------------

  async getOrCreateCustomer(accessToken: string, input: AsaasCustomerInput): Promise<{ id: string }> {
    return this.request({ method: "POST", path: "/customers", body: input, accessToken });
  }

  // ---------------------------- Assinaturas --------------------------------

  /** POST /v3/subscriptions — recorrência na subconta do merchant. */
  async createSubscription(
    accessToken: string,
    input: AsaasSubscriptionInput,
  ): Promise<AsaasSubscriptionResponse> {
    return this.request({ method: "POST", path: "/subscriptions", body: input, accessToken });
  }

  async cancelSubscription(accessToken: string, subscriptionId: string): Promise<AsaasSubscriptionResponse> {
    return this.request({ method: "POST", path: `/subscriptions/${subscriptionId}/cancel`, body: {}, accessToken });
  }

  // ------------------------- Tokenização cartão ----------------------------

  /**
   * POST /v3/credit-card/token — tokeniza dados do cartão (chamada feita
   * APENAS server-side via nosso proxy; os PANs nunca são persistidos).
   */
  async tokenizeCreditCard(
    accessToken: string,
    input: {
      holderName: string;
      number: string;
      expiryMonth: string; // MM
      expiryYear: string; // YY
      ccv: string;
      cpfCnpj: string;
      email: string;
    },
  ): Promise<{ creditCardToken: string }> {
    return this.request({ method: "POST", path: "/credit-card/token", body: input, accessToken });
  }
}

export const asaas = new AsaasClient();
