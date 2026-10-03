import { prisma } from "@/lib/prisma";
import { requireMerchant } from "@/lib/session";
import { rotateSecretKeyAction, updateWebhookAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const merchant = await requireMerchant();
  const keys = await prisma.apiKey.findMany({ where: { merchantId: merchant.id, revokedAt: null } });
  const pk = keys.find((k) => k.type === "public");
  const sk = keys.find((k) => k.type === "secret");

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-xl font-bold text-brand-900">Chaves de API & Webhooks</h1>

      <section className="card space-y-4">
        <h2 className="font-semibold">Credenciais</h2>
        <div>
          <label className="label">Public key (checkout client-side)</label>
          <code className="block w-full rounded-lg bg-slate-100 p-3 text-sm">{pk?.publicKey ?? "—"}</code>
        </div>
        <div>
          <label className="label">Secret key (server-to-server)</label>
          <code className="block w-full rounded-lg bg-slate-100 p-3 text-sm">{sk ? `${sk.prefix}${"•".repeat(24)}${sk.last4}` : "—"}</code>
          <p className="mt-1 text-xs text-slate-400">A chave secreta é armazenada apenas como hash SHA-256.</p>
        </div>
        <form action={rotateSecretKeyAction}>
          <button className="btn-primary">Rotacionar secret key</button>
        </form>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Webhook de saída (para sua loja)</h2>
        <form action={updateWebhookAction} className="space-y-3">
          <div>
            <label className="label">URL de notificação (HTTPS)</label>
            <input name="webhookUrl" defaultValue={merchant.webhookUrl ?? ""} placeholder="https://sualoja.com/webhooks/payhub" className="input" />
          </div>
          <div>
            <label className="label">Segredo HMAC-SHA256</label>
            <code className="block w-full rounded-lg bg-slate-100 p-3 text-xs">{merchant.webhookSecret ?? "gerado ao salvar a URL"}</code>
          </div>
          <button className="btn-primary">Salvar</button>
        </form>
      </section>
    </div>
  );
}
