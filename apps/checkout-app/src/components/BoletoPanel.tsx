import { useState } from "react";
import type { ChargeResult } from "../api";

/** Boleto: linha digitável com cópia + download do PDF pela nossa URL (white-label). */
export function BoletoPanel({ charge }: { charge: ChargeResult }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!charge.digitable_line) return;
    await navigator.clipboard.writeText(charge.digitable_line);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_500);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Pague no banco de sua preferência até o vencimento. A compensação pode levar até 3 dias úteis.</p>
      <div className="flex items-center gap-2">
        <input readOnly value={charge.digitable_line ?? ""} className="input font-mono text-xs" onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy} className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700">
          {copied ? "Copiado!" : "Copiar"}
        </button>
      </div>
      {charge.boleto_pdf_url ? (
        <a href={charge.boleto_pdf_url} target="_blank" rel="noreferrer"
           className="btn-primary !bg-slate-800 hover:!bg-slate-900">
          Baixar boleto em PDF
        </a>
      ) : null}
    </div>
  );
}
