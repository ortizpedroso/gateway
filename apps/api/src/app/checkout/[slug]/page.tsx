/**
 * Página /pay/{slug} na borda do Next.js.
 * Em produção, o build da SPA Vite (apps/checkout-app) é publicado em um CDN
 * sob este mesmo path; aqui fazemos SSR de metadados OG + redirecionamento
 * client-side para a SPA com o slug. A SPA chama apenas /api/v1/public/*.
 */
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function PayPage({ params }: { params: { slug: string } }) {
  const link = await prisma.paymentLink.findFirst({
    where: { slug: params.slug, active: true },
    include: {
      merchant: {
        select: {
          tradeName: true,
          status: true,
          apiKeys: { where: { type: "public", revokedAt: null }, take: 1, select: { publicKey: true } },
        },
      },
    },
  });
  if (!link || link.merchant.status !== "APPROVED") notFound();
  const pk = link.merchant.apiKeys[0]?.publicKey;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      {/* SPA Vite (apps/checkout-app) montada aqui; build publicado em /public/checkout */}
      <div
        id="checkout-root"
        data-slug={link.slug}
        data-pk={pk ?? ""}
        className="w-full max-w-md text-center text-slate-400"
      >
        Carregando checkout seguro de {link.merchant.tradeName}…
      </div>
      <script async src="/checkout/assets/index.js" />
    </main>
  );
}
