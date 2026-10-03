import { prisma } from "@/lib/prisma";
import { requireMerchant } from "@/lib/session";

export const dynamic = "force-dynamic";

const brl = (v: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

export default async function SubscriptionsPage() {
  const merchant = await requireMerchant();
  const subs = await prisma.subscription.findMany({
    where: { merchantId: merchant.id },
    include: { customer: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-brand-900">Assinaturas & Recorrência</h1>
        <p className="text-sm text-slate-500">Crie mensalidades via API: POST /api/v1/subscriptions</p>
      </header>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b text-left text-xs uppercase text-slate-400">
            <th className="pb-2">Plano</th><th className="pb-2">Cliente</th><th className="pb-2">Método</th>
            <th className="pb-2 text-right">Valor</th><th className="pb-2">Próx. cobrança</th><th className="pb-2">Status</th>
          </tr></thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-2 font-medium">{s.name}</td>
                <td className="py-2">{s.customer.name}</td>
                <td className="py-2">{s.billingType}</td>
                <td className="py-2 text-right tabular-nums">{brl(s.value)}</td>
                <td className="py-2">{s.nextDueDate?.toLocaleDateString("pt-BR") ?? "—"}</td>
                <td className="py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${s.status === "ACTIVE" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{s.status}</span></td>
              </tr>
            ))}
            {subs.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">Nenhuma assinatura criada.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
