# Client secrets (NOT committed)

This folder holds the **baked connection** for a locked client build — a
`connections.json` that already contains the fixed Google account's refresh token
and target folder. `build.ps1` copies it into the installer payload so the client
machine is **pre-connected** (no sign-in on the client side).

`connections.json` here is git-ignored on purpose — it contains secrets.

## How to produce the baked `connections.json` (one-time, per client)

1. On a build/staging machine, run the connector against **the designated
   Gmail account's** Google Cloud OAuth client:
   - `⚙ Connections → Google Drive`: paste the OAuth **Client ID + Secret**, set the
     **target Drive folder**, click **Save**, then **Connect Google** and sign in
     with the account files should be delivered to.
2. That writes a `connections.json` at the repo root with `google.clientId`,
   `google.clientSecret`, `google.refreshToken` and `google.folderId`.
3. Copy that file to `installer/client-secrets/connections.json`.
4. Run `installer\build.ps1` — the resulting installer ships pre-connected and,
   because `client.json` sets `"locked": true`, the account/folder are read-only
   in the UI.

> If the refresh token is ever revoked (e.g. password change, or 6 months idle in
> a "testing" OAuth app), repeat these steps and rebuild.
