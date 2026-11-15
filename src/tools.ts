import { briefTools } from "./brief";
import { googleTools } from "./google";
import { type Env, type Tool, audit, now } from "./types";
import { whatsappTools } from "./whatsapp";

async function personId(env: Env, name?: string): Promise<number | null> {
  if (!name) return null;
  const p = await env.DB.prepare("SELECT id FROM people WHERE name LIKE ? LIMIT 1").bind(`%${name}%`).first<{ id: number }>();
  if (!p) throw new Error(`No team member matching "${name}". Add them with team_save first.`);
  return p.id;
}

const iso = (v?: string) => (v ? new Date(v).toISOString() : null);

const coreTools: Tool[] = [
  {
    name: "team_list",
    description: "List team members in the directory.",
    input_schema: { type: "object", properties: {} },
    risk: "auto",
    run: async (env) => (await env.DB.prepare("SELECT id, name, whatsapp, email, role, notes FROM people").all()).results,
  },
  {
    name: "team_save",
    description: "Add a team member, or update one by id.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        whatsapp: { type: "string", description: "international format, e.g. +2010..." },
        email: { type: "string" },
        role: { type: "string" },
        notes: { type: "string" },
      },
      required: ["name"],
    },
    risk: "auto",
    run: async (env, i) => {
      if (i.id) {
        await env.DB.prepare(
          "UPDATE people SET name = ?, whatsapp = COALESCE(?, whatsapp), email = COALESCE(?, email), role = COALESCE(?, role), notes = COALESCE(?, notes) WHERE id = ?",
        )
          .bind(i.name, i.whatsapp ?? null, i.email ?? null, i.role ?? null, i.notes ?? null, i.id)
          .run();
        return { updated: i.id };
      }
      const r = await env.DB.prepare("INSERT INTO people (name, whatsapp, email, role, notes) VALUES (?, ?, ?, ?, ?)")
        .bind(i.name, i.whatsapp ?? null, i.email ?? null, i.role ?? null, i.notes ?? null)
        .run();
      return { created: r.meta.last_row_id };
    },
  },
  {
    name: "task_create",
    description:
      "Create a task, optionally assigned to a team member. Set follow_up_at to have a WhatsApp follow-up drafted for approval at that time.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        assignee: { type: "string", description: "team member name" },
        due_at: { type: "string", description: "ISO datetime with offset" },
        follow_up_at: { type: "string", description: "ISO datetime with offset" },
        notes: { type: "string" },
      },
      required: ["title"],
    },
    risk: "auto",
    run: async (env, i) => {
      const r = await env.DB.prepare(
        "INSERT INTO tasks (title, assignee_id, due_at, follow_up_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(i.title, await personId(env, i.assignee), iso(i.due_at), iso(i.follow_up_at), i.notes ?? null, now(), now())
        .run();
      return { created: r.meta.last_row_id };
    },
  },
  {
    name: "task_list",
    description: "List tasks. Filter by status (open, done, blocked) and/or assignee name.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string" }, assignee: { type: "string" } },
    },
    risk: "auto",
    run: async (env, i) => {
      const where: string[] = [];
      const args: unknown[] = [];
      if (i.status) (where.push("t.status = ?"), args.push(i.status));
      if (i.assignee) (where.push("p.name LIKE ?"), args.push(`%${i.assignee}%`));
      const sql = `SELECT t.id, t.title, t.status, t.due_at, t.follow_up_at, t.notes, p.name AS assignee
                   FROM tasks t LEFT JOIN people p ON p.id = t.assignee_id
                   ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY t.due_at IS NULL, t.due_at LIMIT 50`;
      return (await env.DB.prepare(sql).bind(...args).all()).results;
    },
  },
  {
    name: "task_update",
    description: "Update a task by id: status (open, done, blocked), due date, follow-up time, assignee, or append a note.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        status: { type: "string", enum: ["open", "done", "blocked"] },
        due_at: { type: "string" },
        follow_up_at: { type: "string" },
        assignee: { type: "string" },
        add_note: { type: "string" },
      },
      required: ["id"],
    },
    risk: "auto",
    run: async (env, i) => {
      const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(i.id).first<any>();
      if (!t) throw new Error(`Task ${i.id} not found`);
      await env.DB.prepare(
        "UPDATE tasks SET status = ?, due_at = ?, follow_up_at = ?, assignee_id = ?, notes = ?, updated_at = ? WHERE id = ?",
      )
        .bind(
          i.status ?? t.status,
          i.due_at ? iso(i.due_at) : t.due_at,
          i.follow_up_at ? iso(i.follow_up_at) : t.follow_up_at,
          i.assignee ? await personId(env, i.assignee) : t.assignee_id,
          i.add_note ? [t.notes, i.add_note].filter(Boolean).join("\n") : t.notes,
          now(),
          i.id,
        )
        .run();
      return { updated: i.id };
    },
  },
  {
    name: "reminder_create",
    description: "Remind the owner of something at a specific time.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, at: { type: "string", description: "ISO datetime with offset" } },
      required: ["text", "at"],
    },
    risk: "auto",
    run: async (env, i) => {
      const r = await env.DB.prepare("INSERT INTO reminders (text, at) VALUES (?, ?)").bind(i.text, iso(i.at)).run();
      return { created: r.meta.last_row_id };
    },
  },
  {
    name: "reminder_list",
    description: "List upcoming reminders.",
    input_schema: { type: "object", properties: {} },
    risk: "auto",
    run: async (env) =>
      (await env.DB.prepare("SELECT id, text, at FROM reminders WHERE fired = 0 ORDER BY at LIMIT 30").all()).results,
  },
];

export const tools: Tool[] = [...coreTools, ...briefTools, ...googleTools, ...whatsappTools];
const byName = new Map(tools.map((t) => [t.name, t]));

/** Queue an action for the owner's approval. Used by the agent and by cron. */
export async function queueApproval(env: Env, toolName: string, input: unknown): Promise<string> {
  const tool = byName.get(toolName);
  if (!tool) throw new Error(`Unknown tool ${toolName}`);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO approvals (id, tool, input, summary, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, toolName, JSON.stringify(input), tool.summarize?.(input) ?? `${toolName}: ${JSON.stringify(input)}`, now())
    .run();
  return id;
}

/** Called by the agent loop. Approval tools are queued, never executed here. */
export async function executeTool(env: Env, name: string, input: unknown): Promise<unknown> {
  const tool = byName.get(name);
  if (!tool) return { error: `Unknown tool ${name}` };
  try {
    if (tool.risk === "approval") {
      const id = await queueApproval(env, name, input);
      return {
        status: "pending_approval",
        approval_id: id,
        note: "Not executed. The owner sees an approval card. Tell them briefly what is waiting for approval.",
      };
    }
    const result = await tool.run(env, input);
    await audit(env, `tool:${name}`, input);
    return result;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Called only from owner-authenticated code paths (approve endpoint, voice shortcut). */
export async function resolveApproval(env: Env, id: string, approve: boolean): Promise<{ ok: boolean; message: string }> {
  // Claim atomically so a double tap cannot execute twice.
  const claim = await env.DB.prepare(
    "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(approve ? "running" : "rejected", now(), id)
    .run();
  if (!claim.meta.changes) return { ok: false, message: "Already handled." };
  if (!approve) {
    await audit(env, "approval_rejected", { id });
    return { ok: true, message: "Cancelled." };
  }
  const row = await env.DB.prepare("SELECT tool, input FROM approvals WHERE id = ?").bind(id).first<{
    tool: string;
    input: string;
  }>();
  const tool = row && byName.get(row.tool);
  try {
    if (!row || !tool) throw new Error("Tool no longer exists");
    const result = await tool.run(env, JSON.parse(row.input));
    await env.DB.prepare("UPDATE approvals SET status = 'done', result = ? WHERE id = ?")
      .bind(JSON.stringify(result), id)
      .run();
    await audit(env, `approved:${row.tool}`, JSON.parse(row.input));
    return { ok: true, message: "Done." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE approvals SET status = 'failed', result = ? WHERE id = ?").bind(msg, id).run();
    return { ok: false, message: `Failed: ${msg}` };
  }
}
