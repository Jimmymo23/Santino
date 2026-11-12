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
  // TODO(Sprint 1): encrypt at rest.
  if (t.refresh_token) await kvSet(env, "google_refresh_token", t.refresh_token);
  await kvSet(env, "google_access", JSON.stringify({ token: t.access_token, exp: Date.now() + t.expires_in * 1000 }));
}

export async function googleConnected(env: Env): Promise<boolean> {
  return (await kvGet(env, "google_refresh_token")) !== null;
}

async function accessToken(env: Env): Promise<string> {
  const cached = await kvGet(env, "google_access");
  if (cached) {
    const c = JSON.parse(cached) as { token: string; exp: number };
    if (c.exp > Date.now() + 60_000) return c.token;
  }
  const refresh = await kvGet(env, "google_refresh_token");
  if (!refresh) throw new Error("Google is not connected. Ask the owner to tap Connect Google in the app.");
  const t = await tokenRequest(env, { refresh_token: refresh, grant_type: "refresh_token" });
  await kvSet(env, "google_access", JSON.stringify({ token: t.access_token, exp: Date.now() + t.expires_in * 1000 }));
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
      const out = [];
      for (const m of list.messages ?? []) {
        const msg = await g(
          env,
          `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        out.push({
          id: m.id,
          from: header(msg, "from"),
          subject: header(msg, "subject"),
          date: header(msg, "date"),
          snippet: msg.snippet,
        });
      }
      return out;
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
      "Create a calendar event, optionally inviting attendees and adding a Google Meet link. Requires owner approval.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime with offset" },
        end: { type: "string", description: "ISO datetime with offset" },
        attendees: { type: "array", items: { type: "string" }, description: "emails" },
        description: { type: "string" },
        meet: { type: "boolean" },
      },
      required: ["title", "start", "end"],
    },
    risk: "approval",
    summarize: (i) =>
      `Meeting: ${i.title}\n${i.start} → ${i.end}${i.attendees?.length ? `\nInvite: ${i.attendees.join(", ")}` : ""}`,
    run: async (env, i) => {
      const body: any = {
        summary: i.title,
        description: i.description,
        start: { dateTime: new Date(i.start).toISOString() },
        end: { dateTime: new Date(i.end).toISOString() },
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
      return { created: true, link: r.htmlLink, meet: r.hangoutLink };
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
