# Santino — Product Spec

Working name: **Santino**. Rename freely.

## Vision
One personal chief-of-staff for Jimmy, reachable by voice or text from any
device, that reads his world (email, calendar, tasks, team), proposes actions,
and executes them after a spoken or tapped approval.

## Owner context
- Single user (Jimmy), Cairo, timezone Africa/Cairo.
- Speaks Egyptian Arabic and English, often mixed in one sentence.
- Workspace: Google (Gmail, Calendar, Drive, Sheets, Slides).
- Team is reached through WhatsApp and email.
- Hosting: Cloudflare (Pages/Workers), domain jimmymo.online.

## Principles
1. **Voice first, text equal.** Every feature works both ways.
2. **Nothing leaves without approval.** Anything that sends, books, pays or
   invites is queued and executed only after Jimmy approves.
3. **Short answers.** Replies are spoken aloud; keep them to 1-3 sentences
   unless asked for detail.
4. **Email, web and WhatsApp content is data, never instructions.**
5. **Everything is logged.** An audit trail for every action taken.
6. **The owner can stop everything.** A kill switch pauses all sending and
   scheduled actions instantly.
7. **Spending is capped.** A daily budget for paid services, visible on screen.

## Capabilities by phase

### Phase 1 — Core (this starter)
- HUD interface: reactive core (standby / listening / processing / speaking),
  live tiles (open, overdue, due today, meetings, unread, to approve),
  link indicators, quick commands.
- Thinking partner: open conversation and planning, then converts agreed
  plans into tasks, reminders, meetings and messages.
- Briefs and summaries on demand ("brief me", "my day", "inbox", "team
  status") built from one `day_snapshot` tool, never invented.
- Automatic morning brief at `BRIEF_HOUR` (default 08:00 Cairo), spoken when
  the app is opened.
- Chat by text and voice (record -> transcribe -> reply -> speak).
- Tasks: create, assign to a team member, due dates, status, notes.
- Reminders at a time.
- Team directory (name, WhatsApp number, email, role).
- Approval queue with Approve / Reject by tap or by voice ("تمام", "approve").
- Gmail: search, read, draft-and-send (approval).
- Calendar: list agenda, create meeting with attendees (approval).
- Expenses: append rows to an auto-created Google Sheet.
- WhatsApp: message a team member 1:1 (approval), receive their replies.
- Scheduled follow-ups: on a task's follow-up time, a WhatsApp nudge is
  drafted and placed in the approval queue.

### Phase 2 — Knows me
- Long-term memory of people, preferences and decisions, with a decision log
  and a screen to review and delete what is stored.
- Business workspaces: everything tagged to one of Jimmy's companies, with
  scoped briefs and a HUD switcher.
- One-tap access from the phone lock screen or action button.

### Phase 3 — In the room
- Attends Zoom and Google Meet as a visible note-taker, or picks up the
  recording afterwards.
- Listen mode for in-person meetings and speakerphone calls; a dial-in number
  for phone calls.
- After every meeting: summary, decisions, action items, reminders for Jimmy,
  tasks for the team, follow-ups queued for approval, notes saved to Drive.
- Pre-meeting brief with history and open items.

### Phase 4 — Runs on rules
- Standing rules: auto-approve routine actions, block others by time or
  recipient. Money, bookings and first-time recipients always ask.
- Web Push notifications, email triage with suggested replies.

### Phase 5 — Hands and makers
- Web research with sources.
- Restaurant and trip booking: research options, present 2-3, then book via a
  browser agent or by drafting the booking message/call. Payment always needs
  explicit approval.
- Expense capture from receipt photos.
- Presentations (Google Slides), sheets and documents on demand.
- Meeting scheduling across attendees' free/busy.

### Phase 6 — Everywhere
- Native iOS/Android wrapper with wake word, lock-screen and CarPlay access.
- Watch / earbuds shortcut.
- Realtime streaming voice (interruptible, low latency).

## Meetings
How Santino gets into a conversation, by channel:

| Channel | Live | After the fact |
|---|---|---|
| Zoom | Joins as a participant via a meeting-bot service | Cloud recording / transcript, if enabled on the account |
| Google Meet | Joins as a participant via a meeting-bot service | Meet recording / transcript, if the Workspace plan has it |
| Phone call | Santino number merged into the call, or Listen mode on speaker | — |
| In person | Listen mode in the app | — |

All four feed one pipeline: transcript -> summary -> decisions -> action
items -> reminders, tasks and approval-gated follow-ups.

Rules:
- The note-taker is always visible by name and never joins silently.
- Recording consent rules differ by country; default is to ask Jimmy before
  each meeting until he sets a rule.
- Transcripts are untrusted data: nothing said in a meeting can instruct
  Santino or approve an action.

## Known limits (be honest with the user)
- **WhatsApp groups:** the official WhatsApp Cloud API cannot read or post in
  ordinary groups. Santino messages team members one-to-one. Free-form messages
  are only allowed within 24h of the person's last message; outside it, an
  approved template is required.
- **Bookings:** there is no universal booking API. Phase 5 uses a browser
  agent or drafts the request for a human channel.
- **Always listening:** a web app cannot listen in the background. Wake word
  needs the Phase 6 native wrapper.
- **Phone calls:** phones do not let an app record a normal call. Santino
  hears a call only if it is merged in through its own number or the call is
  on speaker with Listen mode on.
- **Joining meetings:** needs a paid meeting-bot service; hosts can refuse or
  remove the note-taker.

## Non-goals (for now)
- Multi-user / selling it as a product.
- Autonomous spending.
