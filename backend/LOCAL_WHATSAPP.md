# Local WhatsApp link (when QR fails on Baileys / Render)

Official web.whatsapp.com works, but Baileys multi-device often shows "Couldn't link device".

## On your PC (Windows / Mac / Linux)

```bash
cd backend
rm -rf auth_info_baileys auth_info_wwebjs .wwebjs_auth .wwebjs_cache
set WA_ENGINE=wwebjs
npm install
npm start
```

Windows PowerShell:
```powershell
$env:WA_ENGINE="wwebjs"
npm start
```

Open: http://localhost:5000/qr

1. On phone: WhatsApp → Linked devices → Log out any old "Lead Pulse" / unknown devices if needed
2. Link a device → scan the QR from localhost (within 60 seconds)
3. Wait until status is CONNECTED: http://localhost:5000/api/whatsapp/status

Requires Google Chrome installed.
