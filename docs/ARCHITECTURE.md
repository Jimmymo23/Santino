# Architecture

```
 Phone / laptop / tablet (PWA: public/)
        |  HTTPS, bearer session token
        v
 Cloudflare Worker (src/index.ts, Hono)
   |- /api/chat ---------> agent loop (src/agent.ts) --> Claude Messages API
   |                         |  tool calls
   |                         v
   |                     tool registry (src/tools.ts)
   |                       |- auto tools: run immediately
   |                       '- approval tools: stored in `approvals`, not run
   |- /api/approvals/:id/approve --> executes stored tool input
   |- /api/transcribe ---> STT provider (OpenAI-compatible endpoint)
   |- /api/inbox --------> pending approvals + notifications (UI polls)
   |- /auth/google/* ----> OAuth, refresh token kept in D1 `kv`
   |- /webhooks/whatsapp -> inbound replies -> notifications
   '- cron (*/5 min) ----> reminders due, task follow-ups (src/cron.ts)

 D1 (SQLite): messages, tasks, people, reminders, approvals,
              notifications, kv, audit
```

## The approval gate
Each tool declares `risk: "auto" | "approval"`.
- `auto`: reads, and writes that stay inside Jimmy's own data.
- `approval`: anything visible to other people or costing money.

When the model calls an approval tool, `executeTool` inserts a row into
`approvals` and tells the model it is pending. The tool's `run` is invoked
only from the approve endpoint, or from the deterministic voice shortcut in
`src/index.ts` (the user's own message matches an approve phrase and exactly
one approval is pending). **The model has no tool that can approve.** This is
the main defence against prompt injection from email or WhatsApp content.

## Voice
- Input: browser records audio (MediaRecorder) -> `/api/transcribe` -> text.
  The STT provider is configurable; it must handle Egyptian Arabic with
  English code-switching. Evaluate providers in Sprint 2.
- Output: browser `speechSynthesis` for now; swap for a neural TTS later.
- Phase 6: streaming realtime voice over WebSocket (Durable Object).

## Conversation memory
Only final user/assistant text is stored (`messages`), last 20 turns are sent.
Tool traffic is not persisted, which keeps history valid and cheap.
Long-term memory is Phase 2.

## Security notes
- Single owner. Login is a passkey (WebAuthn, ES256, user verification
  required, single-use challenges) or `OWNER_PASSCODE` as recovery. Both
  return an HMAC-signed session token valid 7 days. Logins are rate limited
  per IP and overall (`src/security.ts`).
- Passkey registration needs an authenticated session, so the browser-supplied
  public key is stored without attestation (`src/passkeys.ts`). Passkeys are
  bound to the host name; moving to a custom domain means adding them again.
- Auto-lock: the client drops its session after 15 minutes idle on devices
  that have a passkey.
- Kill switch: `kv.paused`. Checked in `executeTool`, `resolveApproval` and
  cron. The model cannot set or clear it.
- Google tokens and the cached inbox/calendar snapshot are AES-GCM encrypted
  in D1 with a key derived from `SESSION_SECRET` (`src/crypto.ts`). Rotating
  that secret means reconnecting Google.
- WhatsApp webhook verifies `X-Hub-Signature-256` when `WHATSAPP_APP_SECRET`
  is set. Set it.
- Tool results from email/web/WhatsApp are wrapped as untrusted data in the
  system prompt rules.
