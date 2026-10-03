import { prisma } from "@/lib/prisma";
import { requireMerchant } from "@/lib/session";

export const dynamic = "force-dynamic";

const brl = (v: unknown) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

/** Gráfico de barras simples em Tailwind — receita por método (90 dias). */
function RevenueByMethodChart({ data }: { data: Array<{ method: string; total: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.method}>
          <div className="mb-1 flex justify-between text-sm">
            <span className="font-medium capitalize text-slate-600">{d.method}</span>
            <span className="tabular-nums text-slate-500">{brl(d.total)}</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-slate-100">
            <div className="h-2.5 rounded-full bg-brand-500" style={{ width: `${(d.total / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function DashboardPage() {
  const merchant = await requireMerchant();
  const since = new Date(Date.now() - 90 * 864e5);

  const [gross, fees, confirmedAgg, pendingAgg, overdueAgg, byMethod, recent] = await Promise.all([
    prisma.charge.aggregate({
      where: { merchantId: merchant.id, status: { in: ["CONFIRMED", "RECEIVED"] }, createdAt: { gte: since } },
      _sum: { grossAmount: true, netAmount: true, platformFee: true },
    }),
    prisma.charge.aggregate({
      where: { merchantId: merchant.id, status: { in: ["CONFIRMED", "RECEIVED"] }, createdAt: { gte: since } },
      _sum: { platformFee: true },
    }),
    prisma.charge.count({ where: { merchantId: merchant.id, status: "CONFIRMED" } }),
    prisma.charge.aggregate({
      where: { merchantId: merchant.id, status: { in: ["PENDING", "RECEIVED"] } },
      _sum: { netAmount: true },
    }),
    prisma.charge.aggregate({
      where: { merchantId: merchant.id, status: "OVERDUE" },
      _sum: { grossAmount: true },
      _count: true,
    }),
    prisma.charge.groupBy({
      by: ["billingType"],
      where: { merchantId: merchant.id, status: { in: ["CONFIRMED", "RECEIVED"] }, createdAt: { gte: since } },
      _sum: { grossAmount: true },
    }),
    prisma.charge.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { customer: { select: { name: true, email: true } } },
    }),
  ]);

  const cards = [
    { label: "Faturamento bruto (90d)", value: brl(gross._sum.grossAmount ?? 0), tone: "text-brand-900" },
    { label: "Líquido a receber", value: brl(gross._sum.netAmount ?? 0), tone: "text-emerald-600" },
    { label: "Taxas da plataforma", value: brl(fees._sum.platformFee ?? 0), tone: "text-amber-600" },
    { label: "Saldo a receber (pendente)", value: brl(pendingAgg._sum.netAmount ?? 0), tone: "text-slate-700" },
    { label: "Inadimplência (overdue)", value: `${brl(overdueAgg._sum.grossAmount ?? 0)} · ${overdueAgg._count}`, tone: "text-rose-600" },
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-brand-900">{merchant.tradeName}</h1>
        <p className="text-sm text-slate-500">Painel financeiro — últimos 90 dias · {confirmedAgg} pagamentos confirmados</p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card">
            <p className="text-xs uppercase tracking-wide text-slate-400">{c.label}</p>
            <p className={`mt-2 text-xl font-bold tabular-nums ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-4 font-semibold text-brand-900">Receita por método (90d)</h2>
          <RevenueByMethodChart
            data={byMethod.map((m) => ({ method: m.billingType.toLowerCase(), total: Number(m._sum.grossAmount ?? 0) }))}
          />
        </div>
        <div className="card overflow-x-auto">
          <h2 className="mb-4 font-semibold text-brand-900">Extrato analítico — últimas cobranças</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-slate-400">
                <th className="pb-2">Data</th>
                <th className="pb-2">Cliente</th>
                <th className="pb-2">Método</th>
                <th className="pb-2 text-right">Bruto</th>
                <th className="pb-2 text-right">Líquido</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id} className="border-b border-slate-100">
                  <td className="py-2 text-slate-500">{c.createdAt.toLocaleDateString("pt-BR")}</td>
                  <td className="py-2">{c.customer?.name ?? "—"}</td>
                  <td className="py-2">{c.billingType}</td>
                  <td className="py-2 text-right tabular-nums">{brl(c.grossAmount)}</td>
                  <td className="py-2 text-right tabular-nums">{brl(c.netAmount)}</td>
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      c.status === "CONFIRMED" ? "bg-emerald-100 text-emerald-700"
                      : c.status === "OVERDUE" ? "bg-rose-100 text-rose-700"
                      : "bg-amber-100 text-amber-700"}`}>
                      {c.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
