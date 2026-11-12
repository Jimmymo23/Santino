export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  OWNER_PASSCODE: string;
  SESSION_SECRET: string;
  CLAUDE_MODEL?: string;
  OWNER_NAME?: string;
  TIMEZONE?: string;
  APP_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_API_VERSION?: string;
  STT_URL?: string;
  STT_KEY?: string;
  STT_MODEL?: string;
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

export async function notify(env: Env, kind: string, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO notifications (kind, text, created_at) VALUES (?, ?, ?)")
    .bind(kind, text, now())
    .run();
}
