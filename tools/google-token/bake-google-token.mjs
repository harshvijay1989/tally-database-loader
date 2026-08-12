// Standalone Google refresh-token generator (zero dependencies, Node built-ins only).
//
// Run this on the laptop that can sign into the target Google account (e.g. a
// Workspace account xyz@morde.com). It performs the OAuth browser sign-in and
// writes a ready-to-bake connections.json containing the refresh token + folder.
//
// Setup (once): create a Google Cloud OAuth client of type "Desktop app" with the
// Drive API enabled, then put its id/secret into oauth-client.json (see README.md).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import child_process from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/oauth/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

const clientFile = path.join(__dirname, 'oauth-client.json');
if (!fs.existsSync(clientFile)) {
    console.error('\n  Missing oauth-client.json in this folder.');
    console.error('  Copy oauth-client.sample.json to oauth-client.json and fill in your');
    console.error('  Desktop OAuth client id/secret (see README.md).\n');
    process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
const clientId = String(cfg.clientId || cfg.client_id || '').trim();
const clientSecret = String(cfg.clientSecret || cfg.client_secret || '').trim();
const folderId = String(cfg.folderId || '').trim();
if (!clientId || !clientSecret) {
    console.error('\n  oauth-client.json must contain clientId and clientSecret.\n');
    process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true'
}).toString();

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname !== '/oauth/callback') { res.writeHead(404); res.end('waiting for /oauth/callback'); return; }
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    if (err || !code) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h2>Sign-in cancelled. You can close this tab.</h2>'); return; }
    try {
        const tok = await (await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code' })
        })).json();
        if (!tok.refresh_token) throw new Error(tok.error_description || tok.error || 'no refresh_token returned — remove this app under your Google account permissions and retry');
        let email = '';
        try { const ui = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json(); email = ui.email || ''; } catch { }
        const connections = { salesforce: {}, google: { clientId, clientSecret, refreshToken: tok.refresh_token, folderId } };
        fs.writeFileSync(path.join(__dirname, 'connections.json'), JSON.stringify(connections, null, 2));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<body style="font:16px system-ui;text-align:center;padding-top:60px"><h2 style="color:#16a34a">&#10003; Connected as ${email || 'your account'}</h2><p>connections.json has been written next to this tool.<br>You can close this tab and return to the console.</p></body>`);
        console.log('\n==================================================');
        console.log('  SUCCESS - connected as', email || '(unknown)');
        console.log('  Wrote:', path.join(__dirname, 'connections.json'));
        console.log('  Send that connections.json back to bake into the build.');
        console.log('==================================================\n');
        setTimeout(() => process.exit(0), 900);
    } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="color:#b42318">Failed</h2><p>' + (e.message || e) + '</p>');
        console.error('\n  ERROR:', e.message || e, '\n');
        setTimeout(() => process.exit(1), 900);
    }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is in use. Close whatever is using it and rerun.\n`);
    else console.error(e);
    process.exit(1);
});

server.listen(PORT, () => {
    console.log('\n  Opening Google sign-in in your browser...');
    console.log('  If it does not open, paste this URL into your browser:\n');
    console.log('  ' + authUrl + '\n');
    const cmd = process.platform === 'win32' ? `start "" "${authUrl}"`
        : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
    child_process.exec(cmd);
});
