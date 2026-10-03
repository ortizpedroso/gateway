import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware global do gateway (edge):
 *
 * 1. Segurança FinTech (Módulo A):
 *    - CSP restrita (self + domínio white-label; nenhuma origem Asaas).
 *    - HSTS, X-Content-Type-Options, Referrer-Policy.
 *    - X-Frame-Options: SAMEORIGIN (bloqueio de clickjacking) + frame-ancestors na CSP.
 *    - Remoção de headers que poderiam revelar stack/upstream.
 *
 * 2. SEO técnico (Módulo C):
 *    - Rotas transacionais (/pay/*, /checkout/* e API) recebem
 *      X-Robots-Tag: noindex, nofollow para impedir indexação de dados
 *      de pagamentos por buscadores.
 */

const TRANSACTIONAL_PREFIXES = ["/pay", "/checkout", "/api"];

function isTransactional(pathname: string): boolean {
  return TRANSACTIONAL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest): NextResponse {
  const res = NextResponse.next();
  const h = res.headers;

  // ---- Cabeçalhos de segurança (todos os responses) ----------------------
  h.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // QR Code Pix é renderizado localmente pela SPA (qrcode generator client-side),
      // imagens dinâmicas apenas via data:/blob:. Scripts inline bloqueados exceto
      // next.js runtime (nonce-less em prod usar build-time hashing).
      "script-src 'self' 'unsafe-eval' 'report-sample'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://checkout.payhub.example.com",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  );
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  if (process.env.NODE_ENV === "production") {
    // 1 ano, includeSubDomains, preload sugerido via hstspreload.org
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  // Anti-fingerprinting da stack
  h.delete("X-Powered-By");

  // ---- Noindex para rotas transacionais ----------------------------------
  if (isTransactional(req.nextUrl.pathname)) {
    h.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  }

  return res;
}

export const config = {
  matcher: [
    // Tudo, exceto assets estáticos com hash no nome (não precisam de headers extras)
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
