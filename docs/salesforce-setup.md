# Salesforce setup — what to do before building `SalesforceSink`

Auth model (locked): **Connected App + OAuth 2.0 Client Credentials flow** — server-to-
server, no browser prompt, perfect for a headless connector. (When the UI arrives we can
add the browser-based Web-Server flow; the sink's auth is swappable.)

Do these once in your Salesforce org, then send me the four values in the last section.

## 1. Get a free Developer org (if you don't have one)

Sign up at **developer.salesforce.com/signup**. Developer Edition is free, permanent, and
has API access + My Domain enabled by default. Note the login email/password (you only
need them to click around in Setup — the connector won't use them).

## 2. Note your My Domain URL (the instance URL)

Setup → **My Domain**. Your URL looks like `https://<something>.my.salesforce.com`.
That's the **instance URL** the connector calls. (Developer orgs already have My Domain.)

## 3. Create a Connected App

Setup → **App Manager** → **New Connected App** → *Create a Connected App* → Continue.

- **Connected App Name**: `Tally Connector`
- **Contact Email**: your email
- Check **Enable OAuth Settings**
- **Callback URL**: `https://login.salesforce.com/services/oauth2/callback`
  (required field; unused by client-credentials — any valid https URL is fine)
- **Selected OAuth Scopes**: add
  - `Manage user data via APIs (api)`
  - `Perform requests at any time (refresh_token, offline_access)`
- Check **Enable Client Credentials Flow** (near the bottom of OAuth settings)
- **Save**. Salesforce warns it can take ~2–10 minutes to take effect. Wait it out.

## 4. Set the "Run As" user for Client Credentials

Setup → App Manager → find `Tally Connector` → dropdown → **Manage** → **Edit Policies**.
Under **Client Credentials Flow**, set **Run As** to a user (yourself/admin is fine for
testing — the integration acts with that user's permissions). **Save**.

## 5. Get the Consumer Key & Secret

App Manager → `Tally Connector` → **View** → **Manage Consumer Details** (may re-prompt
for a verification code emailed to you). Copy:
- **Consumer Key**  → this is the `clientId`
- **Consumer Secret** → this is the `clientSecret`

## 6. Add an External ID field on Account (for idempotent upsert)

This is what makes re-runs update instead of duplicate, and lets child records point at
parents by the Tally key later.

Setup → **Object Manager** → **Account** → **Fields & Relationships** → **New**:
- Type: **Text**
- Field Label: `Tally Guid`  → API name becomes `Tally_Guid__c`
- Length: `80`
- Check **Unique** and **External ID**
- Save (add to page layouts if prompted)

(We'll repeat this for Opportunity and the line-item object when we get there. First proof
is **Tally Ledger → Account**, the simplest slice.)

## What to send me back

Put these into a **`salesforce-credentials.json`** in the project root (it's git-ignored,
so it never gets committed). Template:

```json
{
    "instanceUrl": "https://YOUR-DOMAIN.my.salesforce.com",
    "clientId": "YOUR_CONSUMER_KEY",
    "clientSecret": "YOUR_CONSUMER_SECRET",
    "apiVersion": "v62.0"
}
```

Then just tell me it's in place. I'll build `SalesforceSink` (auth + Bulk API 2.0 upsert)
and run the first real Tally-Ledger → Account push against your org — no blind coding, we
test it live the same way we verified pillar 1.

## Sanity check (optional, proves the org half works before I build)

Once the Connected App has propagated, this returns an access token if everything's right:

```powershell
$body = @{ grant_type = 'client_credentials'; client_id = 'YOUR_CONSUMER_KEY'; client_secret = 'YOUR_CONSUMER_SECRET' }
Invoke-RestMethod -Method Post -Uri 'https://YOUR-DOMAIN.my.salesforce.com/services/oauth2/token' -Body $body
```

A JSON response with `access_token` = success. An error like `invalid_client` usually just
means it hasn't propagated yet — wait a few minutes and retry.
