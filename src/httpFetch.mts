import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

// A tiny, dependency-free stand-in for the global `fetch`, covering only the subset
// this connector uses (JSON/form/multipart requests with headers, and .ok/.status/
// .json()/.text() on the response). Built on node:http(s) so it runs on OLD Node too
// (Node 14, the last runtime that supports Windows 7/8) — global fetch is Node 18+.
// Used everywhere instead of fetch so there is ONE code path across all Node versions.

export interface FetchLikeResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string | string[] | undefined>;
    text(): Promise<string>;
    json(): Promise<any>;
}

export interface FetchLikeInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | URLSearchParams;
    timeoutMs?: number;
    _redirects?: number;
}

export function httpFetch(url: string, init: FetchLikeInit = {}): Promise<FetchLikeResponse> {
    return new Promise((resolve, reject) => {
        let u: URL;
        try { u = new URL(url); } catch (e) { reject(e); return; }
        const lib = u.protocol === 'http:' ? http : https;

        let bodyBuf: Buffer | undefined;
        if (init.body != null) {
            if (init.body instanceof URLSearchParams) bodyBuf = Buffer.from(init.body.toString());
            else if (Buffer.isBuffer(init.body)) bodyBuf = init.body;
            else bodyBuf = Buffer.from(String(init.body));
        }
        const headers: Record<string, string> = { ...(init.headers || {}) };
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
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c as Buffer));
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
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}
