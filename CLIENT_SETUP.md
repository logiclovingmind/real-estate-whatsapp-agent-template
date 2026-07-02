# Client Onboarding Checklist

Repeatable steps to deploy this agent for a new real estate client.
**No source code changes are needed** — you only fill config and deploy.
Work top to bottom; later steps need values produced by earlier ones.

---

## 0. Collect business details from the client (5 min)

- [ ] Business name
- [ ] Projects / localities served + office address (for `BUSINESS_CONTEXT`)
- [ ] Business hours, working days, visit duration, timezone
- [ ] Owner's WhatsApp number (for human handoff)

## 1. Google: Sheet + Calendar

- [ ] Create (or get access to) the client's **Google Sheet** → copy its ID → `GOOGLE_SHEET_ID`
- [ ] Create (or pick) a **Calendar** for site visits → copy its ID → `GOOGLE_CALENDAR_ID`
      (Leads/Visits tabs are auto-created on first write — no manual setup.)

## 2. Apps Script web app (the only manual deploy)

> Memory of this repo: editing `apps-script/Code.gs` locally does NOT update the
> live `/exec`. The web editor is a separate copy — you must paste + redeploy.

- [ ] Open the client's Apps Script project (script.google.com, ideally owned by the client's Google account)
- [ ] Paste the full contents of `apps-script/Code.gs` into the editor, **Save**
- [ ] In `setup()` at the top, fill the 3 values:
      `SHARED_SECRET` (make a fresh random string), `SHEET_ID`, `CALENDAR_ID`
- [ ] **Run `setup` once** (authorize when prompted) to load Script Properties
- [ ] Blank the 3 values in `setup()` back to `""` and Save (don't leave secrets in source)
- [ ] **Deploy → Manage deployments → edit → New version → Deploy**
- [ ] Copy the `/exec` Web App URL → `APPS_SCRIPT_WEBAPP_URL`
- [ ] Verify: `curl <APPS_SCRIPT_WEBAPP_URL>` → must return `"version":"v10-budget"`
      (if not, the new code didn't go live — redeploy)
- [ ] First time on an existing sheet: run `appsscript.formatSheet()` once (or
      POST action `format_sheet`) to apply the layout + drop any legacy Visits tab.
- [ ] Put the same `SHARED_SECRET` into `.env` as `APPS_SCRIPT_SHARED_SECRET`

> Timezone: defaults to `Asia/Kolkata`. For a different-timezone client, add a
> `TIMEZONE` Script Property (e.g. `Asia/Dubai`) — no source edit needed. Keep it
> consistent with `TIMEZONE` in the Node `.env`.

## 3. WhatsApp Cloud API (client's Meta account)

- [ ] In Meta → get `WHATSAPP_TOKEN` (permanent), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`
- [ ] Choose any `WHATSAPP_VERIFY_TOKEN` string (used in the next step)
- [ ] Confirm `GRAPH_API_VERSION` is current per Meta docs

## 4. Fill `.env` and deploy the Node service

- [ ] `cp .env.example .env` and fill **all** values (business details + credentials)
- [ ] Set `DASHBOARD_USER` / `DASHBOARD_PASS` for the leads dashboard
- [ ] Pick AICredits key: usually the agency's shared `AICREDITS_API_KEY`
- [ ] Deploy to an always-on HTTPS host (Railway / Render) → note the public URL

## 5. Wire the webhook + smoke test

- [ ] In Meta, set the webhook to `https://<host>/webhook` using your `WHATSAPP_VERIFY_TOKEN`
- [ ] Send a test WhatsApp message → confirm a reply
- [ ] Check the row appears in the client's Sheet (`Leads` tab)
- [ ] Open `https://<host>/dashboard` → confirm it loads with the client's name
- [ ] Run one full flow: qualify → offer slots → book → confirm event on Calendar

---

## What's reusable vs. per-client

| Reused as-is (never edit per client) | Per client |
|---|---|
| All of `src/` and `apps-script/Code.gs` logic | `.env` values |
| System prompt (reads `BUSINESS_NAME`, `BUSINESS_CONTEXT`, hours) | Google Sheet + Calendar |
| Dashboard (pulls business name dynamically) | Apps Script deploy (paste + Script Properties) |
| | WhatsApp/Meta account setup |

**Local testing tip:** port 3000 may be busy on the dev machine — run on `PORT=3999`
and use `npm run simulate` to test agent behavior without WhatsApp/Meta.
