# Real Estate WhatsApp Lead Agent — Client Template

WhatsApp AI SDR for a real estate business: qualifies leads in their own
language (English / Hinglish / Gujarati), logs every lead to a Google Sheet,
books site visits on Google Calendar, and gives the owner a simple leads
dashboard at `/dashboard`.

**This is a template repo. No source code changes are needed per client —
only credentials and config.**

## New client in 5 steps

1. **Use this template** → create a new private repo named for the client.
2. Follow **[CLIENT_SETUP.md](CLIENT_SETUP.md)** top to bottom — it collects
   the business details, sets up the client's Sheet + Calendar + Apps Script,
   and the Meta/WhatsApp credentials.
3. In `render.yaml`, rename the service for the client, then on Render →
   **New → Blueprint** → pick the client repo. Render prompts for all secrets
   (nothing secret is committed).
4. Point the Meta webhook at `https://<render-url>/webhook`.
5. Smoke test: send a WhatsApp message → reply arrives, row appears in the
   Sheet, and run one full flow through booking.

## Local dev

```bash
npm install
cp .env.example .env   # fill it in
npm run simulate       # chat with the agent in the terminal, no WhatsApp needed
npm test
npm run dev
```

## What's per-client vs shared

| Never edit per client | Per client |
|---|---|
| Everything in `src/`, `apps-script/Code.gs`, tests | `.env` / Render env values |
| System prompt (reads `BUSINESS_NAME`, `BUSINESS_CONTEXT`, hours) | Google Sheet + Calendar + Apps Script deploy |
| Dashboard (business name is pulled from config) | WhatsApp/Meta account + webhook |
| | `render.yaml` service name |
