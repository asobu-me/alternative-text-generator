/**
 * ALTernative Text Generator – Gemini API proxy (Cloudflare Worker)
 *
 * Purpose: keep the Gemini API key OFF the distributed VS Code extension.
 * The extension POSTs { model, contents } here; this Worker injects the
 * server-side key and forwards the call to Gemini, passing the response
 * (status + body) straight back so the extension's existing parsing works.
 *
 * Security model (important):
 *   - The API key lives only in the GEMINI_API_KEY secret. It is never sent
 *     to clients, so it cannot be extracted from the extension.
 *   - The endpoint is public (its URL ships in the extension), so the real
 *     risk is ABUSE of your free-tier quota, not key theft. This Worker limits
 *     abuse with: a shared client token, a model allow-list, a required inline
 *     media part (so it can't be used as a generic text chatbot), a body-size
 *     cap, and optional per-IP rate limiting.
 *   - Also set a per-key quota in Google AI Studio / Cloud so the worst case
 *     is bounded.
 */

const ALLOWED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro']);
const MAX_BODY_BYTES = 30 * 1024 * 1024; // ~30MB (covers a 20MB media as base64)
const RATE_LIMIT = { windowMs: 60_000, max: 30 }; // per IP, only if RATE_LIMIT KV is bound

export default {
    async fetch(request, env) {
        if (request.method !== 'POST') {
            return json({ error: 'Method not allowed' }, 405);
        }

        // 1) Shared client token (defense-in-depth; not a real secret).
        const token = request.headers.get('x-client-token');
        if (!env.CLIENT_TOKEN || token !== env.CLIENT_TOKEN) {
            return json({ error: 'Forbidden' }, 403);
        }

        // 2) Reject oversized payloads early when Content-Length is present.
        const declaredLength = Number(request.headers.get('content-length') || '0');
        if (declaredLength && declaredLength > MAX_BODY_BYTES) {
            return json({ error: 'Payload too large' }, 413);
        }

        // 3) Read and parse the body (also guards size when Content-Length lies/absent).
        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
            return json({ error: 'Payload too large' }, 413);
        }
        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            return json({ error: 'Invalid JSON' }, 400);
        }

        // 4) Validate request shape.
        const model = body && body.model;
        const contents = body && body.contents;
        if (typeof model !== 'string' || !ALLOWED_MODELS.has(model)) {
            return json({ error: 'Unsupported model' }, 400);
        }
        if (!Array.isArray(contents) || contents.length === 0) {
            return json({ error: 'Missing contents' }, 400);
        }
        // Require an inline media part so this proxy can't be repurposed as a
        // free general-purpose Gemini text endpoint.
        const hasInlineMedia = contents.some(
            (c) =>
                c &&
                Array.isArray(c.parts) &&
                c.parts.some((p) => p && ((p.inline_data && p.inline_data.data) || (p.inlineData && p.inlineData.data)))
        );
        if (!hasInlineMedia) {
            return json({ error: 'Request must include inline media' }, 400);
        }

        // 5) Optional per-IP rate limiting (enabled only if a RATE_LIMIT KV is bound).
        if (env.RATE_LIMIT) {
            const ip = request.headers.get('cf-connecting-ip') || 'unknown';
            if (await isRateLimited(env.RATE_LIMIT, ip)) {
                return json({ error: 'Rate limit exceeded. Please slow down and try again shortly.' }, 429);
            }
        }

        // 6) Forward to Gemini with the server-side key.
        if (!env.GEMINI_API_KEY) {
            return json({ error: 'Server not configured (missing GEMINI_API_KEY)' }, 500);
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        let upstream;
        try {
            upstream = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': env.GEMINI_API_KEY
                },
                body: JSON.stringify({ contents })
            });
        } catch (err) {
            return json({ error: 'Upstream request failed', detail: String(err) }, 502);
        }

        // 7) Pass Gemini's status code and JSON body straight back to the extension.
        const text = await upstream.text();
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Approximate fixed-window per-IP rate limit backed by Workers KV.
 * Note: read-then-write is not atomic, so the limit is best-effort (good enough
 * to dampen abuse). For hard guarantees use Cloudflare's Rate Limiting rules.
 */
async function isRateLimited(kv, ip) {
    const windowId = Math.floor(Date.now() / RATE_LIMIT.windowMs);
    const key = `rl:${ip}:${windowId}`;
    const current = parseInt((await kv.get(key)) || '0', 10);
    if (current >= RATE_LIMIT.max) {
        return true;
    }
    await kv.put(key, String(current + 1), {
        expirationTtl: Math.ceil(RATE_LIMIT.windowMs / 1000) + 5
    });
    return false;
}
