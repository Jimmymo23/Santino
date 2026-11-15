import { googleConnected, googleTools } from "./google";
import { type Env, type Tool, kvGet, kvSet, now } from "./types";

const gtool = (name: string) => googleTools.find((t) => t.name === name)!;

/** Start and end of "today" in the owner's timezone, as UTC instants. */
export function todayBounds(env: Env): { ymd: string; hour: number; start: Date; end: Date } {
  const tz = env.TIMEZONE ?? "Africa/Cairo";
  const d = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const local = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  const offsetMs = Math.round((local.getTime() - d.getTime()) / 60_000) * 60_000;
  const start = new Date(Date.parse(`${ymd}T00:00:00Z`) - offsetMs);
  return { ymd, hour: local.getHours(), start, end: new Date(start.getTime() + 86_400_000) };
}

async function googleSnapshot(env: Env, fresh: boolean): Promise<{ agenda: unknown[]; unread: unknown[] } | null> {
  if (!(await googleConnected(env))) return null;
  if (!fresh) {
    const cached = await kvGet(env, "dash_google");
    if (cached) {
      const c = JSON.parse(cached) as { at: number; data: { agenda: unknown[]; unread: unknown[] } };
      if (Date.now() - c.at < 5 * 60_000) return c.data;
    }
  }
  const { start, end } = todayBounds(env);
  const [agenda, unread] = await Promise.all([
    gtool("calendar_agenda")
      .run(env, { from: start.toISOString(), to: end.toISOString() })
      .catch(() => []),
    gtool("gmail_search")
      .run(env, { query: "is:unread in:inbox newer_than:2d", max: 6 })
      .catch(() => []),
  ]);
  const data = { agenda: agenda as unknown[], unread: unread as unknown[] };
  await kvSet(env, "dash_google", JSON.stringify({ at: Date.now(), data }));
  return data;
}

/** One picture of the owner's day. Feeds the HUD tiles and the model's briefs. */
export async function snapshot(env: Env, fresh = false) {
  const t = now();
  const { end } = todayBounds(env);
  const db = env.DB;
  const [open, overdue, blocked, dueToday, reminders, approvals, google] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").first<{ n: number }>(),
    db
      .prepare(
        `SELECT t.id, t.title, t.due_at, p.name AS assignee FROM tasks t LEFT JOIN people p ON p.id = t.assignee_id
         WHERE t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ? ORDER BY t.due_at LIMIT 10`,
      )
      .bind(t)
      .all(),
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'blocked'").first<{ n: number }>(),
    db
      .prepare(
        `SELECT t.id, t.title, t.due_at, p.name AS assignee FROM tasks t LEFT JOIN people p ON p.id = t.assignee_id
         WHERE t.status = 'open' AND t.due_at >= ? AND t.due_at < ? ORDER BY t.due_at LIMIT 10`,
      )
      .bind(t, end.toISOString())
      .all(),
    db.prepare("SELECT text, at FROM reminders WHERE fired = 0 ORDER BY at LIMIT 5").all(),
    db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first<{ n: number }>(),
    googleSnapshot(env, fresh),
  ]);
  return {
    generated_at: t,
    tasks: {
      open: open?.n ?? 0,
      blocked: blocked?.n ?? 0,
      overdue: overdue.results,
      due_today: dueToday.results,
    },
    reminders: reminders.results,
    approvals_pending: approvals?.n ?? 0,
    google_connected: google !== null,
    agenda_today: google?.agenda ?? [],
    unread_email: google?.unread ?? [],
  };
}

export const briefTools: Tool[] = [
  {
    name: "day_snapshot",
    description:
      "One call that returns the owner's day: open/overdue/blocked tasks, tasks due today, today's calendar, unread email, upcoming reminders, items awaiting approval. Use it for any brief, 'my day', 'what's going on', status or summary request before answering.",
    input_schema: { type: "object", properties: {} },
    risk: "auto",
    run: (env) => snapshot(env, true),
  },
];
