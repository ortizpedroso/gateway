import { prisma } from "@/lib/prisma";

/**
 * Fiscal Engine — Driver Pattern para provedores de mensageria fiscal
 * (Focus NFe, PlugNotas, e-Notas). A plataforma seleciona o driver via
 * env FISCAL_PROVIDER; cada driver implementa `issueNfse` com contrato único.
 */

export interface FiscalIssueRequest {
  invoiceId: string; // id interno da Invoice
  merchantId: string;
  chargeId: string;
  providerMerchantId?: string; // id do serviço no provedor (config por merchant)
  serviceValue: number;
  description: string;
  issueDate: string; // ISO
  customer: { name: string; email: string; document?: string };
  merchant: { legalName: string; document: string; city?: string | null; state?: string | null };
}

export interface FiscalIssueResult {
  provider: string;
  number: string; // número da NFS-e
  key?: string; // chave de acesso
  xmlUrl?: string;
  pdfUrl?: string; // URL DN — sanitizada pela camada chamadora se necessário
}

export interface FiscalDriver {
  readonly name: string;
  issueNfse(req: FiscalIssueRequest): Promise<FiscalIssueResult>;
  cancelNfse?(providerRef: string, reason: string): Promise<void>;
}

// ------------------------------ Focus NFe ----------------------------------

class FocusNFeDriver implements FiscalDriver {
  readonly name = "focusnfe";
  private base = "https://api.focusnfe.com.br/v2";

  async issueNfse(req: FiscalIssueRequest): Promise<FiscalIssueResult> {
    const res = await fetch(`${this.base}/nfse?ref=${req.invoiceId}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.FOCUS_NFE_API_KEY}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prestacao: {
          municipio: req.merchant.city ?? "",
          valor_servicos: req.serviceValue.toFixed(2),
          descricao: req.description,
          data_execucao: req.issueDate.slice(0, 10),
          tomador: [{ nome: req.customer.name, email: req.customer.email, cpf_cnpj: req.customer.document }],
        },
      }),
    });
    const json: any = await res.json();
    if (!res.ok) throw new Error(`focusnfe_http_${res.status}:${JSON.stringify(json)}`);
    return {
      provider: this.name,
      number: String(json.numero ?? json.rps ?? req.invoiceId),
      key: json.chave ?? json.verify_code,
      xmlUrl: json.xml_url,
      pdfUrl: json.danfe_url ?? json.link,
    };
  }
}

// ------------------------------ PlugNotas ----------------------------------

class PlugNotasDriver implements FiscalDriver {
  readonly name = "plugnotas";
  private base = "https://plugnotas.com.br/api";

  async issueNfse(req: FiscalIssueRequest): Promise<FiscalIssueResult> {
    const res = await fetch(`${this.base}/nota_fiscal.nova_nfe.json?access_token=${process.env.PLUGNOTAS_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nota_fiscal: {
          tipo_documento: "RPS",
          natureza_operacao: "NACIONAL",
          tipo_operacao: "SAIDA",
          cliente: { nome: req.customer.name, email: req.customer.email, cpf_cnpj: req.customer.document },
          produtos_servicos: [
            { quantidade: 1, valor_unitario: req.serviceValue, codigo: "1001", descricao: req.description },
          ],
        },
      }),
    });
    const json: any = await res.json();
    const nf = json?.nota_fiscal;
    if (!res.ok || !nf) throw new Error(`plugnotas_http_${res.status}:${JSON.stringify(json)}`);
    return {
      provider: this.name,
      number: String(nf.chave ? nf.chave.slice(-11) : req.invoiceId),
      key: nf.chave,
      pdfUrl: nf.caminho_danfe,
    };
  }
}

// ------------------------------- e-Notas -----------------------------------

class ENotasDriver implements FiscalDriver {
  readonly name = "enotas";
  private base = "https://producao.enotas.com.br/api/v1";

  async issueNfse(req: FiscalIssueRequest): Promise<FiscalIssueResult> {
    const form = new URLSearchParams();
    form.set("tokenAmbiente", process.env.ENOTAS_API_TOKEN ?? "");
    form.set("cpfCnpjRemetente", req.merchant.document.replace(/\D/g, ""));
    form.set("cpfCnpjDestinatario", (req.customer.document ?? "").replace(/\D/g, ""));
    form.set("emailDestinatario", req.customer.email);
    form.set("servicoValor", req.serviceValue.toFixed(2));
    form.set("servicoDescricao", req.description);
    form.set("referencia", req.invoiceId);

    const res = await fetch(`${this.base}/nfse/criar`, { method: "POST", body: form });
    const json: any = await res.json();
    if (!res.ok || json?.erro) throw new Error(`enotas_error:${JSON.stringify(json)}`);
    return {
      provider: this.name,
      number: String(json.nfseCodigo ?? req.invoiceId),
      key: json.nfseChave,
      pdfUrl: json.danfeUrl ?? json.xmlUrl,
    };
  }
}

// ------------------------------ Registry ------------------------------------

const drivers: Record<string, FiscalDriver> = {
  focusnfe: new FocusNFeDriver(),
  plugnotas: new PlugNotasDriver(),
  enotas: new ENotasDriver(),
};

export function getFiscalDriver(name?: string): FiscalDriver {
  const key = (name ?? process.env.FISCAL_PROVIDER ?? "focusnfe").toLowerCase();
  const driver = drivers[key];
  if (!driver) throw new Error(`Driver fiscal desconhecido: ${key}`);
  return driver;
}

/** Emite NFS-e para uma Invoice já criada e atualiza o registro. */
export async function issueInvoice(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { merchant: true, charge: { include: { customer: true } } },
  });
  if (!invoice) throw new Error("Invoice não encontrada.");
  if (invoice.status === "ISSUED") return; // idempotência
  if (!invoice.charge) throw new Error("Invoice sem cobrança vinculada.");

  const driver = getFiscalDriver(invoice.provider);
  try {
    const result = await driver.issueNfse({
      invoiceId: invoice.id,
      merchantId: invoice.merchantId,
      chargeId: invoice.chargeId!,
      serviceValue: Number(invoice.charge.grossAmount),
      description: invoice.charge.description ?? `Serviço prestado — ${invoice.merchant.tradeName}`,
      issueDate: (invoice.charge.confirmedAt ?? new Date()).toISOString(),
      customer: {
        name: invoice.charge.customer?.name ?? "Cliente",
        email: invoice.charge.customer?.email ?? invoice.merchant.email,
        document: invoice.charge.customer?.document ?? undefined,
      },
      merchant: {
        legalName: invoice.merchant.legalName,
        document: invoice.merchant.document,
        city: invoice.merchant.city,
        state: invoice.merchant.state,
      },
    });
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "ISSUED",
        number: result.number,
        key: result.key,
        xmlUrl: result.xmlUrl,
        pdfUrl: result.pdfUrl,
        issuedAt: new Date(),
        errorMessage: null,
      },
    });
  } catch (err) {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "ERROR", errorMessage: String(err).slice(0, 500) },
    });
    throw err;
  }
}
