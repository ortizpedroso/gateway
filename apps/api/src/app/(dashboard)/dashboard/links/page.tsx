import { prisma } from "@/lib/prisma";
import { requireMerchant } from "@/lib/session";
import { createPaymentLinkAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LinksPage() {
  const merchant = await requireMerchant();
  const links = await prisma.paymentLink.findMany({
    where: { merchantId: merchant.id },
    orderBy: { createdAt: "desc" },
  });
  const domain = process.env.CHECKOUT_APP_URL ?? process.env.PLATFORM_DOMAIN ?? "";

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
      <div className="lg:col-span-1">
        <form action={createPaymentLinkAction} className="card space-y-4">
          <h2 className="font-semibold text-brand-900">Gerar Link de Pagamento</h2>
          <div><label className="label">Título do produto/serviço</label><input name="title" required className="input" /></div>
          <div><label className="label">Valor (R$)</label><input name="amount" type="number" step="0.01" min="0.5" required className="input" /></div>
          <div><label className="label">Vencimento</label><input name="dueDate" type="date" className="input" /></div>
          <fieldset className="space-y-1 text-sm">
            <legend className="label">Métodos habilitados</legend>
            <label className="flex items-center gap-2"><input type="checkbox" name="PIX" defaultChecked /> Pix</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="CREDIT_CARD" defaultChecked /> Cartão (até 12x)</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="BOLETO" defaultChecked /> Boleto</label>
          </fieldset>
          <div><label className="label">Máx. parcelas</label><input name="maxInstallments" type="number" min="1" max="12" defaultValue={12} className="input" /></div>
          <button className="btn-primary w-full">Criar link</button>
        </form>
      </div>
      <div className="lg:col-span-2">
        <h2 className="mb-4 text-lg font-semibold text-brand-900">Links existentes</h2>
        <div className="space-y-3">
          {links.map((l) => (
            <div key={l.id} className="card flex items-center justify-between py-4">
              <div>
                <p className="font-medium">{l.title}</p>
                <p className="text-sm text-slate-500">
                  {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(l.amount))} ·{" "}
                  {(l.availableMethods as string[]).join(", ")}
                </p>
              </div>
              <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{domain}/pay/{l.slug}</code>
            </div>
          ))}
          {links.length === 0 && <p className="text-sm text-slate-400">Nenhum link criado ainda.</p>}
        </div>
      </div>
    </div>
  );
}
