import { todayBounds } from "./brief";
import { type Env, kvGet, kvSet } from "./types";

// Cost meter. Costs are estimates from list prices, good enough to cap a
// runaway day; the providers' own invoices remain the source of truth.

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);

export const prices = (env: Env) => ({
  claudeIn: num(env.PRICE_IN_PER_MTOK, 2) / 1e6, // USD per input token
  claudeOut: num(env.PRICE_OUT_PER_MTOK, 10) / 1e6,
  sttPerSecond: 0.000513 / 60,
  ttsPerChar: 0.03 / 1000,
});

export async function record(env: Env, kind: "claude" | "stt" | "tts", units: number, cost: number): Promise<void> {
  const { ymd } = todayBounds(env);
  await env.DB.prepare(
    `INSERT INTO usage (day, kind, units, cost) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, kind) DO UPDATE SET units = units + excluded.units, cost = cost + excluded.cost`,
  )
    .bind(ymd, kind, units, cost)
    .run();
}

export async function spendToday(
  env: Env,
): Promise<{ spent: number; budget: number; base: number; byKind: Record<string, number> }> {
  const { ymd } = todayBounds(env);
  const rows = await env.DB.prepare("SELECT kind, cost FROM usage WHERE day = ?").bind(ymd).all<{ kind: string; cost: number }>();
  const byKind: Record<string, number> = {};
  let spent = 0;
  for (const r of rows.results) {
    byKind[r.kind] = r.cost;
    spent += r.cost;
  }
  const extra = Number((await kvGet(env, `budget_extra:${ymd}`)) ?? 0);
  const base = num((await kvGet(env, "daily_budget")) ?? env.DAILY_BUDGET_USD, 2);
  return { spent, budget: base + extra, base, byKind };
}

export async function overBudget(env: Env): Promise<boolean> {
  const s = await spendToday(env);
  return s.spent >= s.budget;
}

/** Owner-only: set the standing daily cap (USD). */
export async function setBudget(env: Env, usd: number): Promise<void> {
  await kvSet(env, "daily_budget", String(usd));
}

/** Owner-only: raise today's cap. Resets at midnight (owner's timezone). */
export async function extendBudget(env: Env, usd: number): Promise<void> {
  const { ymd } = todayBounds(env);
  const extra = Number((await kvGet(env, `budget_extra:${ymd}`)) ?? 0);
  await kvSet(env, `budget_extra:${ymd}`, String(extra + usd));
}

export const BUDGET_MESSAGE =
  "Today's spending cap is reached, sir, so I've stopped using paid services. Open Settings and allow more for today if you want me to carry on.";
