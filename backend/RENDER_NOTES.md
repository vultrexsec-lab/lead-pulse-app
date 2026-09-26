# Deploy on Render

WhatsApp QR needs a browser. On Render use `@sparticuz/chromium` (already in package.json).

## Settings
- **Instance type:** at least **Standard** (512MB often too small; prefer 1GB+)
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Env (optional):**
  - `USE_SPARTICUZ_CHROMIUM=1`
  - `NODE_VERSION=20`

## After deploy
1. Open `https://YOUR.onrender.com/qr` — wait 30–60s, refresh
2. If JSON says generating, open Render **Logs** and look for `[wa]`
3. Scan QR from phone (Linked devices)

## Persist session
Render free disk is ephemeral — on restart you may need to scan QR again.
For persistent auth use a paid disk or external volume.
