export const brl = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Tabela de parcelas com juros simples configurável pelo merchant (fee_config.interestBpsPerMonth). */
export function installmentOptions(
  total: number,
  maxInstallments: number,
  interestBpsPerMonth: number,
): { n: number; value: number; withInterest: boolean }[] {
  const opts: { n: number; value: number; withInterest: boolean }[] = [];
  for (let n = 1; n <= Math.min(maxInstallments, 12); n++) {
    if (n <= 1) {
      opts.push({ n, value: total, withInterest: false });
      continue;
    }
    // Sem juros até a parcela "livre" do merchant aqui tratada como i=0 por padrão;
    // quando há spread mensal, valor total cresce em juros simples.
    const i = interestBpsPerMonth / 10_000;
    const totalWithInterest = i > 0 ? total * (1 + i * (n - 1)) : total;
    opts.push({ n, value: totalWithInterest / n, withInterest: i > 0 });
  }
  return opts;
}
