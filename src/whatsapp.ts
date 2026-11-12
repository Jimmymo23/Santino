import { hmacHex, safeEqual } from "./auth";
import { type Env, type Tool, audit, notify } from "./types";

const digits = (s: string) => s.replace(/\D/g, "");

export async function whatsappSend(env: Env, to: string, text: string): Promise<unknown> {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) throw new Error("WhatsApp is not configured yet.");
  const res = await fetch(
    `https://graph.facebook.com/${env.WHATSAPP_API_VERSION ?? "v21.0"}/${env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: digits(to), type: "text", text: { body: text } }),
    },
  );
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

export const whatsappTools: Tool[] = [
  {
    name: "whatsapp_send",
    description:
      "Send a WhatsApp message to a team member by name (must exist in the team directory with a WhatsApp number). One-to-one only, groups are not supported. Requires owner approval.",
    input_schema: {
      type: "object",
      properties: { person: { type: "string", description: "team member name" }, text: { type: "string" } },
      required: ["person", "text"],
    },
    risk: "approval",
    summarize: (i) => `WhatsApp to ${i.person}:\n${i.text}`,
    run: async (env, { person, text }) => {
      const p = await env.DB.prepare("SELECT name, whatsapp FROM people WHERE name LIKE ? LIMIT 1")
        .bind(`%${person}%`)
        .first<{ name: string; whatsapp: string | null }>();
      if (!p?.whatsapp) throw new Error(`No WhatsApp number saved for "${person}".`);
      await whatsappSend(env, p.whatsapp, text);
      return { sent: true, to: p.name };
    },
  },
];

/** GET: Meta webhook verification handshake. */
export function whatsappVerify(env: Env, url: URL): Response {
  if (
    url.searchParams.get("hub.mode") === "subscribe" &&
    env.WHATSAPP_VERIFY_TOKEN &&
    url.searchParams.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN
  ) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

/** POST: inbound messages. Stored as notifications; never executed as instructions. */
export async function whatsappInbound(env: Env, req: Request): Promise<Response> {
  const raw = await req.arrayBuffer();
  if (env.WHATSAPP_APP_SECRET) {
    const sig = (req.headers.get("x-hub-signature-256") ?? "").replace("sha256=", "");
    const expected = await hmacHex(env.WHATSAPP_APP_SECRET, raw);
    if (!(await safeEqual(env.WHATSAPP_APP_SECRET, sig, expected))) return new Response("bad signature", { status: 401 });
  }
  const body = JSON.parse(new TextDecoder().decode(raw));
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        const from = digits(String(m.from ?? ""));
        const text = m.text?.body ?? `[${m.type}]`;
        const people = await env.DB.prepare("SELECT name, whatsapp FROM people WHERE whatsapp IS NOT NULL").all<{
          name: string;
          whatsapp: string;
        }>();
        const who = people.results.find((p) => digits(p.whatsapp) === from)?.name ?? `+${from}`;
        await notify(env, "whatsapp", `${who}: ${String(text).slice(0, 1000)}`);
        await audit(env, "whatsapp_inbound", { from: who });
      }
    }
  }
  return new Response("ok");
}
