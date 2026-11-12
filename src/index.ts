import { Hono } from "hono";
import { runAgent, saveTurn } from "./agent";
import { safeEqual, signToken, verifyToken } from "./auth";
import { runCron } from "./cron";
import { googleAuthUrl, googleConnected, googleExchangeCode } from "./google";
import { resolveApproval } from "./tools";
import type { Env } from "./types";
import { whatsappInbound, whatsappVerify } from "./whatsapp";

const app = new Hono<{ Bindings: Env }>();

const DAY = 86_400_000;
const APPROVE = /^(approve|approved|yes|ok|okay|go ahead|send it|do it|وافق|موافق|تمام|ابعت|ابعته|ابعتها|ماشي|اه|آه|أيوه|ايوه)[\s.!؟?]*$/i;
const REJECT = /^(reject|no|cancel|don'?t send|لا|لأ|الغي|إلغاء|الغاء|متبعتش)[\s.!؟?]*$/i;

// ---------- public ----------

app.post("/api/login", async (c) => {
  const { passcode } = await c.req.json<{ passcode?: string }>();
  if (!passcode || !(await safeEqual(c.env.SESSION_SECRET, passcode, c.env.OWNER_PASSCODE))) {
    return c.json({ error: "Wrong passcode" }, 401);
  }
  return c.json({ token: await signToken(c.env, "session", 30 * DAY) });
});

app.get("/webhooks/whatsapp", (c) => whatsappVerify(c.env, new URL(c.req.url)));
app.post("/webhooks/whatsapp", (c) => whatsappInbound(c.env, c.req.raw));

app.get("/auth/google/callback", async (c) => {
  if (!(await verifyToken(c.env, "gstate", c.req.query("state")))) return c.text("Invalid state", 400);
  const code = c.req.query("code");
  if (!code) return c.text("Missing code", 400);
  await googleExchangeCode(c.env, code);
  return c.redirect("/");
});

// ---------- owner only ----------

app.use("/api/*", async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!(await verifyToken(c.env, "session", token))) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.get("/api/google/connect", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: "GOOGLE_CLIENT_ID is not set" }, 400);
  return c.json({ url: googleAuthUrl(c.env, await signToken(c.env, "gstate", 600_000)) });
});

app.get("/api/status", async (c) =>
  c.json({
    google: await googleConnected(c.env),
    whatsapp: Boolean(c.env.WHATSAPP_TOKEN && c.env.WHATSAPP_PHONE_ID),
    voice: Boolean(c.env.STT_URL),
  }),
);

app.post("/api/chat", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  const msg = (text ?? "").trim();
  if (!msg) return c.json({ error: "Empty message" }, 400);

  // Voice/text approval shortcut. Deterministic and outside the model on purpose:
  // only the owner's own words can approve, and only when it is unambiguous.
  const approve = APPROVE.test(msg);
  if (approve || REJECT.test(msg)) {
    const pending = await c.env.DB.prepare("SELECT id FROM approvals WHERE status = 'pending' LIMIT 2").all<{ id: string }>();
    if (pending.results.length === 1) {
      const r = await resolveApproval(c.env, pending.results[0].id, approve);
      await saveTurn(c.env, msg, r.message);
      return c.json({ reply: r.message });
    }
    if (pending.results.length > 1) {
      const reply = "There is more than one item waiting. Tap the one you mean.";
      await saveTurn(c.env, msg, reply);
      return c.json({ reply });
    }
  }

  try {
    return c.json({ reply: await runAgent(c.env, msg) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.post("/api/transcribe", async (c) => {
  if (!c.env.STT_URL) return c.json({ error: "Voice is not configured" }, 501);
  const audio = await c.req.blob();
  if (audio.size > 20 * 1024 * 1024) return c.json({ error: "Recording too long" }, 413);
  const form = new FormData();
  const ext = audio.type.includes("mp4") ? "mp4" : "webm";
  form.append("file", audio, `audio.${ext}`);
  if (c.env.STT_MODEL) form.append("model", c.env.STT_MODEL);
  const res = await fetch(c.env.STT_URL, {
    method: "POST",
    headers: c.env.STT_KEY ? { authorization: `Bearer ${c.env.STT_KEY}` } : {},
    body: form,
  });
  if (!res.ok) return c.json({ error: `Transcription failed (${res.status})` }, 502);
  const data = await res.json<{ text?: string }>();
  return c.json({ text: data.text ?? "" });
});

app.get("/api/inbox", async (c) => {
  const [approvals, notifications] = await Promise.all([
    c.env.DB.prepare("SELECT id, tool, summary, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at").all(),
    c.env.DB.prepare("SELECT id, kind, text, created_at FROM notifications WHERE read = 0 ORDER BY id").all(),
  ]);
  return c.json({ approvals: approvals.results, notifications: notifications.results });
});

app.post("/api/notifications/:id/read", async (c) => {
  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

app.post("/api/approvals/:id/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "approve" && action !== "reject") return c.json({ error: "Bad action" }, 400);
  return c.json(await resolveApproval(c.env, c.req.param("id"), action === "approve"));
});

app.get("/api/history", async (c) => {
  const rows = await c.env.DB.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT 40").all();
  return c.json({ messages: rows.results.reverse() });
});

export default {
  fetch: app.fetch,
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runCron(env)),
} satisfies ExportedHandler<Env>;
