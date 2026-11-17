export interface Env {
  DB: D1Database;
  /** Workers AI, used for speech-to-text when no external STT_URL is set. */
  AI?: Ai;
  ANTHROPIC_API_KEY: string;
  /** Override for a gateway or a local test double. Default https://api.anthropic.com */
  ANTHROPIC_BASE_URL?: string;
  OWNER_PASSCODE: string;
  SESSION_SECRET: string;
  CLAUDE_MODEL?: string;
  /** low | medium | high. Default low, for speed. */
  CLAUDE_EFFORT?: string;
  OWNER_NAME?: string;
  TIMEZONE?: string;
  /** Language Santino replies in. Default English. */
  REPLY_LANGUAGE?: string;
  /** Local hour (0-23) for the automatic morning brief. Default 8. */
  BRIEF_HOUR?: string;
  APP_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_API_VERSION?: string;
  /** Google Maps Platform key (Routes API) for travel times and traffic alerts. */
  GOOGLE_MAPS_KEY?: string;
  /** Override for the Routes API endpoint (local testing only). */
  MAPS_ROUTES_URL?: string;
  STT_URL?: string;
  STT_KEY?: string;
  STT_MODEL?: string;
  /** Workers AI text-to-speech model and optional speaker name. */
  TTS_MODEL?: string;
  TTS_VOICE?: string;
  /** Daily cap for paid services, USD. Default 2. The owner can override it in the app. */
  DAILY_BUDGET_USD?: string;
  /** Claude list prices, USD per million tokens. Defaults 2 / 10. */
  PRICE_IN_PER_MTOK?: string;
  PRICE_OUT_PER_MTOK?: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** "approval" = queued until the owner approves. Never run directly by the model. */
  risk: "auto" | "approval";
  /** One-line human summary shown on the approval card. */
  summarize?: (input: any) => string;
  run: (env: Env, input: any) => Promise<unknown>;
}

export const now = () => new Date().toISOString();

export async function kvGet(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function kvSet(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

export async function audit(env: Env, action: string, detail?: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO audit (at, action, detail) VALUES (?, ?, ?)")
    .bind(now(), action, detail === undefined ? null : JSON.stringify(detail).slice(0, 4000))
    .run();
}

/** In-app notification row only. Use `notify` from ./push to also push to devices. */
export async function storeNotification(env: Env, kind: string, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO notifications (kind, text, created_at) VALUES (?, ?, ?)")
    .bind(kind, text, now())
    .run();
}
