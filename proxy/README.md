# Auto ALT Text Writer – Gemini API Proxy

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

`wrangler.toml` binds the Worker to a route on your own zone:

```toml
routes = [
  { pattern = "api.asobu.me/auto-alt-writer/*", zone_name = "asobu.me" }
]
```

So the public endpoint is `https://api.asobu.me/auto-alt-writer/`. The
`/auto-alt-writer/` prefix namespaces this app, leaving `api.asobu.me` free to
route other apps later. The Worker ignores the path, so nothing in the code
depends on it.

Using a route on your own zone — rather than the `*.workers.dev` URL — is what
lets the zone's atomic Rate limiting rules apply (see below).

### DNS record (dashboard, one time)

The hostname must resolve before the route works. On the `asobu.me` zone → DNS,
add a **proxied** record for `api` (the address is a placeholder — traffic is
served by the Worker route, not by this address):

| Type | Name | Value | Proxy |
|------|------|-------|-------|
| AAAA | `api` | `100::` | Proxied (orange cloud) |

The orange cloud is what routes the request through Cloudflare to the Worker; a
grey-cloud (DNS-only) record would bypass it and the route would never fire.

## Point the extension at your proxy

Two values must match between the extension and the proxy:

1. **Endpoint** — `PROXY_CONFIG.DEFAULT_ENDPOINT` in `src/constants.ts` must equal
   the route URL above (baked into the build).
2. **Client token** — `PROXY_CONFIG.CLIENT_TOKEN` in `src/constants.ts` must
   equal the `CLIENT_TOKEN` secret you set on the Worker.

Then rebuild the extension (`npm run compile` / `vsce package`).

## Enable rate limiting (recommended)

The threat here is not cost — with a Free-tier key and no billing account, abuse
can only ever return 429, never a bill. The threat is **availability**: the
free-tier's ~15 RPM is shared across all users, so one abuser hitting the proxy
starves everyone else. Rate limiting protects the shared quota. Pick one:

- **Cloudflare dashboard rule (recommended):** on the `asobu.me` zone →
  Security → Security rules → Create rule → Rate limiting rules. Runs at the edge
  before the Worker, counts atomically, and works on the free plan — this is why
  the Worker sits on a zone route rather than `*.workers.dev`. The deployed rule:

  | Field | Value |
  |-------|-------|
  | Expression | `(http.host eq "api.asobu.me" and starts_with(http.request.uri.path, "/auto-alt-writer/"))` |
  | Rate | 10 requests / 10 seconds |
  | Counting | by IP (`ip.src`) |
  | Action | Block, for 10 seconds |

  The host clause matters: without it the rule matches `/auto-alt-writer/*` on
  *any* hostname in the zone. The free plan allows one rate-limiting rule and
  only a 10s period — fine here, since a short window is actually harder to
  burst past than a 60s one. If the dashboard shows the hostname field greyed
  out, write the whole condition in the expression editor.

- **Workers KV (in code):**
  ```bash
  npx wrangler kv namespace create RATE_LIMIT
  ```
  Paste the printed id into `wrangler.toml` (uncomment the `[[kv_namespaces]]`
  block), then `npx wrangler deploy`. Defaults to 30 requests / 60s per IP
  (tune `RATE_LIMIT` in `worker.js`). Best-effort — the read-then-write is not
  atomic — but fine for dampening abuse.

## Quota

With a Free-tier key (no billing account attached), you do **not** need to set a
spend cap: there is no spend, and the rate limit returns 429 at the ceiling. Only
attach billing if you deliberately want a paid tier — doing so removes the "429,
never a bill" guarantee.

## Security notes

- The Gemini key never leaves the server.
- `CLIENT_TOKEN` ships inside the extension, so it is **not** a real secret — it
  only filters drive-by traffic. Real protection = rate limiting + request
  validation here + the free-tier ceiling on Google.
- The Worker only accepts `POST`, requires the client token and a `Content-Length`
  within ~30MB, allows only `gemini-3.5-flash-lite`, and requires an inline media
  part. The media requirement only filters casual text-only abuse — a tiny image
  plus a large text part still gets through; the rate limit and Google quota are
  the real ceiling.
- Rotating the key = `npx wrangler secret put GEMINI_API_KEY` again; no
  extension update needed.

## Local test

```bash
npx wrangler dev
# then POST to the local URL with the x-client-token header and a small image payload
```
