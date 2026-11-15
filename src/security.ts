import { type Env, audit, kvGet, kvSet, now } from "./types";

// ---------- kill switch ----------
// While paused: no approval executes, approval tools refuse to queue, and cron
// sends nothing. Checked in server code, never left to the model.

export async function isPaused(env: Env): Promise<boolean> {
  return (await kvGet(env, "paused")) === "1";
}

export async function setPaused(env: Env, paused: boolean): Promise<void> {
  await kvSet(env, "paused", paused ? "1" : "0");
  await audit(env, paused ? "paused" : "resumed");
}

export const PAUSED_MESSAGE =
  "Santino is paused (stand down). Nothing can be queued or sent until the owner taps Resume.";

// ---------- login rate limit ----------
const WINDOW_MS = 15 * 60_000;
const PER_IP = 5;
const GLOBAL = 30;

export async function loginAllowed(env: Env, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const [mine, all] = await Promise.all([
    env.DB.prepare("SELECT count FROM login_attempts WHERE ip = ? AND window_start > ?").bind(ip, since).first<{ count: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM login_attempts WHERE window_start > ?").bind(since).first<{ n: number }>(),
  ]);
  return (mine?.count ?? 0) < PER_IP && (all?.n ?? 0) < GLOBAL;
}

export async function loginFailed(env: Env, ip: string): Promise<void> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(ip) DO UPDATE SET
       count = CASE WHEN window_start > ?3 THEN count + 1 ELSE 1 END,
       window_start = CASE WHEN window_start > ?3 THEN window_start ELSE ?2 END`,
  )
    .bind(ip, now(), since)
    .run();
  await audit(env, "login_failed", { ip });
}

export async function loginSucceeded(env: Env, ip: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}
