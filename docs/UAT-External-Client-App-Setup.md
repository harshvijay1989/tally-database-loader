# UAT Setup — External Client App for Client-Credentials (connector auth)

How to create the OAuth app the connector uses to authenticate to a Salesforce org
(UAT here, but identical for any org). The connector uses the **OAuth 2.0 Client-Credentials
flow**: it sends only a **Consumer Key** + **Consumer Secret** to `/services/oauth2/token` and
acts as a fixed **Run-As user** — no interactive login, no refresh token. Those three things
(key, secret, run-as user) are what this sets up.

What the connector needs in `connections.json` at the end:
```
"salesforce": {
  "instanceUrl": "https://<yourdomain>--<sandbox>.sandbox.my.salesforce.com",
  "loginUrl":    "https://<yourdomain>--<sandbox>.sandbox.my.salesforce.com",
  "clientId":    "<Consumer Key>",
  "clientSecret":"<Consumer Secret>",
  "apiVersion":  "62.0"
}
```

---

## Option A — External Client App (the current Salesforce model)

### 0. One-time org enablement (if not already on)
Setup → search **External Client Apps** → **External Client App Settings** → enable
**Allow creation of External Client Apps** (and **Allow OAuth settings**).

### 1. Create the app
Setup → **External Client App Manager** → **New External Client App**
- **External Client App Name**: `Tally Connector`
- **API Name**: `Tally_Connector`
- **Contact Email**: your email
- **Distribution State**: **Local** (used only inside this org)

### 2. OAuth settings (on the app)
Enable **OAuth** and set:
- **Callback URL**: not used by client-credentials, but one is required —
  `https://login.salesforce.com/services/oauth2/callback` (any valid URL is fine).
- **OAuth Scopes** (add these):
  - **Manage user data via APIs (api)**  ← the essential one
  - **Perform requests at any time (refresh_token, offline_access)**
  - *(optional)* **Full access (full)**
- Leave **Require PKCE** off (client-credentials doesn't use it).
- **Save**.

### 3. Enable the Client-Credentials flow + Run-As user  ← the key step
Open the app → **Policies** → **OAuth Policies** → **Edit**:
- **Enable Client Credentials Flow** = ON.
- **Run As** = the **integration user** (a System Administrator, or a dedicated API/integration
  user). **This is the identity every connector operation runs as** — it must have access to the
  Tally objects (assign the `Tally_Sync_Integration` permission set to this user, step 5).
- **IP Relaxation** = **Relax IP restrictions** (server-to-server, no browser).
- **Refresh Token Policy**: leave default.
- **Save**.

### 4. Get the Consumer Key + Secret
App → **Settings** → **OAuth Settings** → **Consumer Key and Secret** → **Reveal/Copy**.
- `clientId`  = Consumer Key
- `clientSecret` = Consumer Secret
Put both into the distributor's `connections.json` (shown above), along with the UAT My-Domain
URL as `instanceUrl`/`loginUrl`.

### 5. Give the Run-As user access
Assign the **`Tally_Sync_Integration`** permission set (deployed via `package.xml`) to the Run-As
user — this grants CRUD + FLS on the staging/bridge objects and the native fields the automation
needs. (A System Administrator Run-As user already has broad access, but assign it anyway so the
app works with a least-privilege integration user too.)

---

## Option B — Classic Connected App (equivalent, if your org still uses these)
Setup → **App Manager** → **New Connected App** → Enable OAuth → same Callback URL + scopes as
above → **Save**. Then **Manage** → **Edit Policies** → **Enable Client Credentials Flow** → set
**Run As** user → Save. Consumer Key/Secret under the app's **API (Enable OAuth Settings)**.
(Note: after saving a client-credentials Connected App, Salesforce can take ~10 min to activate.)

---

## Verify it works (before wiring the connector)
From any shell, swap in the UAT domain + key/secret:
```
curl -s -X POST "https://<yourdomain>--<sandbox>.sandbox.my.salesforce.com/services/oauth2/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=<Consumer Key>" \
  -d "client_secret=<Consumer Secret>"
```
A JSON response with an `access_token` = success. Then confirm the run-as identity:
```
curl -s "https://<instance>/services/oauth2/userinfo" -H "Authorization: Bearer <access_token>"
```
The `preferred_username` must be your intended **Run-As / integration user**.

## Common gotchas
- **`invalid_client_id` / `invalid_grant`** right after creating: wait a few minutes (activation), and
  make sure **Client Credentials Flow is enabled with a Run-As user** — without a run-as user the
  flow returns `invalid_grant: no client credentials user enabled`.
- **Token works but queries see no data / "No such column"**: the Run-As user is missing FLS —
  assign `Tally_Sync_Integration` (step 5).
- Use the **My Domain** URL (`...my.salesforce.com`), not `login/test.salesforce.com`, as
  `instanceUrl` so the token is minted on the right host.
- The **secret is shown once / must be revealed** — it is NOT retrievable via Metadata API, which is
  why this app is set up per-org by hand and not shipped in `package.xml`.
