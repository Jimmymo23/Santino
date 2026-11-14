# Roadmap

Each sprint ends with something Jimmy can use. Verify each step before moving on.

Operating habit: for the first two weeks of real use, approve everything by
hand and read every draft. Standing rules (Sprint 7) come only after that.

## Sprint 0 — Run it (half a day)
- [ ] `npm install`, create D1 database, apply migration, set secrets.
- [ ] `npm run dev`, log in, chat by text, create a task and a reminder.
- [ ] Deploy to `santino.jimmymo.online` (or chosen subdomain).

## Sprint 1 — Google + hardening
- [ ] Create Google Cloud OAuth client, connect account via Settings.
- [ ] Test gmail_search / gmail_read / gmail_send (approval) end to end.
- [ ] Test calendar_agenda / calendar_create.
- [ ] Test expense_add creating the sheet on first use.
- [ ] Encrypt the refresh token at rest (AES-GCM with a Worker secret).
- [ ] Unit tests for the approval gate (vitest + miniflare).
- [ ] Rate-limit /api/login.
- [ ] Passkey login (Face ID / fingerprint via WebAuthn); passcode stays as
      the recovery path. Auto-lock after 15 minutes idle.
- [ ] Kill switch: a HUD button and the phrases "stand down" / "وقف كل حاجة"
      set `kv.paused`. While paused, no approval executes, cron sends nothing,
      and approval tools refuse to queue. Handled in server code outside the
      model; only the owner can resume. Shown clearly on the HUD.

## Sprint 2 — Voice quality
- [ ] Review the HUD on a real phone and desktop; tune sizes and motion.
- [ ] Compare 2-3 STT providers on real Egyptian Arabic + English recordings.
- [ ] Neural TTS with a consistent voice, Arabic and English.
- [ ] Hands-free mode: auto-stop on silence, auto-listen after reply.
- [ ] Voice approval read-back ("Send this to Ahmed? ...").
- [ ] Cost meter: `usage` table (migration) logging tokens, STT seconds and
      later meeting minutes per day; `DAILY_BUDGET_USD` cap. At the cap,
      Santino stops calling paid services and says so. Today's spend on the HUD.
- [ ] One-tap access: phone shortcut (lock screen / action button / home
      screen) that opens Santino already listening (`/?listen=1`).

## Sprint 3 — Team loop on WhatsApp
- [ ] Meta business app, phone number, webhook, app secret.
- [ ] Message templates for follow-ups outside the 24h window.
- [ ] Inbound replies attach to the related task and can update status
      (proposed as an approval, not automatic).
- [ ] Daily team digest for Jimmy.

## Sprint 4 — Memory
The step from "smart tool" to "knows me". Everything after builds on it.
- [ ] `memories` table (migration): fact, kind (person, preference, decision,
      business, other), source, created/updated.
- [ ] Tools: `memory_save`, `memory_search`, `memory_forget`. Owner can say
      "remember that..." and "forget that...".
- [ ] Relevant memories are retrieved and added to the system prompt each turn.
- [ ] Decision log: "what did we decide about X?" answers with date and context.
- [ ] A "What you know about me" screen to review and delete entries.
- [ ] Rule: nothing from email, WhatsApp, web or transcripts is saved to
      memory without the owner saying so.

## Sprint 5 — Business workspaces
- [ ] `businesses` table; `business_id` on tasks, people, expenses, memories,
      meetings (migration).
- [ ] Tools accept an optional business; Santino infers it from the person or
      context and asks only when unclear.
- [ ] Scoped commands: "brief me on <business> only", "what's open in Dubai".
- [ ] HUD: business switcher that filters tiles and briefs.
- [ ] Expenses sheet gets one tab per business.

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
- [ ] Web Push notifications.
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
