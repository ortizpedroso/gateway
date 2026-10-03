import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type BillingMethod, type ChargeResult, type CustomerData, type PaymentLinkInfo } from "./api";
import { brl } from "./format";
import { PixPanel } from "./components/PixPanel";
import { BoletoPanel } from "./components/BoletoPanel";
import { CardForm } from "./components/CardForm";

type Phase = "form" | "instruction" | "paid" | "error";

function slugFromUrl(): string {
  // Produção: /pay/{slug} (SSR Next monta a SPA). Dev: ?slug=demo
  const m = window.location.pathname.match(/\/pay\/([\w-]+)/);
  if (m) return m[1];
  return document.getElementById("checkout-root")?.getAttribute("data-slug")
    ?? new URLSearchParams(window.location.search).get("slug") ?? "";
}

export default function App() {
  const [link, setLink] = useState<PaymentLinkInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [method, setMethod] = useState<BillingMethod>("PIX");
  const [customAmount, setCustomAmount] = useState("");
  const [customer, setCustomer] = useState<CustomerData>({ name: "", email: "", phone: "", document: "" });
  const [phase, setPhase] = useState<Phase>("form");
  const [charge, setCharge] = useState<ChargeResult | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const slug = slugFromUrl();
    if (!slug) { setLoadError("Link de pagamento inválido."); return; }
    api.getLink(slug)
      .then((l) => {
        setLink(l);
        const methods = l.available_methods as BillingMethod[];
        setMethod(methods[0] ?? "PIX");
        document.title = `Pagamento · ${l.store.name}`;
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Falha ao carregar link."));
  }, []);

  const amount = useMemo(() => {
    if (!link) return 0;
    if (link.allow_custom_amount) return parseFloat(customAmount.replace(",", ".")) || 0;
    return link.amount;
  }, [link, customAmount]);

  const createCharge = useCallback(async (payload: Parameters<typeof api.createCharge>[0]) => {
    setBusy(true); setSubmitError("");
    try {
      const c = await api.createCharge(payload);
      setCharge(c);
      setPhase("instruction");
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Não foi possível criar a cobrança.");
    } finally { setBusy(false); }
  }, []);

  const payPix = () => createCharge({ paymentLinkId: link!.id, billingType: "PIX", value: amount || undefined, customer });
  const payBoleto = () => createCharge({ paymentLinkId: link!.id, billingType: "BOLETO", value: amount || undefined, customer });
  const payCard = async (token: string, installments: number) =>
    createCharge({ paymentLinkId: link!.id, billingType: "CREDIT_CARD", value: amount || undefined, creditCardToken: token, installments, customer });

  if (loadError) return <Shell storeName="Checkout"><p className="text-center text-sm text-red-600">{loadError}</p></Shell>;
  if (!link) return <Shell storeName="…"><p className="text-center text-sm text-slate-400">Carregando checkout…</p></Shell>;

  const methods = link.available_methods as BillingMethod[];

  return (
    <Shell storeName={link.store.name}>
      {phase === "paid" ? (
        <div className="space-y-3 py-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-2xl">✓</div>
          <h2 className="text-lg font-semibold text-slate-900">Pagamento aprovado!</h2>
          <p className="text-sm text-slate-500">O comprovante foi enviado para {customer.email}.</p>
        </div>
      ) : phase === "instruction" && charge ? (
        <div className="space-y-5">
          <h2 className="text-base font-semibold text-slate-900">Quase lá — finalize o pagamento</h2>
          {charge.method === "PIX" ? <PixPanel charge={charge} onPaid={() => setPhase("paid")} /> : null}
          {charge.method === "BOLETO" ? <BoletoPanel charge={charge} /> : null}
          {charge.method === "CREDIT_CARD" ? (
            <div className="rounded-lg bg-green-50 p-4 text-sm text-green-800">
              Pagamento processado. Status atual: <b>{charge.status}</b>. Você será redirecionado assim que confirmado.
            </div>
          ) : null}
          <button onClick={() => { setPhase("form"); setCharge(null); }} className="text-xs text-slate-400 underline">
            Voltar e pagar de outro jeito
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          <header className="space-y-1">
            <h1 className="text-lg font-semibold text-slate-900">{link.title}</h1>
            {link.description ? <p className="text-sm text-slate-500">{link.description}</p> : null}
            {!link.allow_custom_amount ? <p className="text-xl font-bold text-brand-700">{brl(link.amount)}</p> : null}
          </header>

          {link.allow_custom_amount ? (
            <div>
              <label className="label">Valor a pagar (R$)</label>
              <input className="input" inputMode="decimal" placeholder="0,00" value={customAmount}
                     onChange={(e) => setCustomAmount(e.target.value)} />
            </div>
          ) : null}

          <div>
            <label className="label">Método de pagamento</label>
            <div className="grid grid-cols-3 gap-2">
              {(["PIX", "CREDIT_CARD", "BOLETO"] as BillingMethod[])
                .filter((m) => methods.includes(m))
                .map((m) => (
                  <button key={m} type="button" onClick={() => setMethod(m)}
                    className={`rounded-lg border px-2 py-3 text-xs font-semibold transition ${
                      method === m ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500 hover:border-slate-300"}`}>
                    {m === "PIX" ? "Pix" : m === "CREDIT_CARD" ? "Cartão" : "Boleto"}
                  </button>
                ))}
            </div>
          </div>

          <div className="space-y-3">
            <div><label className="label">Nome completo</label>
              <input required className="input" value={customer.name}
                     onChange={(e) => setCustomer({ ...customer, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">E-mail</label>
                <input required type="email" className="input" value={customer.email}
                       onChange={(e) => setCustomer({ ...customer, email: e.target.value })} /></div>
              <div><label className="label">CPF</label>
                <input required placeholder="000.000.000-00" className="input" value={customer.document ?? ""}
                       onChange={(e) => setCustomer({ ...customer, document: e.target.value })} /></div>
            </div>
          </div>

          {submitError ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{submitError}</p> : null}

          {method === "CREDIT_CARD" ? (
            <CardForm link={link} total={amount} customer={customer} onCharge={payCard} onError={setSubmitError} />
          ) : (
            <button className="btn-primary" disabled={busy || amount <= 0}
                    onClick={() => (method === "PIX" ? payPix() : payBoleto())}>
              {busy ? "Gerando…" : method === "PIX" ? `Pagar ${amount > 0 ? brl(amount) : ""} com Pix` : "Gerar boleto"}
            </button>
          )}
        </div>
      )}
      <footer className="mt-6 border-t border-slate-100 pt-3 text-center text-[11px] text-slate-400">
        Ambiente seguro · {link.store.name} · Powered by PayHub
      </footer>
    </Shell>
  );
}

function Shell({ storeName, children }: { storeName: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="card w-full max-w-md">
        <p className="mb-4 text-center text-xs font-medium uppercase tracking-widest text-slate-400">{storeName}</p>
        {children}
      </div>
    </main>
  );
}
