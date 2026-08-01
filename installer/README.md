# Tally Connector — Windows Installer

This folder builds a **self-contained Windows installer** (`setup.exe`) for the
connector. The **target (business) machine needs nothing pre-installed** — no
Node.js, no Java, no Salesforce CLI, no manual steps.

## What the installer bundles

| Component | Why |
|-----------|-----|
| Compiled connector (`dist\`) + production `node_modules` | the app itself |
| Portable **Node.js runtime** (`node\node.exe`) | so the PC needs no Node install |
| Web UI (`webui\`) + Tally/config files | the mapping designer + extract config |

The app installs **per-user** to `%LOCALAPPDATA%\Programs\Tally Salesforce Connector`,
so setup needs **no administrator rights**, and that folder is writable at runtime
(mappings, extracted data and logs are stored there).

There is **no Salesforce CLI** and **nothing is downloaded** during setup — all
connections are configured from the UI (see below).

## Connections (configured in the UI, stored in `connections.json`)

- **Salesforce** — OAuth 2.0 *Client Credentials* flow. The customer creates a
  Connected App once (enabling the Client Credentials Flow) and pastes **Instance
  URL + Consumer Key + Consumer Secret** into the connector's **⚙ Connections**
  screen. Used for object/field discovery and upserts.
- **Google Drive** — OAuth 2.0 browser sign-in. Paste a Google **Desktop-app**
  OAuth Client ID + Secret, click **Connect Google**, and approve access. Mapped
  data is written to CSV and uploaded to the chosen Drive folder.

`connections.json` is created on this machine only and is git-ignored.

## Using it (on the business PC)

1. Double-click `TallySalesforceConnector-Setup.exe`.
2. Click through the wizard (optionally tick *Create a desktop shortcut*).
3. Launch **Tally to Salesforce Connector** from the Desktop / Start Menu.
   A console window opens and the browser goes to `http://localhost:3000`.
4. Open **⚙ Connections**, enter Salesforce and/or Google credentials, and connect.
5. Build a mapping, choose the **Destination** (Salesforce or Google Drive), and Sync.

Keep the console window open while using the connector; close it to stop.

## Building the installer (on a DEV machine)

Prerequisites on the **build** machine only:

- **Node.js + npm** — to compile TypeScript and install production dependencies
- **Inno Setup 6** — the installer compiler
  `winget install JRSoftware.InnoSetup`

Then:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

Output: `installer\build\TallySalesforceConnector-Setup.exe`

Options: `-Version 1.2.3` — stamp a product version.

## Files

| File | Purpose |
|------|---------|
| `build.ps1` | stages the payload and compiles the `.exe` |
| `connector.iss` | Inno Setup script (layout, shortcuts, per-user install) |
| `launcher.bat` | installed as `start-connector.bat`; runs the bundled Node against `dist\uiServer.mjs` |
| `build\` | generated payload + final `setup.exe` (git-ignored) |
