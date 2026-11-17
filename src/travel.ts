import { secretGet, secretSet } from "./crypto";
import { googleConnected, googleTools } from "./google";
import { notify } from "./push";
import { type Env, type Tool, audit, kvGet, kvSet, now } from "./types";
import { overBudget, record } from "./usage";

// Travel times with live traffic (Google Maps Routes API) and trip watching:
// Santino tells the owner when to leave and warns when traffic gets worse.

const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
// Traffic-aware requests bill as "Compute Routes Pro". List price per request,
// before Google's monthly free allowance; used only for the cost meter.
const COST_PER_ROUTE = 10 / 1000;
const MODES: Record<string, string> = { drive: "DRIVE", walk: "WALK", transit: "TRANSIT", two_wheeler: "TWO_WHEELER" };
const MIN = 60_000;

export interface Route {
  minutes: number; // with traffic (or plain duration for walk/transit)
  usualMinutes: number; // without traffic
  km: number;
  via: string;
}

const secs = (d?: string) => (d ? Number(String(d).replace(/s$/, "")) : NaN);
const round = (n: number) => Math.round(n * 10) / 10;

// ---------- where he is ----------

/** The phone's latest position, if he shares it and it is recent. */
export async function liveLocation(env: Env, maxAgeMin = 30): Promise<{ lat: number; lng: number; ageMin: number } | null> {
  const raw = await secretGet(env, "last_location");
  if (!raw) return null;
  const l = JSON.parse(raw) as { lat: number; lng: number; at: string };
  const ageMin = Math.round((Date.now() - Date.parse(l.at)) / MIN);
  return ageMin <= maxAgeMin ? { lat: l.lat, lng: l.lng, ageMin } : null;
}

const latLng = (lat: number, lng: number): Waypoint => ({ location: { latLng: { latitude: lat, longitude: lng } } });
// Places saved from his phone's position are stored as "@lat,lng".
const AT = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const toWaypoint = (address: string): Waypoint => {
  const m = address.match(AT);
  return m ? latLng(Number(m[1]), Number(m[2])) : { address };
};

/** What Santino knows about where he is, for the system prompt. */
export async function situation(env: Env): Promise<string> {
  if (!env.GOOGLE_MAPS_KEY) return "Location: Google Maps is not connected.";
  const [loc, places] = await Promise.all([
    liveLocation(env, 24 * 60),
    env.DB.prepare("SELECT label FROM places ORDER BY label").all<{ label: string }>(),
  ]);
  const p = places.results.map((r) => r.label);
  const where = !loc
    ? "His phone has not shared a location."
    : loc.ageMin <= 30
      ? `His phone shared its location ${loc.ageMin} min ago: travel_time and trip_watch without an origin start from where he is now.`
      : `His phone last shared its location ${Math.round(loc.ageMin / 60)}h ago (too old to treat as where he is now).`;
  return `Location: ${where} Saved places: ${p.length ? p.join(", ") : "none"}. If he says "I'm at home/the office now", save it with place_save using address "current location".`;
}

export async function saveLocation(env: Env, lat: number, lng: number, acc?: number): Promise<void> {
  await secretSet(env, "last_location", JSON.stringify({ lat, lng, acc, at: now() }));
}

export async function place(env: Env, name: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT address FROM places WHERE name = ?").bind(name.trim().toLowerCase()).first<{ address: string }>();
  return r?.address ?? null;
}

type Waypoint = { address: string } | { location: { latLng: { latitude: number; longitude: number } } };

/** A saved place name, an address, or (no origin) his live location, else home. */
async function resolve(env: Env, spot: string | null | undefined, isOrigin: boolean): Promise<{ wp: Waypoint; label: string }> {
  if (spot && spot.trim() && !/^(here|current location|my location|where i am)$/i.test(spot.trim())) {
    const saved = await place(env, spot);
    return { wp: toWaypoint(saved ?? spot.trim()), label: spot.trim() };
  }
  if (!isOrigin) throw new Error("No destination given.");
  const here = await liveLocation(env);
  if (here) return { wp: latLng(here.lat, here.lng), label: "your current location" };
  const home = await place(env, "home");
  if (home) return { wp: toWaypoint(home), label: "home" };
  const last = await liveLocation(env, 12 * 60); // better than nothing for a trip check
  if (last) return { wp: latLng(last.lat, last.lng), label: "your last known location" };
  throw new Error("I don't know where you are. Turn on location sharing in Settings, or tell me your home address.");
}

export async function computeRoute(env: Env, origin: Waypoint, destination: Waypoint, mode = "drive", departAt?: string): Promise<Route> {
  if (!env.GOOGLE_MAPS_KEY) throw new Error("Google Maps is not connected yet (GOOGLE_MAPS_KEY is not set).");
  if (await overBudget(env)) throw new Error("Today's spending cap is reached.");
  const travelMode = MODES[mode] ?? "DRIVE";
  const traffic = travelMode === "DRIVE" || travelMode === "TWO_WHEELER";
  const body: Record<string, unknown> = { origin, destination, travelMode, languageCode: "en", units: "METRIC" };
  if (traffic) body.routingPreference = "TRAFFIC_AWARE";
  if (departAt && Date.parse(departAt) > Date.now() + MIN) body.departureTime = new Date(departAt).toISOString();
  const res = await fetch(env.MAPS_ROUTES_URL ?? ROUTES, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GOOGLE_MAPS_KEY,
      "x-goog-fieldmask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description",
    },
    body: JSON.stringify(body),
  });
  await record(env, "maps", 1, COST_PER_ROUTE);
  if (!res.ok) throw new Error(`Google Maps ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const r = ((await res.json()) as { routes?: any[] }).routes?.[0];
  if (!r) throw new Error("Google Maps found no route between those places.");
  const minutes = secs(r.duration) / 60;
  const usual = Number.isFinite(secs(r.staticDuration)) ? secs(r.staticDuration) / 60 : minutes;
  return { minutes: round(minutes), usualMinutes: round(usual), km: round((r.distanceMeters ?? 0) / 1000), via: r.description ?? "" };
}

const fmtTime = (env: Env, iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: env.TIMEZONE ?? "Africa/Cairo", hour: "2-digit", minute: "2-digit" });

function trafficWord(r: Route): string {
  const extra = r.minutes - r.usualMinutes;
  if (extra >= Math.max(10, r.usualMinutes * 0.3)) return `heavy traffic, ${Math.round(extra)} min slower than usual`;
  if (extra >= Math.max(5, r.usualMinutes * 0.15)) return `some traffic, ${Math.round(extra)} min slower than usual`;
  return "normal traffic";
}

// ---------- trip watching (runs from cron every minute) ----------

interface Trip {
  id: number;
  title: string;
  destination: string;
  origin: string | null;
  arrive_by: string;
  buffer_min: number;
  mode: string;
  baseline_min: number | null;
  alerted_min: number | null;
  notified_early: number;
  notified_leave: number;
}

/** How long until the next check: sparse far out, every few minutes near departure. */
function nextCheck(leaveAt: number): number {
  const lead = leaveAt - Date.now();
  if (lead > 120 * MIN) return Math.min(lead - 120 * MIN, 30 * MIN) || 30 * MIN;
  if (lead > 60 * MIN) return 15 * MIN;
  if (lead > 20 * MIN) return 5 * MIN;
  return 2 * MIN;
}

async function checkTrip(env: Env, t: Trip): Promise<void> {
  const arrive = Date.parse(t.arrive_by);
  if (Date.now() > arrive) {
    await env.DB.prepare("UPDATE trips SET status = 'done' WHERE id = ?").bind(t.id).run();
    return;
  }
  let r: Route;
  try {
    const [o, d] = await Promise.all([resolve(env, t.origin, true), resolve(env, t.destination, false)]);
    r = await computeRoute(env, o.wp, d.wp, t.mode);
  } catch (e) {
    // Try again later; tell him once if we cannot place him at all.
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE trips SET next_check_at = ? WHERE id = ?").bind(new Date(Date.now() + 10 * MIN).toISOString(), t.id).run();
    if (/don't know where you are/.test(msg) && !t.notified_early) {
      await env.DB.prepare("UPDATE trips SET notified_early = 1 WHERE id = ?").bind(t.id).run();
      await notify(env, "travel", `I can't time your trip to ${t.title}: ${msg}`);
    } else await audit(env, "trip_check_failed", { id: t.id, error: msg.slice(0, 200) });
    return;
  }
  const leaveAt = arrive - (r.minutes + t.buffer_min) * MIN;
  const leaveIso = new Date(leaveAt).toISOString();
  const baseline = t.baseline_min ?? r.minutes;
  const said = t.alerted_min ?? baseline;
  let early = t.notified_early, leave = t.notified_leave, alerted = t.alerted_min;
  const msgs: string[] = [];

  if (!leave && Date.now() >= leaveAt - MIN) {
    leave = 1; alerted = r.minutes;
    const late = Math.round((Date.now() - leaveAt) / MIN);
    msgs.push(
      late >= 3
        ? `You should have left for ${t.title} ${late} min ago, sir. It's ${Math.round(r.minutes)} min${r.via ? ` via ${r.via}` : ""} with ${trafficWord(r)}; leaving now gets you there around ${fmtTime(env, new Date(Date.now() + r.minutes * MIN).toISOString())}.`
        : `Time to leave for ${t.title}, sir. ${Math.round(r.minutes)} min${r.via ? ` via ${r.via}` : ""}; ${trafficWord(r)}.`,
    );
  } else if (!early && Date.now() >= leaveAt - 30 * MIN) {
    early = 1; alerted = r.minutes;
    msgs.push(`Leave by ${fmtTime(env, leaveIso)} for ${t.title}: ${Math.round(r.minutes)} min, ${trafficWord(r)}.`);
  } else if (r.minutes - said >= Math.max(10, said * 0.2) && leaveAt - Date.now() < 3 * 60 * MIN) {
    alerted = r.minutes;
    msgs.push(`Traffic got worse on the way to ${t.title}: now ${Math.round(r.minutes)} min (was ${Math.round(said)}). Leave by ${fmtTime(env, leaveIso)}.`);
  } else if (alerted !== null && said - r.minutes >= Math.max(10, said * 0.25) && !leave) {
    alerted = r.minutes;
    msgs.push(`Good news on ${t.title}: traffic eased, now ${Math.round(r.minutes)} min. You can leave at ${fmtTime(env, leaveIso)}.`);
  }

  const next = leave ? arrive + MIN : Date.now() + nextCheck(leaveAt);
  await env.DB.prepare(
    `UPDATE trips SET baseline_min = ?, last_min = ?, last_leave_at = ?, alerted_min = ?, notified_early = ?, notified_leave = ?,
       next_check_at = ?, status = CASE WHEN ? THEN 'done' ELSE status END WHERE id = ?`,
  )
    .bind(baseline, r.minutes, leaveIso, alerted, early, leave, new Date(next).toISOString(), leave ? 1 : 0, t.id)
    .run();
  for (const m of msgs) await notify(env, "travel", m);
}

/** Calendar events with a location in the next 4 hours become watched trips (if enabled). */
async function watchCalendar(env: Env): Promise<void> {
  if ((await kvGet(env, "auto_travel")) === "0" || !env.GOOGLE_MAPS_KEY || !(await googleConnected(env))) return;
  const last = Number((await kvGet(env, "auto_travel_checked")) ?? 0);
  if (Date.now() - last < 10 * MIN) return;
  await kvSet(env, "auto_travel_checked", String(Date.now()));
  const agenda = googleTools.find((t) => t.name === "calendar_agenda")!;
  const events = (await agenda
    .run(env, { from: new Date().toISOString(), to: new Date(Date.now() + 4 * 60 * MIN).toISOString() })
    .catch(() => [])) as { id: string; title?: string; start?: string; location?: string }[];
  for (const e of events) {
    if (!e.location || !e.start || !/T/.test(e.start) || /meet\.google|zoom\.us|teams\.microsoft|^https?:/i.test(e.location)) continue;
    // Already watching a trip he set up himself for about the same time: don't add a second.
    const mine = await env.DB.prepare(
      "SELECT id FROM trips WHERE status = 'active' AND source = 'manual' AND ABS(strftime('%s', arrive_by) - strftime('%s', ?)) <= 900",
    )
      .bind(new Date(e.start).toISOString())
      .first();
    if (mine) continue;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO trips (title, destination, arrive_by, source, event_id, next_check_at, created_at)
       VALUES (?, ?, ?, 'calendar', ?, ?, ?)`,
    )
      .bind((e.title ?? "your meeting").slice(0, 120), e.location.slice(0, 300), new Date(e.start).toISOString(), e.id, now(), now())
      .run();
  }
}

export async function runTravel(env: Env): Promise<void> {
  try {
    await watchCalendar(env);
  } catch (e) {
    await audit(env, "auto_travel_failed", { error: e instanceof Error ? e.message : String(e) });
  }
  const due = await env.DB.prepare(
    "SELECT * FROM trips WHERE status = 'active' AND next_check_at <= ? ORDER BY next_check_at LIMIT 5",
  )
    .bind(now())
    .all<Trip>();
  for (const t of due.results) await checkTrip(env, t);
}

// ---------- tools ----------

export const travelTools: Tool[] = [
  {
    name: "travel_time",
    description:
      "How long it takes to get somewhere, with live traffic (Google Maps). Origin defaults to his current location if he shares it, else his saved home. Places can be saved names ('home', 'office') or addresses. Give depart_at for a future departure, or arrive_by to get the time to leave.",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string" },
        origin: { type: "string" },
        depart_at: { type: "string", description: "ISO datetime with offset" },
        arrive_by: { type: "string", description: "ISO datetime with offset" },
        mode: { type: "string", enum: Object.keys(MODES) },
      },
      required: ["destination"],
    },
    risk: "auto",
    run: async (env, i) => {
      const [o, d] = await Promise.all([resolve(env, i.origin, true), resolve(env, i.destination, false)]);
      let r = await computeRoute(env, o.wp, d.wp, i.mode, i.depart_at);
      let leave_by: string | undefined;
      if (i.arrive_by) {
        const start = Date.parse(i.arrive_by) - r.minutes * MIN;
        if (start > Date.now() + 15 * MIN) r = await computeRoute(env, o.wp, d.wp, i.mode, new Date(start).toISOString()); // predicted traffic at that hour
        leave_by = fmtTime(env, new Date(Date.parse(i.arrive_by) - (r.minutes + 10) * MIN).toISOString());
      }
      return { from: o.label, to: d.label, minutes: r.minutes, usual_minutes: r.usualMinutes, km: r.km, via: r.via, traffic: trafficWord(r), leave_by };
    },
  },
  {
    name: "trip_watch",
    description:
      "Watch a trip: Santino checks traffic as the time approaches, notifies when to leave, and warns if traffic gets worse. Use when he is going somewhere at a set time and wants timing help or traffic alerts.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "short name, e.g. 'Padel at New Giza'" },
        destination: { type: "string" },
        arrive_by: { type: "string", description: "ISO datetime with offset" },
        origin: { type: "string", description: "leave empty to use his location at the time (or home)" },
        buffer_min: { type: "integer", description: "minutes of margin, default 10" },
        mode: { type: "string", enum: Object.keys(MODES) },
      },
      required: ["title", "destination", "arrive_by"],
    },
    risk: "auto",
    run: async (env, i) => {
      if (!env.GOOGLE_MAPS_KEY) throw new Error("Google Maps is not connected yet (GOOGLE_MAPS_KEY is not set).");
      const arrive = new Date(i.arrive_by);
      if (!(arrive.getTime() > Date.now())) throw new Error("That time has already passed.");
      const dup = await env.DB.prepare(
        "SELECT id FROM trips WHERE status = 'active' AND ABS(strftime('%s', arrive_by) - strftime('%s', ?)) <= 900 AND lower(destination) = lower(?)",
      )
        .bind(arrive.toISOString(), String(i.destination))
        .first<{ id: number }>();
      if (dup) return { already_watching: dup.id };
      const r = await env.DB.prepare(
        "INSERT INTO trips (title, destination, origin, arrive_by, buffer_min, mode, next_check_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(String(i.title).slice(0, 120), String(i.destination).slice(0, 300), i.origin ?? null, arrive.toISOString(),
          Math.min(Math.max(Number(i.buffer_min) || 10, 0), 120), MODES[i.mode] ? i.mode : "drive", now(), now())
        .run();
      return { watching: r.meta.last_row_id, note: "First traffic check runs within a minute; he gets a notification 30 min before leaving and at leave time." };
    },
  },
  {
    name: "trip_list",
    description: "Trips Santino is watching, with the latest travel time and leave-by time.",
    input_schema: { type: "object", properties: {} },
    risk: "auto",
    run: async (env) =>
      (
        await env.DB.prepare(
          "SELECT id, title, destination, arrive_by, last_min, last_leave_at, source FROM trips WHERE status = 'active' ORDER BY arrive_by LIMIT 20",
        ).all()
      ).results,
  },
  {
    name: "trip_cancel",
    description: "Stop watching a trip by id.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    risk: "auto",
    run: async (env, i) => {
      const r = await env.DB.prepare("UPDATE trips SET status = 'cancelled' WHERE id = ? AND status = 'active'").bind(i.id).run();
      if (!r.meta.changes) throw new Error(`No active trip ${i.id}`);
      return { cancelled: i.id };
    },
  },
  {
    name: "place_save",
    description:
      "Save a named place (e.g. home, office, the club) with its address. If he says he is there right now, pass address \"current location\" to save his phone's position.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, address: { type: "string" } },
      required: ["name", "address"],
    },
    risk: "auto",
    run: async (env, i) => {
      const label = String(i.name).trim().slice(0, 60);
      let address = String(i.address).trim().slice(0, 300);
      if (/^(here|current location|my location|where i am)$/i.test(address)) {
        const here = await liveLocation(env, 120);
        if (!here) throw new Error("His phone hasn't shared a recent location. Ask him to open Santino with location sharing on (Settings), or to say the address.");
        address = `@${here.lat.toFixed(6)},${here.lng.toFixed(6)}`;
      }
      await env.DB.prepare(
        "INSERT INTO places (name, label, address, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET label = excluded.label, address = excluded.address, updated_at = excluded.updated_at",
      )
        .bind(label.toLowerCase(), label, address, now())
        .run();
      return { saved: label };
    },
  },
  {
    name: "place_list",
    description: "His saved places.",
    input_schema: { type: "object", properties: {} },
    risk: "auto",
    run: async (env) => (await env.DB.prepare("SELECT label, address FROM places ORDER BY label").all()).results,
  },
];
