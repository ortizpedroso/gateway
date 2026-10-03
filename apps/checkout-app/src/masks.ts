/**
 * Utilitários de formatação/máscara e validação do checkout (client-side).
 * Zero dependências externas: máscaras aplicadas no evento onChange,
 * sem delay perceptível de digitação.
 */

// ---------------------------------------------------------------------------
// Máscaras
// ---------------------------------------------------------------------------

/** "1234567890123456" -> "1234 5678 9012 3456" (agrupamento 4-4-4-4..). */
export function maskCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 19);
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}

/** Força MM/AA enquanto digita. */
export function maskExpiry(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 4);
  if (d.length <= 2) return d;
  const mm = Math.min(Number(d.slice(0, 2)) || 1, 12).toString().padStart(2, "0");
  return `${mm}/${d.slice(2)}`;
}

/** CPF: 123.456.789-01 / CNPJ: 12.345.678/0001-90 (aceita ambos). */
export function maskCpfCnpj(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 14);
  if (d.length <= 11) {
    return d
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

/** CEP: 01234-567. */
export function maskCep(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  return d.replace(/(\d{5})(\d)/, "$1-$2");
}

/** Telefone BR: (11) 91234-5678 ou (11) 1234-5678. */
export function maskPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

// ---------------------------------------------------------------------------
// Validações (dígitos verificadores)
// ---------------------------------------------------------------------------

export function isValidCpf(cpfRaw: string): boolean {
  const cpf = cpfRaw.replace(/\D/g, "");
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let check = (sum * 10) % 11;
  if (check === 10) check = 0;
  if (check !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  check = (sum * 10) % 11;
  if (check === 10) check = 0;
  return check === Number(cpf[10]);
}

export function isValidCnpj(cnpjRaw: string): boolean {
  const cnpj = cnpjRaw.replace(/\D/g, "");
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (len: number): number => {
    const weights = len === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cnpj[i]) * weights[i];
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

export function isValidCpfCnpj(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  return d.length === 11 ? isValidCpf(d) : d.length === 14 ? isValidCnpj(d) : false;
}

/** Algoritmo de Luhn para validação local do número de cartão. */
export function luhnValid(cardRaw: string): boolean {
  const digits = cardRaw.replace(/\D/g, "");
  if (digits.length < 13) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isValidExpiry(value: string): boolean {
  const m = /^(\d{2})\/(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const mm = Number(m[1]);
  const yy = 2000 + Number(m[2]);
  if (mm < 1 || mm > 12) return false;
  const now = new Date();
  const end = new Date(yy, mm, 1); // primeiro dia após o mês de validade
  return end > now;
}

export function isValidCvv(cvv: string, brand?: CardBrand): boolean {
  const re = brand?.codeLength === 4 ? /^\d{4}$/ : /^\d{3}$/;
  return re.test(cvv.trim());
}

export function isValidCep(cepRaw: string): boolean {
  return /^\d{5}-?\d{3}$/.test(cepRaw.trim());
}

export function isValidPhone(phoneRaw: string): boolean {
  const d = phoneRaw.replace(/\D/g, "");
  return d.length === 10 || d.length === 11;
}

// ---------------------------------------------------------------------------
// Detecção de bandeira via BIN (parcial — cobre as principais brasileiras)
// ---------------------------------------------------------------------------

export type CardBrand = {
  key: "visa" | "mastercard" | "amex" | "elo" | "hipercard" | "discover" | "dinners" | "unknown";
  label: string;
  /** comprimento esperado do CVV (3 ou 4 — Amex/Hi!Card usam 4). */
  codeLength: 3 | 4;
  maxLength: number;
};

const BRANDS: Array<{ brand: CardBrand; test: (bin: string) => boolean }> = [
  { brand: { key: "visa", label: "Visa", codeLength: 3, maxLength: 16 }, test: (b) => /^4/.test(b) },
  { brand: { key: "mastercard", label: "Mastercard", codeLength: 3, maxLength: 16 }, test: (b) => /^(5[1-5]|2[2-7])/.test(b) },
  { brand: { key: "amex", label: "Amex", codeLength: 4, maxLength: 15 }, test: (b) => /^3[47]/.test(b) },
  // ELO: tabela oficial de faixas BIN (recortada para as mais comuns)
  {
    brand: { key: "elo", label: "Elo", codeLength: 3, maxLength: 16 },
    test: (b) =>
      /^(401178|401179|4312|4389|4514|4576|504175|506[6-9]\d\d|509\d{3}|627780|636297|6500|6504|6505|6506|6507|6508|6509|6516|6550)/.test(b),
  },
  { brand: { key: "hipercard", label: "Hi! Card", codeLength: 4, maxLength: 16 }, test: (b) => /^(3841|606282|637095|637568|6466)/.test(b) },
  { brand: { key: "discover", label: "Discover", codeLength: 3, maxLength: 16 }, test: (b) => /^6(?:011|5)/.test(b) },
  { brand: { key: "dinners", label: "Diners", codeLength: 3, maxLength: 14 }, test: (b) => /^3(?:0[0-5]|[68])/.test(b) },
];

export const UNKNOWN_BRAND: CardBrand = { key: "unknown", label: "Cartão", codeLength: 3, maxLength: 19 };

/** Detecta a bandeira a partir dos primeiros dígitos digitados (BIN). */
export function detectBrand(cardRaw: string): CardBrand {
  const digits = cardRaw.replace(/\D/g, "");
  if (digits.length < 2) return UNKNOWN_BRAND;
  const bin = digits.slice(0, 6);
  for (const entry of BRANDS) {
    if (entry.test(bin) || entry.test(digits.slice(0, 4))) return entry.brand;
  }
  return UNKNOWN_BRAND;
}
