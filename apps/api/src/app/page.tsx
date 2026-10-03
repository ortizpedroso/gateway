import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="card max-w-md text-center">
        <h1 className="text-2xl font-bold text-brand-900">PayHub</h1>
        <p className="mt-2 text-sm text-slate-500">Gateway de pagamentos white-label.</p>
        <Link href="/dashboard" className="btn-primary mt-6">
          Acessar Dashboard
        </Link>
      </div>
    </main>
  );
}
