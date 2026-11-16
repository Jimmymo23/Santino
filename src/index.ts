import { Hono } from "hono";
import { runAgent, saveTurn } from "./agent";
import { safeEqual, signToken, verifyToken } from "./auth";
import { snapshot } from "./brief";
import { runCron } from "./cron";
import { googleAuthUrl, googleConnected, googleExchangeCode } from "./google";
import { loginOptions, loginVerify, registerOptions, registerVerify } from "./passkeys";
import { isPaused, loginAllowed, loginFailed, loginSucceeded, setPaused } from "./security";
import { listMemories } from "./memory";
import { resolveApproval } from "./tools";
import { extendBudget, overBudget, prices, record, spendToday } from "./usage";
import { type Env, kvGet, kvSet } from "./types";
import { whatsappInbound, whatsappVerify } from "./whatsapp";

const app = new Hono<{ Bindings: Env }>();

const DAY = 86_400_000;
const SESSION_TTL = 7 * DAY;
const STAND_DOWN = /^(santino[,،]?\s*)?(stand down|stop everything|kill switch|pause everything|وقف كل حاجة|اقف كل حاجة)[\s.!]*$/i;
const TOO_MANY = "Too many attempts. Try again in 15 minutes.";
// Speakers of @cf/deepgram/aura-2-en (from the Workers AI model page).
const VOICES = "amalthea andromeda apollo arcas aries asteria athena atlas aurora callista cora cordelia delia draco electra harmonia helena hera hermes hyperion iris janus juno jupiter luna mars minerva neptune odysseus ophelia orion orpheus pandora phoebe pluto saturn thalia theia vesta zeus".split(" ");
const currentVoice = async (env: Env) => (await kvGet(env, "tts_voice")) ?? env.TTS_VOICE ?? "draco";
const clientIp = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header("cf-connecting-ip") ?? "local";
const APPROVE = /^(approve|approved|yes|ok|okay|go ahead|send it|do it|وافق|موافق|تمام|ابعت|ابعته|ابعتها|ماشي|اه|آه|أيوه|ايوه)[\s.!؟?]*$/i;
const REJECT = /^(reject|no|cancel|don'?t send|لا|لأ|الغي|إلغاء|الغاء|متبعتش)[\s.!؟?]*$/i;

// ---------- public ----------

app.post("/api/login", async (c) => {
  const ip = clientIp(c);
  if (!(await loginAllowed(c.env, ip))) return c.json({ error: TOO_MANY }, 429);
  const { passcode } = await c.req.json<{ passcode?: string }>().catch(() => ({ passcode: undefined }));
  if (!passcode || !(await safeEqual(c.env.SESSION_SECRET, passcode, c.env.OWNER_PASSCODE))) {
    await loginFailed(c.env, ip);
    return c.json({ error: "Wrong passcode" }, 401);
  }
  await loginSucceeded(c.env, ip);
  return c.json({ token: await signToken(c.env, "session", SESSION_TTL) });
});

// Passkey login (Face ID / fingerprint). Public, rate limited like the passcode.
app.post("/auth/passkey/options", async (c) => c.json(await loginOptions(c.env, new URL(c.req.url).hostname)));

app.post("/auth/passkey/verify", async (c) => {
  const ip = clientIp(c);
  if (!(await loginAllowed(c.env, ip))) return c.json({ error: TOO_MANY }, 429);
  const url = new URL(c.req.url);
  const body = await c.req.json().catch(() => ({}));
  if (!(await loginVerify(c.env, url.origin, url.hostname, body))) {
    await loginFailed(c.env, ip);
    return c.json({ error: "Passkey not accepted" }, 401);
  }
  await loginSucceeded(c.env, ip);
  return c.json({ token: await signToken(c.env, "session", SESSION_TTL) });
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
    voice: Boolean(c.env.STT_URL || c.env.AI),
    tts: Boolean(c.env.AI),
    ttsVoice: await currentVoice(c.env),
    owner: c.env.OWNER_NAME ?? "",
    paused: await isPaused(c.env),
    passkeys: (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>())?.n ?? 0,
  }),
);

// Kill switch. Owner only; the model has no way to call these.
app.post("/api/pause", async (c) => {
  await setPaused(c.env, true);
  return c.json({ paused: true });
});
app.post("/api/resume", async (c) => {
  await setPaused(c.env, false);
  return c.json({ paused: false });
});

app.post("/api/passkeys/register/options", async (c) => c.json(await registerOptions(c.env, new URL(c.req.url).hostname)));
app.post("/api/passkeys/register/verify", async (c) => {
  const r = await registerVerify(c.env, new URL(c.req.url).origin, await c.req.json().catch(() => ({})));
  return c.json(r, r.ok ? 200 : 400);
});
app.delete("/api/passkeys", async (c) => {
  await c.env.DB.prepare("DELETE FROM passkeys").run();
  return c.json({ ok: true });
});

app.get("/api/dashboard", async (c) => {
  const s = await snapshot(c.env);
  return c.json({
    open: s.tasks.open,
    overdue: s.tasks.overdue.length,
    due_today: s.tasks.due_today.length,
    meetings: s.google_connected ? s.agenda_today.length : null,
    unread: s.google_connected ? s.unread_email.length : null,
    approvals: s.approvals_pending,
    next_reminder: s.reminders[0] ?? null,
    spend: await spendToday(c.env),
  });
});

app.post("/api/chat", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  const msg = (text ?? "").trim();
  if (!msg) return c.json({ error: "Empty message" }, 400);

  // Kill switch by voice or text. Deterministic, before the model sees anything.
  if (STAND_DOWN.test(msg)) {
    await setPaused(c.env, true);
    const reply = "Standing down. All sending and scheduled actions are paused. Tap Resume when you want me back.";
    await saveTurn(c.env, msg, reply);
    return c.json({ reply, paused: true });
  }

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

// Hint that biases Whisper toward the owner's mixed Egyptian Arabic + English,
// keeping English words in Latin script instead of transliterating them.
const STT_HINT = "Santino. ابعت email لأحمد عن الـ meeting بتاع بكرة الساعة 3. Remind me to follow up مع الفريق.";

app.post("/api/transcribe", async (c) => {
  if (!c.env.STT_URL && !c.env.AI) return c.json({ error: "Voice is not configured" }, 501);
  const audio = await c.req.blob();
  if (audio.size > 20 * 1024 * 1024) return c.json({ error: "Recording too long" }, 413);
  if (audio.size < 1500) return c.json({ text: "" });
  if (await overBudget(c.env)) return c.json({ error: "Daily budget reached" }, 402);
  // 16 kHz mono WAV from hands-free is exact; other formats are a rough estimate (~32 kbps).
  const seconds = audio.type.includes("wav") ? (audio.size - 44) / 32000 : audio.size / 4000;
  await record(c.env, "stt", seconds, seconds * prices(c.env).sttPerSecond);

  if (!c.env.STT_URL && c.env.AI) {
    // Default: Whisper on Workers AI. No extra account or key needed.
    const bytes = new Uint8Array(await audio.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    try {
      const out = (await c.env.AI.run("@cf/openai/whisper-large-v3-turbo", {
        audio: btoa(bin),
        task: "transcribe",
        vad_filter: true,
        initial_prompt: STT_HINT,
      })) as { text?: string };
      const text = (out.text ?? "").trim();
      // Whisper sometimes echoes the hint back on silent audio.
      return c.json({ text: text === STT_HINT ? "" : text });
    } catch (e) {
      return c.json({ error: `Transcription failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  }

  const form = new FormData();
  const ext = audio.type.includes("mp4") ? "mp4" : "webm";
  form.append("file", audio, `audio.${ext}`);
  if (c.env.STT_MODEL) form.append("model", c.env.STT_MODEL);
  const res = await fetch(c.env.STT_URL!, {
    method: "POST",
    headers: c.env.STT_KEY ? { authorization: `Bearer ${c.env.STT_KEY}` } : {},
    body: form,
  });
  if (!res.ok) return c.json({ error: `Transcription failed (${res.status})` }, 502);
  const data = await res.json<{ text?: string }>();
  return c.json({ text: data.text ?? "" });
});

// Natural voice for spoken replies (Workers AI). English only; the app falls
// back to the browser's built-in voice for Arabic text or on any failure.
app.post("/api/speak", async (c) => {
  if (!c.env.AI) return c.json({ error: "Voice output is not configured" }, 501);
  const { text, speaker } = await c.req
    .json<{ text?: string; speaker?: string }>()
    .catch(() => ({ text: undefined, speaker: undefined }));
  const clean = (text ?? "").replace(/[•*_#`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!clean) return c.json({ error: "Nothing to say" }, 400);
  if (await overBudget(c.env)) return c.json({ error: "Daily budget reached" }, 402);
  await record(c.env, "tts", clean.length, clean.length * prices(c.env).ttsPerChar);
  try {
    // `speaker` in the request is only for previewing a voice before saving it.
    const voice = speaker && VOICES.includes(speaker) ? speaker : await currentVoice(c.env);
    const input: Record<string, unknown> = { text: clean };
    if (VOICES.includes(voice)) input.speaker = voice;
    const run = c.env.AI.run as unknown as (m: string, i: unknown, o: unknown) => Promise<Response>;
    const res = await run.call(c.env.AI, c.env.TTS_MODEL ?? "@cf/deepgram/aura-2-en", input, { returnRawResponse: true });
    if (!res.ok || !res.body) return c.json({ error: `Voice failed (${res.status})` }, 502);
    return new Response(res.body, {
      headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg", "cache-control": "no-store" },
    });
  } catch (e) {
    return c.json({ error: `Voice failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
});

app.get("/api/memories", async (c) => c.json({ memories: await listMemories(c.env) }));
app.delete("/api/memories/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// Owner raises today's spending cap by one dollar per tap.
app.post("/api/budget/extend", async (c) => {
  await extendBudget(c.env, 1);
  return c.json(await spendToday(c.env));
});

app.post("/api/voice", async (c) => {
  const { speaker } = await c.req.json<{ speaker?: string }>().catch(() => ({ speaker: undefined }));
  if (!speaker || !VOICES.includes(speaker)) return c.json({ error: "Unknown voice" }, 400);
  await kvSet(c.env, "tts_voice", speaker);
  return c.json({ ttsVoice: speaker });
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
