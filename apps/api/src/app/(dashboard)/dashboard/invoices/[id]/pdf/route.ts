import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readSessionMerchantId } from "@/lib/session";

/** GET dashboard/invoices/{id}/pdf — proxy de download da NFS-e (white-label). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const merchantId = readSessionMerchantId();
  if (!merchantId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const invoice = await prisma.invoice.findFirst({ where: { id: params.id, merchantId } });
  if (!invoice?.pdfUrl) return NextResponse.json({ error: "not_available" }, { status: 404 });

  try {
    const res = await fetch(invoice.pdfUrl);
    if (!res.ok) throw new Error(String(res.status));
    const buf = Buffer.from(await res.arrayBuffer());
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="nfse-${invoice.number ?? invoice.id}.pdf"`,
      },
    });
  } catch {
    // Fallback: abre o link do provedor fiscal em nova aba (URL já sanitizada por nós)
    return NextResponse.redirect(invoice.pdfUrl);
  }
}
