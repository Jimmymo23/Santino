import type { Env } from "./types";

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, data: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.sign("HMAC", key, bytes));
}

/** Constant-time-ish comparison by comparing HMACs of both values. */
export async function safeEqual(secret: string, a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hmacHex(secret, a), hmacHex(secret, b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/** Signed token: "<purpose>.<expiryMs>.<sig>" */
export async function signToken(env: Env, purpose: string, ttlMs: number): Promise<string> {
  const body = `${purpose}.${Date.now() + ttlMs}`;
  return `${body}.${await hmacHex(env.SESSION_SECRET, body)}`;
}

export async function verifyToken(env: Env, purpose: string, token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== purpose) return false;
  if (Number(parts[1]) < Date.now()) return false;
  const body = `${parts[0]}.${parts[1]}`;
  return safeEqual(env.SESSION_SECRET, await hmacHex(env.SESSION_SECRET, body), parts[2]);
}
