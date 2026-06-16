# Auto ALT Writer – Gemini API Proxy

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) that holds your
Gemini API key server-side so it is **never shipped inside the VS Code
extension**. The extension sends `{ model, contents }`; the Worker injects the
key, forwards the request to Gemini, and passes the response straight back.

## Why a proxy?

A VS Code extension is distributed as a `.vsix` (a zip of plain-text JS). Any key
embedded in it — encrypted, obfuscated, or split — can be extracted, because the
running code must reconstruct it to call Gemini. The only way to keep the key
secret is to never distribute it: keep it on a server you control. That is what
this proxy does.

The endpoint URL itself **does** ship in the extension, so the residual risk is
**abuse of your free-tier quota**, not key theft. This Worker mitigates abuse;
see "Security notes" below.

## Prerequisites

- A free Cloudflare account
- Node.js (for `npx wrangler`)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Deploy

```bash
cd proxy

# 1) Log in to Cloudflare
npx wrangler login

# 2) Set the secrets (you'll be prompted to paste each value)
npx wrangler secret put GEMINI_API_KEY     # your real Gemini key
npx wrangler secret put CLIENT_TOKEN       # any random string; see step 4

# 3) Deploy
npx wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://alt-gen-proxy.<your-subdomain>.workers.dev`.

## Point the extension at your proxy

Two values must match between the extension and the proxy:

1. **Endpoint** — set your Worker URL in `src/constants.ts` →
   `PROXY_CONFIG.DEFAULT_ENDPOINT` (baked into the build).
2. **Client token** — `PROXY_CONFIG.CLIENT_TOKEN` in `src/constants.ts` must
   equal the `CLIENT_TOKEN` secret you set on the Worker.

Then rebuild the extension (`npm run compile` / `vsce package`).

## Enable rate limiting (recommended)

Pick one:

- **Workers KV (in code):**
  ```bash
  npx wrangler kv namespace create RATE_LIMIT
  ```
  Paste the printed id into `wrangler.toml` (uncomment the `[[kv_namespaces]]`
  block), then `npx wrangler deploy`. Defaults to 30 requests / 60s per IP
  (tune `RATE_LIMIT` in `worker.js`).

- **Cloudflare dashboard rule (no code):** Security → WAF → Rate limiting rules.

## Cap the quota (recommended)

In Google AI Studio / Google Cloud, restrict the API key to the *Generative
Language API* only and set a low per-minute / per-day quota. With the free tier
this bounds the worst case to "quota temporarily exhausted", never a bill.

## Security notes

- ✅ The Gemini key never leaves the server.
- ⚠️ `CLIENT_TOKEN` ships inside the extension, so it is **not** a real secret —
  it only filters drive-by traffic. Real protection = rate limiting + request
  validation here + per-key quota on Google.
- The Worker only accepts `POST`, requires the client token, allows just
  `gemini-2.5-flash` / `gemini-2.5-pro`, requires an inline media part (so it
  can't be used as a generic text endpoint), and caps the body at ~30MB.
- Rotating the key = `npx wrangler secret put GEMINI_API_KEY` again; no
  extension update needed.

## Local test

```bash
npx wrangler dev
# then POST to the local URL with the x-client-token header and a small image payload
```
