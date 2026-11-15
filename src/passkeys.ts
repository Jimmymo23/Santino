import { signToken, verifyToken } from "./auth";
import { b64u, unb64u } from "./crypto";
import { type Env, audit, now } from "./types";

// Passkey (WebAuthn) login, ES256 only, discoverable credentials.
// Registration requires an already authenticated owner session, so the public
// key supplied by the browser is trusted without attestation.

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHALLENGE_TTL = 5 * 60_000;

async function newChallenge(env: Env): Promise<{ challenge: string; token: string }> {
  const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
  return { challenge, token: await signToken(env, `wa:${challenge}`, CHALLENGE_TTL) };
}

/** Checks clientDataJSON: type, origin, a challenge we issued, and not used before. */
async function checkClientData(env: Env, clientDataB64: string, type: string, origin: string, token: string): Promise<boolean> {
  let data: { type?: string; challenge?: string; origin?: string };
  try {
    data = JSON.parse(dec.decode(unb64u(clientDataB64)));
  } catch {
    return false;
  }
  if (data.type !== type || data.origin !== origin || !data.challenge) return false;
  if (!(await verifyToken(env, `wa:${data.challenge}`, token))) return false;
  // Single use: a captured response cannot be replayed.
  await env.DB.prepare("DELETE FROM used_challenges WHERE expires_at < ?").bind(now()).run();
  const used = await env.DB.prepare("INSERT OR IGNORE INTO used_challenges (challenge, expires_at) VALUES (?, ?)")
    .bind(data.challenge, new Date(Date.now() + 2 * CHALLENGE_TTL).toISOString())
    .run();
  return used.meta.changes === 1;
}

export async function registerOptions(env: Env, host: string) {
  const { challenge, token } = await newChallenge(env);
  const existing = await env.DB.prepare("SELECT id FROM passkeys").all<{ id: string }>();
  return {
    challenge,
    token,
    rp: { id: host, name: "Santino" },
    user: { id: b64u(enc.encode("owner")), name: env.OWNER_NAME ?? "Owner" },
    exclude: existing.results.map((r) => r.id),
  };
}

export async function registerVerify(
  env: Env,
  origin: string,
  body: { token?: string; id?: string; clientDataJSON?: string; publicKey?: string; alg?: number; label?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!body.token || !body.id || !body.clientDataJSON || !body.publicKey) return { ok: false, error: "Missing fields" };
  if (body.alg !== -7) return { ok: false, error: "Unsupported key type" };
  if (!(await checkClientData(env, body.clientDataJSON, "webauthn.create", origin, body.token)))
    return { ok: false, error: "Challenge check failed" };
  try {
    await crypto.subtle.importKey("spki", unb64u(body.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return { ok: false, error: "Invalid public key" };
  }
  await env.DB.prepare("INSERT OR REPLACE INTO passkeys (id, public_key, label, created_at) VALUES (?, ?, ?, ?)")
    .bind(body.id, body.publicKey, (body.label ?? "").slice(0, 60) || null, now())
    .run();
  await audit(env, "passkey_added", { label: body.label });
  return { ok: true };
}

export async function loginOptions(env: Env, host: string) {
  const { challenge, token } = await newChallenge(env);
  return { challenge, token, rpId: host };
}

/** DER-encoded ECDSA signature -> raw r||s (64 bytes) as WebCrypto expects. */
function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der[0] !== 0x30) return null;
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1];
    let v = der.subarray(i + 2, i + 2 + len);
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    out.set(v, part * 32 + (32 - v.length));
    i += 2 + len;
  }
  return out;
}

export async function loginVerify(
  env: Env,
  origin: string,
  host: string,
  body: { token?: string; id?: string; clientDataJSON?: string; authenticatorData?: string; signature?: string },
): Promise<boolean> {
  if (!body.token || !body.id || !body.clientDataJSON || !body.authenticatorData || !body.signature) return false;
  if (!(await checkClientData(env, body.clientDataJSON, "webauthn.get", origin, body.token))) return false;

  const row = await env.DB.prepare("SELECT public_key FROM passkeys WHERE id = ?").bind(body.id).first<{ public_key: string }>();
  if (!row) return false;

  const authData = unb64u(body.authenticatorData);
  if (authData.length < 37) return false;
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(host)));
  for (let i = 0; i < 32; i++) if (authData[i] !== rpHash[i]) return false;
  const flags = authData[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return false; // user present AND user verified

  const sig = derToRaw(unb64u(body.signature));
  if (!sig) return false;
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64u(body.clientDataJSON)));
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(clientHash, authData.length);

  const key = await crypto.subtle.importKey("spki", unb64u(row.public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signed);
  if (ok) await env.DB.prepare("UPDATE passkeys SET last_used_at = ? WHERE id = ?").bind(now(), body.id).run();
  return ok;
}
