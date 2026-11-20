# FastVideoDown API — Render backend

Express backend for the [FastVideoDown](https://fastvideodown.pages.dev/)
video downloader. It replaces the Netlify Functions backend (Netlify's free
deploy credits ran out and deploys are paused; the user wants Netlify gone
entirely). The frontend site stays on Cloudflare Pages — only the API moves
here.

## Endpoints

| Route | Method | Body / Query | Returns |
|---|---|---|---|
| `/` | GET | — | `{ ok: true, service: 'fastvideodown-api' }` (health check) |
| `/api/formats` | POST | `{ url, deep? }` | `{ ok, title, thumbnail, duration, uploader, extractor, webpage_url, formats: { video: [...], audio: [...] } }` |
| `/api/download` | POST | `{ url, formatId, ext?, title?, proxy? }` | `{ ok, url, filename }` (direct CDN URL) |
| `/api/stream` | GET | `?url=..&filename=..&proxyIp=..` | The file itself, with `Content-Disposition: attachment` (forces a real download instead of opening in a player tab) |

The logic is adapted 1:1 from the old Netlify functions
(`netlify/functions/{formats,download}/index.js`, `stream.mjs`):
yt-dlp attempt chains (android / web / tv / no-cert), the format
categorisation (`hasAudio`, one entry per height), the "onlyLow" rule that
keeps scanning when YouTube returns only 360p, the strict
`bestaudio[vcodec=none]` audio selector with the web-client-first order and
the `mime=video` guard, and the stream's `ProxyAgent` fetch through the
matching Webshare proxy.

## Rules (user-set)

- **No cache anywhere** — every lookup runs yt-dlp fresh.
- **Nothing stored** — no files are written to disk; yt-dlp only resolves
  URLs (`-g` / `-J` / `--skip-download`) and its per-run temp dir is created
  and deleted per invocation. `/api/stream` pipes bytes straight through.

## Deploy on Render (free, no card)

1. Push this folder to a GitHub repo (e.g. `fastvideodown-api`).
2. Render dashboard → **New → Web Service** → connect the repo.
   (Or **New from Blueprint** and point it at this repo — `render.yaml`
   already describes the service.)
3. Settings are already in `render.yaml`: build
   `bash fetch-ytdlp.sh && npm install --no-audit --no-fund`, start
   `node server.js`, plan **free**.
4. In the service's **Environment** tab, set:
   - `YTDLP_PROXY` — the comma-separated Webshare proxy list
     (`http://user:pass@IP:PORT,http://user:pass@IP:PORT,...`).
     It rotates the egress IP per yt-dlp call and lets `/api/stream` fetch
     through the exact proxy IP a YouTube CDN URL was issued for.
5. Deploy. Render gives the service a URL like
   `https://fastvideodown-api.onrender.com`.
6. Point the frontend at it: in the site repo (`fastvideodown`), set
   `API_BASE = 'https://fastvideodown-api.onrender.com'` in `index.html`
   and `thumbnail-downloader/index.html`, then redeploy Cloudflare Pages.

## Notes

- Render's free tier sleeps after 15 minutes of inactivity — the first
  request after a sleep takes ~30s to wake the service. That is the only
  free-tier caveat; there is no deploy-credit limit like Netlify's.
- Render has no 6MB function response limit, so `/api/stream` can serve
  large files and the `proxy: true` force-download path in `/api/download`
  is capped at 50MB instead of Netlify's 5.5MB.
- The yt-dlp binary is fetched at build time by `fetch-ytdlp.sh`
  (v2026.10.26) — it is **not** committed to the repo (see `.gitignore`).
