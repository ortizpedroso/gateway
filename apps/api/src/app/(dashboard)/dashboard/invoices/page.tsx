import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireMerchant } from "@/lib/session";

export const dynamic = "force-dynamic";

const statusTone: Record<string, string> = {
  ISSUED: "bg-emerald-100 text-emerald-700",
  QUEUED: "bg-amber-100 text-amber-700",
  ERROR: "bg-rose-100 text-rose-700",
  DRAFT: "bg-slate-100 text-slate-500",
  CANCELLED: "bg-slate-100 text-slate-400 line-through",
};

export default async function InvoicesPage() {
  const merchant = await requireMerchant();
  const invoices = await prisma.invoice.findMany({
    where: { merchantId: merchant.id },
    include: { charge: { select: { id: true, grossAmount: true, billingType: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-brand-900">Notas Fiscais (NFS-e)</h1>
      <p className="text-sm text-slate-500">Emissão automática ao confirmar pagamento · driver: {process.env.FISCAL_PROVIDER ?? "focusnfe"}</p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b text-left text-xs uppercase text-slate-400">
            <th className="pb-2">Número</th><th className="pb-2">Cobrança</th><th className="pb-2 text-right">Valor</th>
            <th className="pb-2">Emitida em</th><th className="pb-2">Status</th><th className="pb-2 text-right">Ações</th>
          </tr></thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-b border-slate-100">
                <td className="py-2 font-mono">{inv.number ?? "—"}</td>
                <td className="py-2 font-mono text-xs">{inv.charge?.id.slice(0, 12)}</td>
                <td className="py-2 text-right tabular-nums">{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(inv.charge?.grossAmount ?? 0))}</td>
                <td className="py-2">{inv.issuedAt?.toLocaleDateString("pt-BR") ?? "—"}</td>
                <td className="py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${statusTone[inv.status] ?? ""}`}>{inv.status}</span></td>
                <td className="py-2 text-right">
                  {inv.status === "ISSUED" && (
                    <Link href={`/dashboard/invoices/${inv.id}/pdf`} className="text-brand-600 hover:underline">Baixar PDF</Link>
                  )}
                  {inv.status === "ERROR" && <span className="text-xs text-rose-500" title={inv.errorMessage ?? ""}>ver log</span>}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">Nenhuma nota emitida ainda.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
