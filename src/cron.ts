import { queueApproval } from "./tools";
import { type Env, notify, now } from "./types";

export async function runCron(env: Env): Promise<void> {
  const t = now();

  // 1. Reminders that are due.
  const due = await env.DB.prepare("SELECT id, text FROM reminders WHERE fired = 0 AND at <= ?").bind(t).all<{
    id: number;
    text: string;
  }>();
  for (const r of due.results) {
    await env.DB.prepare("UPDATE reminders SET fired = 1 WHERE id = ?").bind(r.id).run();
    await notify(env, "reminder", r.text);
  }

  // 2. Task follow-ups: draft a WhatsApp nudge and queue it for approval.
  const follow = await env.DB.prepare(
    `SELECT t.id, t.title, t.due_at, p.name, p.whatsapp
     FROM tasks t LEFT JOIN people p ON p.id = t.assignee_id
     WHERE t.status = 'open' AND t.follow_up_at IS NOT NULL AND t.follow_up_at <= ?`,
  )
    .bind(t)
    .all<{ id: number; title: string; due_at: string | null; name: string | null; whatsapp: string | null }>();
  for (const f of follow.results) {
    await env.DB.prepare("UPDATE tasks SET follow_up_at = NULL, updated_at = ? WHERE id = ?").bind(t, f.id).run();
    if (f.name && f.whatsapp) {
      // TODO(Sprint 3): let the model write this in the owner's tone and language.
      await queueApproval(env, "whatsapp_send", {
        person: f.name,
        text: `أهلاً ${f.name}، إيه آخر الأخبار في "${f.title}"؟`,
      });
      await notify(env, "followup", `Follow-up to ${f.name} on "${f.title}" is waiting for your approval.`);
    } else {
      await notify(env, "followup", `Time to follow up on "${f.title}".`);
    }
  }
}
