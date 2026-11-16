import { b64u, secretGet, secretSet, unb64u } from "./crypto";
import { type Env, audit, kvGet, kvSet, now, storeNotification } from "./types";

// Web Push without a library: VAPID (RFC 8292) for authentication and
// aes128gcm payload encryption (RFC 8291) so the text shows on the device.
// The VAPID key pair is generated on first use and kept in D1 (private part
// encrypted), so there is nothing to configure.

const enc = new TextEncoder();
const EC = { name: "ECDSA", namedCurve: "P-256" } as const;

async function vapid(env: Env): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  let jwk = await secretGet(env, "vapid_private_jwk");
  let pub = await kvGet(env, "vapid_public");
  if (!jwk || !pub) {
    const pair = (await crypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
    jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    pub = b64u((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    await secretSet(env, "vapid_private_jwk", jwk);
    await kvSet(env, "vapid_public", pub);
  }
  return { publicKey: pub, privateKey: await crypto.subtle.importKey("jwk", JSON.parse(jwk), EC, false, ["sign"]) };
}

export async function pushPublicKey(env: Env): Promise<string> {
  return (await vapid(env)).publicKey;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** RFC 8291 aes128gcm body for one record. Exported for tests. */
export async function encryptPayload(p256dh: string, auth: string, payload: string): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, eph.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 0x02 marks the last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

async function vapidHeader(env: Env, endpoint: string): Promise<string> {
  const { publicKey, privateKey } = await vapid(env);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.APP_URL ?? "https://example.invalid",
      }),
    ),
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

interface Sub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Send one push to every registered device. Never throws. Returns how many were accepted. */
export async function pushAll(env: Env, title: string, body: string, tag?: string): Promise<number> {
  let sent = 0;
  try {
    const subs = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all<Sub>();
    const payload = JSON.stringify({ title, body: body.slice(0, 600), tag });
    for (const s of subs.results) {
      try {
        const res = await fetch(s.endpoint, {
          method: "POST",
          headers: {
            authorization: await vapidHeader(env, s.endpoint),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: "86400",
            urgency: "high",
          },
          body: await encryptPayload(s.p256dh, s.auth, payload),
        });
        if (res.ok) sent++;
        else if (res.status === 404 || res.status === 410) {
          // The device unsubscribed or the subscription expired.
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(s.endpoint).run();
        } else await audit(env, "push_failed", { status: res.status, host: new URL(s.endpoint).host });
      } catch (e) {
        await audit(env, "push_failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch {
    /* the table may not exist yet during a deploy; notifications still land in-app */
  }
  return sent;
}

export async function subscribe(env: Env, body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }) {
  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return { ok: false, error: "Missing subscription fields" };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: "Bad endpoint" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Bad endpoint" };
  if (unb64u(keys.p256dh).length !== 65 || unb64u(keys.auth).length !== 16) return { ok: false, error: "Bad keys" };
  await env.DB.prepare("INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(endpoint, keys.p256dh, keys.auth, (body.label ?? "").slice(0, 60) || null, now())
    .run();
  return { ok: true };
}

const TITLES: Record<string, string> = {
  reminder: "Reminder",
  brief: "Morning brief",
  followup: "Follow-up",
  whatsapp: "WhatsApp reply",
};

/** Store a notification for the app and push it to the owner's devices. */
export async function notify(env: Env, kind: string, text: string): Promise<void> {
  await storeNotification(env, kind, text);
  await pushAll(env, `Santino · ${TITLES[kind] ?? "Update"}`, text, kind);
}
