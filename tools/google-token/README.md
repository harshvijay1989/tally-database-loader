# Google refresh-token baker (zero-install)

Generates a Google **refresh token** for a chosen account and writes a ready
`connections.json` you can bake into a locked/pre-connected connector build.
Runs on a machine with **no Node.js installed** (a portable `node.exe` is bundled).

Use this when the delivery account lives on a **different laptop** — e.g. a
Google **Workspace** account like `xyz@morde.com`. Workspace (custom-domain)
accounts work exactly like `gmail.com` for Drive/OAuth.

## One-time Google Cloud setup

1. Go to **console.cloud.google.com** → create/select a project (ideally inside
   the `morde.com` organization so the consent screen can be **Internal**).
2. **APIs & Services → Library → Google Drive API → Enable**.
3. **APIs & Services → OAuth consent screen**:
   - **Internal** (recommended for a Workspace domain — any `@morde.com` user can
     consent, no verification, no test-user list), **or**
   - **External** + add the target account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: Desktop app**. Copy the **Client ID** and **Client secret**.

> Workspace caveat: a Workspace **admin** can restrict third-party app access
> (Admin console → Security → API controls). If sign-in is blocked, the admin
> must allow/trust this app.

## Build the tool (on a machine that has Node.js)

```powershell
powershell -ExecutionPolicy Bypass -File tools\google-token\build.ps1
```

This bundles `node.exe` and produces `google-token-tool.zip`. Send that zip to
the laptop that can sign into the target account.

## Run it (on the target-account laptop — no Node needed)

1. Unzip anywhere.
2. Copy `oauth-client.sample.json` → **`oauth-client.json`** and paste the
   **Client ID**, **Client secret**, and optionally a target **Drive folder**
   (URL or ID; blank = My Drive root).
3. Double-click **`run.bat`**.
4. The browser opens → **pick the account** the connector should deliver to →
   approve. (If you see "unverified app" on an External client: Advanced →
   Continue.)
5. It writes **`connections.json`** next to the tool and prints success.

## Bake it into a build

Send `connections.json` back and drop it into
`installer/client-secrets/connections.json`, then rebuild the installer
(`installer/build.ps1`). The resulting build is pre-connected to that account.

## Notes / files

- `oauth-client.json` and `connections.json` contain secrets — **never commit them**
  (both are git-ignored, along with the bundled `node.exe`).
- The tool listens on `http://localhost:3000/oauth/callback` during sign-in; a
  Desktop OAuth client allows this loopback redirect automatically.
