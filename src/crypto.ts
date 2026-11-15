import { type Env, kvGet, kvSet } from "./types";

// Values in the `kv` table that hold credentials or mailbox content are stored
// encrypted with AES-GCM. The key is derived from SESSION_SECRET, so rotating
// that secret makes stored values unreadable: reconnect Google afterwards.

const PREFIX = "enc:v1:";
const enc = new TextEncoder();

export const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64u = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function aesKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("santino"), info: enc.encode("kv-encryption-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plain));
  return `${PREFIX}${b64u(iv)}.${b64u(ct)}`;
}

/** Read an encrypted kv value. A legacy plaintext value is upgraded in place. */
export async function secretGet(env: Env, key: string): Promise<string | null> {
  const stored = await kvGet(env, key);
  if (stored === null) return null;
  if (!stored.startsWith(PREFIX)) {
    await kvSet(env, key, await seal(env, stored));
    return stored;
  }
  const [iv, ct] = stored.slice(PREFIX.length).split(".");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await aesKey(env), unb64u(ct));
    return new TextDecoder().decode(plain);
  } catch {
    return null; // key changed or value corrupted: treat as absent
  }
}

export async function secretSet(env: Env, key: string, value: string): Promise<void> {
  await kvSet(env, key, await seal(env, value));
}
