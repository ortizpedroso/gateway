import Link from "next/link";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const nav = [
    { href: "/dashboard", label: "Visão Geral" },
    { href: "/dashboard/links", label: "Links de Pagamento" },
    { href: "/dashboard/subscriptions", label: "Assinaturas" },
    { href: "/dashboard/invoices", label: "Notas Fiscais" },
    { href: "/dashboard/settings", label: "Chaves & Webhooks" },
  ];
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white p-6 md:block">
        <Link href="/" className="text-lg font-bold text-brand-900">PayHub</Link>
        <nav className="mt-8 space-y-1">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="block rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700">
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-6 md:p-10">{children}</main>
    </div>
  );
}
