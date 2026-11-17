import { secretGet, secretSet } from "./crypto";
import { type Env, type Tool, kvGet, kvSet } from "./types";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

const redirectUri = (env: Env) => `${env.APP_URL}/auth/google/callback`;

export function googleAuthUrl(env: Env, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<any> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function googleExchangeCode(env: Env, code: string): Promise<void> {
  const t = await tokenRequest(env, { code, grant_type: "authorization_code", redirect_uri: redirectUri(env) });
  if (t.refresh_token) await secretSet(env, "google_refresh_token", t.refresh_token);
  await secretSet(env, "google_access", JSON.stringify({ token: t.access_token, exp: Date.now() + t.expires_in * 1000 }));
}

export async function googleConnected(env: Env): Promise<boolean> {
  return (await kvGet(env, "google_refresh_token")) !== null;
}

async function accessToken(env: Env): Promise<string> {
  const cached = await secretGet(env, "google_access");
  if (cached) {
    const c = JSON.parse(cached) as { token: string; exp: number };
    if (c.exp > Date.now() + 60_000) return c.token;
  }
  const refresh = await secretGet(env, "google_refresh_token");
  if (!refresh) throw new Error("Google is not connected. Ask the owner to tap Connect Google in the app.");
  const t = await tokenRequest(env, { refresh_token: refresh, grant_type: "refresh_token" });
  await secretSet(env, "google_access", JSON.stringify({ token: t.access_token, exp: Date.now() + t.expires_in * 1000 }));
  return t.access_token;
}

async function g(env: Env, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken(env)}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

const b64url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

const header = (msg: any, name: string): string =>
  msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name)?.value ?? "";

function plainBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return fromB64url(payload.body.data);
  for (const part of payload.parts ?? []) {
    const t = plainBody(part);
    if (t) return t;
  }
  return "";
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

/** "Tue 17 Nov, 18:45-20:15" in the owner's timezone, for approval cards. */
function when(start: string, end?: string): string {
  const tz = "Africa/Cairo";
  const d = new Date(start);
  const day = d.toLocaleDateString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  const t = (x: Date) => x.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  return `${day}, ${t(d)}${end ? `-${t(new Date(end))}` : ""}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** An existing event with the same title starting at the same minute, if any. */
async function sameEvent(env: Env, title: string, start: Date): Promise<{ id: string; htmlLink: string } | null> {
  const p = new URLSearchParams({
    timeMin: new Date(start.getTime() - 60_000).toISOString(),
    timeMax: new Date(start.getTime() + 60_000).toISOString(),
    singleEvents: "true",
    maxResults: "20",
  });
  const r = await g(env, `${CAL}/events?${p}`);
  const want = norm(title);
  const hit = (r.items ?? []).find(
    (e: any) => norm(e.summary ?? "") === want && Math.abs(Date.parse(e.start?.dateTime ?? e.start?.date) - start.getTime()) < 60_000,
  );
  return hit ? { id: hit.id, htmlLink: hit.htmlLink } : null;
}

export const googleTools: Tool[] = [
  {
    name: "gmail_search",
    description:
      "Search the owner's Gmail with Gmail query syntax (e.g. 'is:unread newer_than:2d', 'from:ahmed invoice'). Returns id, from, subject, date, snippet.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, max: { type: "integer", description: "1-15, default 8" } },
      required: ["query"],
    },
    risk: "auto",
    run: async (env, { query, max }) => {
      const n = Math.min(Math.max(Number(max) || 8, 1), 15);
      const list = await g(env, `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=${n}`);
      // Fetch the messages side by side instead of one after another.
      return Promise.all(
        ((list.messages ?? []) as { id: string }[]).map(async (m) => {
          const msg = await g(
            env,
            `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          );
          return {
            id: m.id,
            from: header(msg, "from"),
            subject: header(msg, "subject"),
            date: header(msg, "date"),
            snippet: msg.snippet,
          };
        }),
      );
    },
  },
  {
    name: "gmail_read",
    description: "Read one email's full text by id (from gmail_search).",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "auto",
    run: async (env, { id }) => {
      const msg = await g(env, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
      return {
        from: header(msg, "from"),
        to: header(msg, "to"),
        subject: header(msg, "subject"),
        date: header(msg, "date"),
        body: plainBody(msg.payload).slice(0, 8000) || msg.snippet,
      };
    },
  },
  {
    name: "gmail_send",
    description: "Send an email from the owner's account. Requires owner approval; it is queued, not sent immediately.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
    risk: "approval",
    summarize: (i) => `Email to ${i.to}\nSubject: ${i.subject}\n\n${i.body}`,
    run: async (env, { to, subject, body }) => {
      if (/[\r\n]/.test(`${to}${subject}`)) throw new Error("Invalid header value");
      const raw = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        body,
      ].join("\r\n");
      const r = await g(env, `${GMAIL}/messages/send`, { method: "POST", body: JSON.stringify({ raw: b64url(raw) }) });
      return { sent: true, id: r.id };
    },
  },
  {
    name: "calendar_agenda",
    description: "List calendar events between two ISO datetimes.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
    risk: "auto",
    run: async (env, { from, to }) => {
      const p = new URLSearchParams({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "30",
      });
      const r = await g(env, `${CAL}/events?${p}`);
      return (r.items ?? []).map((e: any) => ({
        id: e.id,
        title: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        attendees: (e.attendees ?? []).map((a: any) => a.email),
        location: e.location,
      }));
    },
  },
  {
    name: "calendar_create",
    description:
      "Create a calendar event, optionally with a location, attendees and a Google Meet link. Check calendar_agenda first so you never create a duplicate. Requires owner approval.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime with offset" },
        end: { type: "string", description: "ISO datetime with offset" },
        location: { type: "string", description: "street address or place name; lets Santino send traffic alerts" },
        attendees: { type: "array", items: { type: "string" }, description: "emails" },
        description: { type: "string" },
        meet: { type: "boolean" },
      },
      required: ["title", "start", "end"],
    },
    risk: "approval",
    summarize: (i) =>
      `Meeting: ${i.title}\n${when(i.start, i.end)}${i.location ? `\nAt: ${i.location}` : ""}${i.attendees?.length ? `\nInvite: ${i.attendees.join(", ")}` : ""}`,
    run: async (env, i) => {
      // Safety net against duplicates: an event with the same title and start already there is reused.
      const start = new Date(i.start), end = new Date(i.end);
      const existing = await sameEvent(env, i.title, start);
      if (existing) return { created: false, already_exists: true, id: existing.id, link: existing.htmlLink };
      const body: any = {
        summary: i.title,
        description: i.description,
        location: i.location,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: (i.attendees ?? []).map((email: string) => ({ email })),
      };
      if (i.meet)
        body.conferenceData = {
          createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
        };
      const r = await g(env, `${CAL}/events?sendUpdates=all&conferenceDataVersion=1`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { created: true, id: r.id, link: r.htmlLink, meet: r.hangoutLink };
    },
  },
  {
    name: "calendar_update",
    description:
      "Change an existing calendar event by id (from calendar_agenda): title, time, location or description. Attendees are notified. Requires owner approval.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string", description: "current title, shown on the approval card; or the new title if renaming" },
        new_title: { type: "string" },
        start: { type: "string", description: "new start, ISO datetime with offset" },
        end: { type: "string", description: "new end, ISO datetime with offset" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["id", "title"],
    },
    risk: "approval",
    summarize: (i) =>
      `Change event: ${i.title}${i.new_title ? `\nRename to: ${i.new_title}` : ""}${i.start ? `\nMove to: ${when(i.start, i.end)}` : ""}${i.location ? `\nAt: ${i.location}` : ""}`,
    run: async (env, i) => {
      const patch: any = {};
      if (i.new_title) patch.summary = i.new_title;
      if (i.start) patch.start = { dateTime: new Date(i.start).toISOString() };
      if (i.end) patch.end = { dateTime: new Date(i.end).toISOString() };
      if (i.location !== undefined) patch.location = i.location;
      if (i.description !== undefined) patch.description = i.description;
      const r = await g(env, `${CAL}/events/${encodeURIComponent(i.id)}?sendUpdates=all`, { method: "PATCH", body: JSON.stringify(patch) });
      return { updated: true, link: r.htmlLink };
    },
  },
  {
    name: "calendar_delete",
    description:
      "Delete a calendar event by id (from calendar_agenda), e.g. a duplicate or a cancelled plan. Attendees get a cancellation. Requires owner approval.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string", description: "the event's title, shown on the approval card" },
        start: { type: "string", description: "the event's start, shown on the approval card" },
      },
      required: ["id", "title"],
    },
    risk: "approval",
    summarize: (i) => `Delete event: ${i.title}${i.start ? `\n${when(i.start)}` : ""}`,
    run: async (env, i) => {
      const res = await fetch(`${CAL}/events/${encodeURIComponent(i.id)}?sendUpdates=all`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await accessToken(env)}` },
      });
      if (res.status === 404 || res.status === 410) return { deleted: true, note: "It was already gone." };
      if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { deleted: true };
    },
  },
  {
    name: "expense_add",
    description: "Append an expense row to the owner's Expenses Google Sheet (created automatically on first use).",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        amount: { type: "number" },
        currency: { type: "string", description: "e.g. EGP, AED, USD" },
        category: { type: "string" },
        description: { type: "string" },
        business: { type: "string", description: "which company/brand it belongs to, if said" },
      },
      required: ["date", "amount", "currency", "description"],
    },
    risk: "auto",
    run: async (env, i) => {
      let id = await kvGet(env, "expenses_sheet_id");
      if (!id) {
        const s = await g(env, SHEETS, {
          method: "POST",
          body: JSON.stringify({ properties: { title: "Santino Expenses" }, sheets: [{ properties: { title: "Expenses" } }] }),
        });
        id = s.spreadsheetId as string;
        await kvSet(env, "expenses_sheet_id", id);
        await g(env, `${SHEETS}/${id}/values/Expenses!A1:append?valueInputOption=USER_ENTERED`, {
          method: "POST",
          body: JSON.stringify({ values: [["Date", "Amount", "Currency", "Category", "Description", "Business"]] }),
        });
      }
      await g(env, `${SHEETS}/${id}/values/Expenses!A1:append?valueInputOption=USER_ENTERED`, {
        method: "POST",
        body: JSON.stringify({
          values: [[i.date, i.amount, i.currency, i.category ?? "", i.description, i.business ?? ""]],
        }),
      });
      return { added: true, sheet: `https://docs.google.com/spreadsheets/d/${id}` };
    },
  },
];
