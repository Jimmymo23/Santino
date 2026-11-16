import { type Env, type Tool, now } from "./types";

// Long-term memory. Facts are saved only when the owner asks; the model is
// told so in the system prompt, and nothing from email, WhatsApp, web pages or
// transcripts may be saved on the model's own initiative.

const KINDS = ["person", "preference", "decision", "business", "other"];
// Refuse anything that looks like a credential or card/ID number.
const SECRET = /(\b\d[\d -]{11,22}\d\b)|(pass(word|code)|\bpin\b|api[ _-]?key|secret|token)\s*(is|:|=)|\bsk-[A-Za-z0-9_-]{10,}|GOCSPX-/i;

interface Memory {
  id: number;
  kind: string;
  subject: string | null;
  fact: string;
  updated_at: string;
}

export async function listMemories(env: Env): Promise<Memory[]> {
  return (
    await env.DB.prepare("SELECT id, kind, subject, fact, updated_at FROM memories ORDER BY updated_at DESC LIMIT 500").all<Memory>()
  ).results;
}

/** Text block for the system prompt: recent memories plus any matching the message. */
export async function memoryContext(env: Env, userText: string): Promise<string> {
  const all = await listMemories(env);
  if (!all.length) return "";
  const words = [...new Set(userText.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const score = (m: Memory) => {
    const hay = `${m.subject ?? ""} ${m.fact}`.toLowerCase();
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
  };
  const picked = new Map<number, Memory>();
  for (const m of [...all].sort((a, b) => score(b) - score(a)).filter((m) => score(m) > 0).slice(0, 25)) picked.set(m.id, m);
  for (const m of all) {
    if (picked.size >= 60) break;
    picked.set(m.id, m);
  }
  let out = "";
  for (const m of picked.values()) {
    const line = `- #${m.id} [${m.kind}${m.subject ? `: ${m.subject}` : ""}] ${m.fact} (${m.updated_at.slice(0, 10)})\n`;
    if (out.length + line.length > 6000) break;
    out += line;
  }
  return out + (all.length > picked.size ? `(${all.length - picked.size} more: use memory_search)\n` : "");
}

export const memoryTools: Tool[] = [
  {
    name: "memory_save",
    description:
      "Save one durable fact to long-term memory. Use ONLY when the owner explicitly asks you to remember, note or keep something, or states a standing rule ('from now on…'). One fact per call, written so it makes sense on its own later. Never store passwords, card, bank or ID numbers, or keys.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string" },
        kind: { type: "string", enum: KINDS },
        subject: { type: "string", description: "who or what it is about, e.g. a person's or company's name" },
      },
      required: ["fact", "kind"],
    },
    risk: "auto",
    run: async (env, i) => {
      const fact = String(i.fact ?? "").trim().slice(0, 600);
      if (!fact) throw new Error("Nothing to remember");
      if (SECRET.test(fact)) throw new Error("That looks like a password, key or card/ID number. Santino does not store those.");
      const r = await env.DB.prepare("INSERT INTO memories (kind, subject, fact, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(KINDS.includes(i.kind) ? i.kind : "other", i.subject ? String(i.subject).slice(0, 80) : null, fact, now(), now())
        .run();
      return { saved: r.meta.last_row_id };
    },
  },
  {
    name: "memory_update",
    description: "Correct or replace an existing memory by id when the owner says it changed.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" }, fact: { type: "string" } },
      required: ["id", "fact"],
    },
    risk: "auto",
    run: async (env, i) => {
      const fact = String(i.fact ?? "").trim().slice(0, 600);
      if (SECRET.test(fact)) throw new Error("That looks like a password, key or card/ID number. Santino does not store those.");
      const r = await env.DB.prepare("UPDATE memories SET fact = ?, updated_at = ? WHERE id = ?").bind(fact, now(), i.id).run();
      if (!r.meta.changes) throw new Error(`Memory ${i.id} not found`);
      return { updated: i.id };
    },
  },
  {
    name: "memory_forget",
    description: "Delete a memory by id when the owner asks you to forget it.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    risk: "auto",
    run: async (env, i) => {
      const r = await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(i.id).run();
      if (!r.meta.changes) throw new Error(`Memory ${i.id} not found`);
      return { forgotten: i.id };
    },
  },
  {
    name: "memory_search",
    description: "Search long-term memory by keyword when the answer is not in the memories already shown to you.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    risk: "auto",
    run: async (env, i) => {
      const q = `%${String(i.query ?? "").trim()}%`;
      return (
        await env.DB.prepare(
          "SELECT id, kind, subject, fact, updated_at FROM memories WHERE fact LIKE ?1 OR subject LIKE ?1 ORDER BY updated_at DESC LIMIT 20",
        )
          .bind(q)
          .all()
      ).results;
    },
  },
];
