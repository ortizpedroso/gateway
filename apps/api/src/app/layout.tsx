import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayHub — Gateway de Pagamentos",
  description: "Gateway white-label para lojistas e prestadores.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
