# Santino

Personal voice + text assistant. See `docs/SPEC.md`.

## Setup

```bash
npm install
npx wrangler login
npx wrangler d1 create santino          # paste database_id into wrangler.toml
npm run db:local
cp .dev.vars.example .dev.vars        # fill in values
npm run dev                           # http://localhost:8787
```

## Deploy

```bash
npm run db:remote
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OWNER_PASSCODE
npx wrangler secret put SESSION_SECRET
# optional: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, WHATSAPP_TOKEN,
#           WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET,
#           STT_URL, STT_KEY, STT_MODEL
npm run deploy
```

Set `APP_URL` in `wrangler.toml` to the deployed origin.

## Google
Create an OAuth client (Web application) in Google Cloud Console, enable the
Gmail, Calendar, Sheets and Drive APIs, and add
`<APP_URL>/auth/google/callback` as a redirect URI. Then open the app and tap
"Connect Google".

## WhatsApp
Meta for Developers -> WhatsApp -> Cloud API. Webhook URL:
`<APP_URL>/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`,
subscribe to `messages`.

## Voice
Speech-to-text works out of the box through Workers AI (Whisper large v3
turbo, the `[ai]` binding in `wrangler.toml`). To use another provider, set
`STT_URL` to any OpenAI-compatible transcription endpoint
(`POST multipart: file, model`) plus `STT_KEY` / `STT_MODEL`.

Local `wrangler dev` needs `wrangler login`, because the AI binding always
runs remotely and counts against the account's Workers AI usage.

Open `/?listen=1` to start listening immediately (use it for a phone shortcut).
