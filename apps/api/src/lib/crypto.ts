import crypto from "node:crypto";

/**
 * AES-256-GCM para armazenamento de credenciais upstream (api keys das
 * subcontas Asaas). Formato persistido: iv:authTag:ciphertext (hex), com
 * prefixo de versão para futura rotação de chave.
 */
const VERSION = "v1";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY deve ser uma chave hex de 32 bytes (64 chars).");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivHex, tagHex, dataHex] = payload.split(":");
  if (version !== VERSION || !ivHex || !tagHex || !dataHex) {
    throw new Error("Formato de segredo criptografado inválido.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/** SHA-256 hex — usado para hash de secret keys (pk/sk) e HMACs utilitários. */
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Gera API key da plataforma: prefix + 32 chars base62 aleatórios. */
export function generateApiKey(kind: "pk" | "sk", env: "live" | "test"): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(32);
  let out = "";
  for (let i = 0; i < 32; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${kind}_${env}_${out}`;
}

/** Assinatura HMAC-SHA256 (webhooks de saída / verificação de entrada). */
export function hmacSha256(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Comparação em tempo constante. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("hex");
}
