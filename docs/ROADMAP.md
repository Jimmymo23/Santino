# Roadmap

Each sprint ends with something Jimmy can use. Verify each step before moving on.

Operating habit: for the first two weeks of real use, approve everything by
hand and read every draft. Standing rules (Sprint 7) come only after that.

## Sprint 0 — Run it (half a day)
- [x] `npm install`, create D1 database, apply migration, set secrets.
- [x] Log in on the live app, chat by text, create a reminder.
- [x] Deploy: live at https://santino.mohamed-gsmart.workers.dev
- [ ] Optional: custom domain `santino.jimmymo.online`.

## Sprint 1 — Google + hardening
- [x] Create Google Cloud OAuth client (project `santino-2388`, Internal to
      the thegreenpenguin.net Workspace), connect account via GGL. Setup helper:
      `npm run google:setup`.
- [x] Test gmail_search / gmail_read / gmail_send (approval) end to end
      (owner confirmed: brief from live inbox and calendar, test email sent
      only after Authorize).
- [ ] Test calendar_agenda / calendar_create.
- [ ] Test expense_add creating the sheet on first use.
- [x] Encrypt the Google tokens and cached inbox snapshot at rest (AES-GCM,
      key derived from `SESSION_SECRET`; legacy plaintext upgrades on first read).
- [ ] Unit tests for the approval gate (vitest + miniflare).
- [x] Rate-limit logins: 5 failures per IP and 30 overall per 15 minutes.
- [x] Passkey login (Face ID / fingerprint via WebAuthn, ES256, single-use
      challenges); passcode stays as the recovery path. Auto-lock after 15
      minutes idle on devices with a passkey.
- [x] Kill switch: HUD bar + Security panel + the phrases "stand down" /
      "وقف كل حاجة" set `kv.paused`. While paused no approval executes, cron
      drafts and sends nothing, approval tools refuse to queue. Server code
      only; resume is a button.
- [ ] Owner to do on each device: open ⚙ → "Add this device".

## Sprint 2 — Voice quality
- [ ] Review the HUD on a real phone and desktop; tune sizes and motion.
- [x] Speech-to-text on by default: Whisper large v3 turbo on Workers AI
      (`[ai]` binding, no extra key). `STT_URL` still overrides it.
- [ ] Judge accuracy on real Egyptian Arabic + English use for a week; if it
      falls short, compare 2-3 other providers through `STT_URL`.
- [x] Natural voice for English replies: Deepgram Aura 2 on Workers AI
      (`/api/speak`, `TTS_MODEL`, optional `TTS_VOICE`); browser voice is the
      fallback.
- [x] Voice picker with preview in ⚙ (male voices, default `draco`), saved
      in `kv.tts_voice`. Personality: dry wit, "sir" now and then.
- [ ] Natural Arabic voice: needs a multilingual TTS provider.
- [x] Auto-stop on silence (1.6s after speech; 90s cap).
- [x] Hands-free mode with wake word and stop word (⚙ switch, per device):
      the mic stays open while the app is open, utterances are cut on the
      device, transcribed, and acted on only when they contain "Santino" (or
      follow it, or answer a question Santino just asked). "Santino, stop"
      cuts the voice and drops the pending reply. A tap also works.
- [x] Conversation mode: awake for 20s after the wake word, a tap or a
      reply; waits for the end of a thought (0.9s after a finished sentence,
      2s after an unfinished one) and joins the pieces; speaking over Santino
      pauses its voice and real words replace the reply; adding something
      while it thinks cancels the run (client and server, `/api/chat/cancel`)
      and resends both parts; its own echo is recognised and ignored.
      "Stop" cuts it off, "that's all" ends the conversation.
- [ ] Tool calls already made before a cancel still stand; make side effects
      of a cancelled run reversible or deferred.
- [ ] Tune wake-word accuracy on real use (accent, noise, false triggers).
- [x] Speed pass: `CLAUDE_EFFORT=low` with `thinking: between_tools`, cached
      stable system block + tools, tools and Gmail fetches run in parallel,
      voice starts on the first sentence, end-of-speech pause 650ms, chime on
      accepted command. Each turn logs `turn_timing` (ms, steps, tools) in
      `audit` for tuning.
- [x] Voice fix pass: natural voice plays through the mic's Web Audio
      context in hands-free mode (iPhone blocked the <audio> element without a
      tap, so it fell back to the robotic browser voice); "TAP TO LISTEN" on
      the core when the phone holds the mic; mic recovers after the app was in
      the background; asleep, utterances go to Nova-3 (fast, English, keyterm
      "Santino") one at a time with only the newest kept, so background talk
      cannot delay the wake word; tolerant wake matching (edit distance,
      split words, Arabic spellings); finished sentences sent 0.25s after the
      transcript; ⚙ → "What Santino heard" (on device only);
      `client:turn` / `client:tts_fail` timings in `audit`.
- [ ] Streaming replies (speak while the model is still writing) and an
      on-device wake word, if latency is still not good enough.
- [ ] Voice approval read-back ("Send this to Ahmed? ...").
- [x] Cost meter: `usage` table (per day and kind: claude, stt, tts) with
      estimated cost from list prices; `DAILY_BUDGET_USD` cap (default 2, editable in ⚙). At
      the cap Santino stops calling the model, transcription and the natural
      voice. Today's spend is in the header and in ⚙, with "Allow $1 more
      today".

## Sprint 3 — Team loop on WhatsApp
- [ ] Meta business app, phone number, webhook, app secret.
- [ ] Message templates for follow-ups outside the 24h window.
- [ ] Inbound replies attach to the related task and can update status
      (proposed as an approval, not automatic).
- [ ] Daily team digest for Jimmy.

## Sprint 4 — Memory
The step from "smart tool" to "knows me". Everything after builds on it.
- [x] `memories` table (migration 0003): fact, kind (person, preference,
      decision, business, other), subject, created/updated.
- [x] Tools: `memory_save`, `memory_update`, `memory_search`,
      `memory_forget`. Owner says "remember that..." / "forget that...".
- [x] Memories are added to the system prompt each turn (matches to the
      message first, then most recent, capped).
- [x] Decision log: decisions are a memory kind with their date.
- [x] ⚙ → "Review memory": see everything stored and delete entries.
- [x] Rule: saved only when the owner asks; nothing from email, WhatsApp,
      web or transcripts on the model's initiative; credentials and card/ID
      numbers are refused in code.
- [ ] Later: Santino suggests things worth remembering, owner approves.
- [ ] Later: semantic search (embeddings) once there are hundreds of entries.

## Sprint 5 — Business workspaces
- [ ] `businesses` table; `business_id` on tasks, people, expenses, memories,
      meetings (migration).
- [ ] Tools accept an optional business; Santino infers it from the person or
      context and asks only when unclear.
- [ ] Scoped commands: "brief me on <business> only", "what's open in Dubai".
- [ ] HUD: business switcher that filters tiles and briefs.
- [ ] Expenses sheet gets one tab per business.
- [ ] Multiple Google accounts (work + personal Gmail): `google_accounts`
      table with per-account tokens, tools take an optional account, briefs
      and tiles merge both and label each item. Personal Gmail needs a second
      OAuth client set to External + published, because the current one is
      Internal to the Workspace.

## Sprint 6 — Meetings: attend, take notes, follow up
See "Meetings" in `docs/SPEC.md` for the design and its limits.
- [ ] `meetings` table: source, title, start, attendees, transcript, summary,
      decisions, action items (migration).
- [ ] **Zoom and Google Meet, live:** Santino joins as a visible participant
      named "Santino (Jimmy's note-taker)" through a meeting-bot service.
      Evaluate providers on cost, Arabic + English accuracy, and data handling.
- [ ] Auto-join rules from the calendar: all meetings, only ones Jimmy marks,
      or ask each time (default: ask each time).
- [ ] **Fallback, after the meeting:** pull the cloud recording or transcript
      from Zoom / Google Meet when the bot was not in the call.
- [ ] **Listen mode:** a button in the app that records the room. Covers
      in-person meetings and phone calls on speaker.
- [ ] **Phone calls, direct:** a Santino phone number (telephony provider)
      that Jimmy merges into a call as a third participant.
- [ ] Pipeline after every meeting: transcript -> summary -> decisions ->
      action items with owner and due date.
- [ ] Jimmy's own action items become reminders; team items become tasks.
- [ ] Follow-up messages to attendees are drafted and queued for approval.
- [ ] Notes saved as a Google Doc and linked on the calendar event.
- [ ] "What did we agree with <person> last week?" answers from meeting notes.
- [ ] Pre-meeting brief 10 minutes before: who, last decisions, open items.
- [ ] Consent: the note-taker is always visible and announces itself; a
      setting to disable per meeting. Transcripts are untrusted data.

## Sprint 7 — Standing rules and proactive
- [ ] `rules` table: owner-written rules in plain language with a structured
      match (tool, recipient group, time window) (migration).
- [ ] Auto-approve rules ("always approve follow-ups to my team") executed by
      server code, never by the model deciding on its own.
- [ ] Block rules ("never email clients after 9pm") checked before queuing.
- [ ] Money, bookings and first-time recipients always need manual approval;
      no rule can override this.
- [ ] Rules screen: list, pause, delete; every auto-approval is in the audit log.
- [x] Web Push notifications (`src/push.ts`, `public/sw.js`): VAPID keys
      generated on first use, RFC 8291 payload encryption, per-device switch
      in ⚙ with a test button. Reminders, briefs, follow-ups and WhatsApp
      replies are pushed. Cron runs every minute so reminders are on time.
- [ ] Notification actions (Authorize / Deny from the notification itself).
- [x] Morning brief at a configurable time (`BRIEF_HOUR`, in-app; push comes with Web Push).
- [ ] Email triage digest with suggested replies.

## Sprint 8 — Research and hands
- [ ] Web research tool with sources (supplier, competitor, flights, venues).
      Web content is untrusted data.
- [ ] Restaurant / trip research -> 2-3 options -> approval -> booking path.
- [ ] Receipt photo -> expense row in the right business tab.

## Sprint 9 — Makers
- [ ] Google Slides generation from an outline.
- [ ] Sheets on demand (beyond expenses).
- [ ] Free/busy scheduling across attendees.

## Later
- Native wrapper, wake word, CarPlay, watch.
- Realtime streaming voice.
