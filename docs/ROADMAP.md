# Roadmap

Each sprint ends with something Jimmy can use. Verify each step before moving on.

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

## Sprint 2 — Voice quality
- [ ] Review the HUD on a real phone and desktop; tune sizes and motion.
- [ ] Compare 2-3 STT providers on real Egyptian Arabic + English recordings.
- [ ] Neural TTS with a consistent voice, Arabic and English.
- [ ] Hands-free mode: auto-stop on silence, auto-listen after reply.
- [ ] Voice approval read-back ("Send this to Ahmed? ...").

## Sprint 3 — Team loop on WhatsApp
- [ ] Meta business app, phone number, webhook, app secret.
- [ ] Message templates for follow-ups outside the 24h window.
- [ ] Inbound replies attach to the related task and can update status
      (proposed as an approval, not automatic).
- [ ] Daily team digest for Jimmy.

## Sprint 4 — Proactive
- [ ] Web Push notifications.
- [x] Morning brief at a configurable time (`BRIEF_HOUR`, in-app; push comes with Web Push).
- [ ] Email triage digest with suggested replies.
- [ ] Long-term memory table + retrieval.

## Sprint 5 — Makers
- [ ] Google Slides generation from an outline.
- [ ] Sheets on demand (beyond expenses).
- [ ] Free/busy scheduling across attendees.

## Sprint 6 — Hands
- [ ] Web search tool with sources.
- [ ] Restaurant / trip research -> options -> approval -> booking path.
- [ ] Receipt photo -> expense row.

## Later
- Native wrapper, wake word, CarPlay, watch.
- Realtime streaming voice.
