import { useMemo, useState } from "react";
import { api, type CustomerData, type PaymentLinkInfo } from "../api";
import { brl, installmentOptions } from "../format";
import {
  detectBrand, isValidCvv, isValidExpiry, luhnValid,
  maskCardNumber, maskExpiry, UNKNOWN_BRAND,
} from "../masks";

/** Badge SVG minimalista da bandeira (detecção imediata via BIN). */
function BrandBadge({ brand }: { brand: ReturnType<typeof detectBrand> }) {
  if (brand.key === "unknown") return null;
  const colors: Record<string, string> = {
    visa: "#1A1F71", mastercard: "#EB001B", amex: "#2E77BC", elo: "#003DA5",
    hipercard: "#C4181F", discover: "#FF6600", dinners: "#004A97",
  };
  return (
    <span
      className="ml-auto inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
      style={{ backgroundColor: colors[brand.key] ?? "#475569" }}
      data-testid="brand-badge"
    >
      {brand.label}
    </span>
  );
}

/** Formulário de cartão com máscara instantânea, validação local e tokenização client-side (PCI SAQ A: PAN/CVV nunca persistem no backend PayHub). */
export function CardForm({
  link, total, customer, onCharge, onError,
}: {
  link: PaymentLinkInfo;
  total: number;
  customer: CustomerData;
  onCharge: (token: string, installments: number) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const interestBps = link.fee_config?.interestBpsPerMonth ?? 0;
  const options = useMemo(() => installmentOptions(total, link.max_installments, interestBps), [total, link.max_installments, interestBps]);
  const [installments, setInstallments] = useState(1);
  const [number, setNumber] = useState("");
  const [holder, setHolder] = useState("");
  const [exp, setExp] = useState(""); // MM/AA
  const [ccv, setCcv] = useState("");
  const [busy, setBusy] = useState(false);

  const brand = useMemo(() => detectBrand(number), [number]);
  const selected = options.find((o) => o.n === installments) ?? options[0];

  const numberError =
    number.length >= 13 && !luhnValid(number) ? "Número de cartão inválido." : "";
  const expError = exp.length === 5 && !isValidExpiry(exp) ? "Validade expirada ou inválida." : "";
  const ccvError = ccv.length > 0 && !isValidCvv(ccv, brand) ? `CVV deve ter ${brand.codeLength} dígitos.` : "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!luhnValid(number) || !isValidExpiry(exp) || !isValidCvv(ccv, brand)) {
      onError("Revise os dados do cartão.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      const digits = number.replace(/\D/g, "");
      const [mm, yy] = exp.split("/");
      // Tokenização client-side: o PAN segue direto para o cofre do adquirente
      // via proxy sanitizado; o backend PayHub recebe apenas o token opaco.
      const { creditCardToken } = await api.tokenizeCard({
        holderName: holder || customer.name,
        number: digits,
        expiryMonth: mm ?? "01",
        expiryYear: yy ?? "30",
        ccv,
        cpfCnpj: (customer.document ?? "").replace(/\D/g, ""),
        email: customer.email,
      });
      await onCharge(creditCardToken, installments);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Falha ao processar cartão.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="cc-number">Número do cartão</label>
        <div className="relative">
          <input
            id="cc-number" required inputMode="numeric" autoComplete="cc-number"
            placeholder="0000 0000 0000 0000"
            value={number}
            onChange={(e) => setNumber(maskCardNumber(e.target.value))}
            className={`input pr-24 font-mono ${numberError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : ""}`}
            maxLength={brand.maxLength + 4 /* espaços */ > 23 ? 23 : brand.maxLength + 4}
          />
          <div className="absolute inset-y-0 right-2 flex items-center gap-1">
            <BrandBadge brand={brand} />
          </div>
        </div>
        {numberError && <p className="mt-1 text-xs text-red-500">{numberError}</p>}
      </div>
      <div>
        <label className="label" htmlFor="cc-holder">Nome impresso no cartão</label>
        <input id="cc-holder" required autoComplete="cc-name" value={holder}
               onChange={(e) => setHolder(e.target.value.toUpperCase())} className="input" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="cc-exp">Validade</label>
          <input id="cc-exp" required inputMode="numeric" autoComplete="cc-exp" placeholder="MM/AA"
                 value={exp} onChange={(e) => setExp(maskExpiry(e.target.value))}
                 className={`input font-mono ${expError ? "border-red-400" : ""}`} maxLength={5} />
          {expError && <p className="mt-1 text-xs text-red-500">{expError}</p>}
        </div>
        <div>
          <label className="label" htmlFor="cc-cvv">CVV ({brand === UNKNOWN_BRAND ? "3 ou 4" : brand.codeLength})</label>
          <input id="cc-cvv" required inputMode="numeric" autoComplete="cc-csc" placeholder={"•".repeat(brand.codeLength)}
                 value={ccv} onChange={(e) => setCcv(e.target.value.replace(/\D/g, "").slice(0, brand.codeLength))}
                 className={`input font-mono ${ccvError ? "border-red-400" : ""}`} maxLength={brand.codeLength} />
          {ccvError && <p className="mt-1 text-xs text-red-500">{ccvError}</p>}
        </div>
      </div>

      {/* Simulador visual de parcelamento 1x–12x com taxas transparentes */}
      <div>
        <label className="label">Parcelamento</label>
        <div role="radiogroup" aria-label="Escolha de parcelas"
             className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
          {options.map((o) => (
            <button
              key={o.n} type="button" role="radio" aria-checked={installments === o.n}
              onClick={() => setInstallments(o.n)}
              className={`rounded-lg border px-2.5 py-2 text-left text-xs transition ${
                installments === o.n
                  ? "border-brand-600 bg-brand-50 ring-2 ring-brand-100"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <span className="block font-semibold text-slate-800">{o.n}x de {brl(o.value)}</span>
              <span className={`block ${o.withInterest ? "text-amber-600" : "text-emerald-600"}`}>
                {o.withInterest ? "com juros" : "sem juros"} · total {brl(o.value * o.n)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <button type="submit" disabled={busy} className="btn-primary">
        {busy ? "Processando…" : `Pagar ${brl(selected.value * selected.n)}`}
      </button>
      <p className="flex items-center justify-center gap-1 text-center text-[11px] text-slate-400">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Pagamento criptografado. Seus dados de cartão não são armazenados pela loja.
      </p>
    </form>
  );
}
