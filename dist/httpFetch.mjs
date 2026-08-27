import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
export function httpFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(url);
        }
        catch (e) {
            reject(e);
            return;
        }
        const lib = u.protocol === 'http:' ? http : https;
        let bodyBuf;
        if (init.body != null) {
            if (init.body instanceof URLSearchParams)
                bodyBuf = Buffer.from(init.body.toString());
            else if (Buffer.isBuffer(init.body))
                bodyBuf = init.body;
            else
                bodyBuf = Buffer.from(String(init.body));
        }
        const headers = { ...(init.headers || {}) };
        if (bodyBuf && headers['Content-Length'] == null && headers['content-length'] == null)
            headers['Content-Length'] = String(bodyBuf.length);
        const req = lib.request({
            protocol: u.protocol, hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search, method: init.method || 'GET', headers,
        }, (res) => {
            const status = res.statusCode || 0;
            // follow redirects the way fetch does (default), capped to avoid loops
            if (status >= 300 && status < 400 && res.headers.location && (init._redirects || 0) < 5) {
                res.resume();
                const next = new URL(res.headers.location, u).toString();
                httpFetch(next, {
                    ...init, _redirects: (init._redirects || 0) + 1,
                    method: status === 303 ? 'GET' : init.method,
                    body: status === 303 ? undefined : init.body,
                }).then(resolve, reject);
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: status >= 200 && status < 300,
                    status, statusText: res.statusMessage || '',
                    headers: res.headers,
                    text: async () => text,
                    json: async () => JSON.parse(text || 'null'),
                });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(init.timeoutMs || 60000, () => req.destroy(new Error('request timed out')));
        if (bodyBuf)
            req.write(bodyBuf);
        req.end();
    });
}
//# sourceMappingURL=httpFetch.mjs.map