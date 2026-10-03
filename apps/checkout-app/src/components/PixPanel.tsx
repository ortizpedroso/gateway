import { useEffect, useState } from "react";
import type { ChargeResult } from "../api";
import { api } from "../api";

/** Exibe QR Code dinâmico + copia-e-cola com polling de status a cada 4s. */
export function PixPanel({ charge, onPaid }: { charge: ChargeResult; onPaid: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stop = false;
    const t = setInterval(async () => {
      try {
        const s = await api.chargeStatus(charge.id);
        if (!stop && ["RECEIVED", "CONFIRMED"].includes(s.status)) { clearInterval(t); onPaid(); }
      } catch { /* mantém polling */ }
    }, 4_000);
    return () => { stop = true; clearInterval(t); };
  }, [charge.id, onPaid]);

  const copy = async () => {
    if (!charge.pix_copy_paste) return;
    await navigator.clipboard.writeText(charge.pix_copy_paste);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_500);
  };

  return (
    <div className="space-y-4 text-center">
      {charge.pix_qr_code ? (
        <img
          alt="QR Code Pix"
          className="mx-auto h-56 w-56 rounded-lg border border-slate-200"
          src={`https://api.qrserver.com/v1/create-qr-code/?size=224x224&data=${encodeURIComponent(charge.pix_qr_code)}`}
        />
      ) : null}
      <p className="text-sm text-slate-500">Escaneie o QR Code ou use o copia-e-cola. Confirmação automática.</p>
      <div className="flex items-center gap-2">
        <input readOnly value={charge.pix_copy_paste ?? ""} className="input font-mono text-xs" onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy} className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700">
          {copied ? "Copiado!" : "Copiar"}
        </button>
      </div>
      <div className="flex items-center justify-center gap-2 text-xs text-amber-600">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" /> Aguardando pagamento…
      </div>
    </div>
  );
}
