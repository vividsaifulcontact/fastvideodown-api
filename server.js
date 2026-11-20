// FastVideoDown API — Express backend for Render (free web service).
// Replaces the Netlify Functions backend (formats / download / stream).
// All yt-dlp logic is adapted 1:1 from the Netlify functions; only the
// handler plumbing changed (Netlify event -> Express req/res).
//
// Endpoints:
//   POST /api/formats   { url }            -> available qualities + audio
//   POST /api/download  { url, formatId }  -> direct CDN URL for a format
//   GET  /api/stream    ?url=..&filename=..&proxyIp=..
//                                          -> streams the file with
//                                             Content-Disposition: attachment
//   GET  /                             -> health check
//
// Rules (user-set, do not change):
//   - NO cache anywhere: every lookup runs yt-dlp fresh.
//   - NOTHING is stored: no files are written to disk (yt-dlp only ever
//     resolves URLs with -g/-J/--skip-download; its per-run TMPDIR is
//     created and deleted per invocation).
//   - CORS is wide open (Access-Control-Allow-Origin: '*') because the
//     frontend runs on Cloudflare Pages (fastvideodown.pages.dev) while
//     this API runs here. The '*' on the /api/stream SUCCESS response is
//     critical: without it the browser blocks the frontend's stream
//     pre-check, the check fails and downloads fall back to opening the
//     direct link in a new tab.
const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { fetch: ufetch, ProxyAgent } = require('undici');

const PORT = process.env.PORT || 10000;

// ---------- yt-dlp binary: find it and run it ----------
// The PyInstaller onefile binary extracts ~120MB into TMPDIR at startup.
// Render gives each service its own filesystem; TMPDIR stays unique per run
// and is cleaned up, so /tmp never fills up.
function findBinarySrc() {
  const candidates = [
    path.join(__dirname, 'yt-dlp'),           // fetched at build by fetch-ytdlp.sh
    path.join(__dirname, 'bin', 'yt-dlp'),
    path.join(process.cwd(), 'yt-dlp'),
    path.join(process.cwd(), 'bin', 'yt-dlp'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* next */ }
  }
  return 'yt-dlp'; // fall back to PATH
}

function runYtDlp(args, timeoutMs) {
  return new Promise((resolve) => {
    const src = findBinarySrc();
    // Run the bundled binary directly (no per-invocation copy). The
    // PyInstaller binary still extracts into its own temp dir per run, so
    // TMPDIR stays unique per invocation and is cleaned up.
    const tag = process.pid + '-' + crypto.randomBytes(4).toString('hex');
    const tmpDir = '/tmp/yt-' + tag;
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
    execFile(src, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, HOME: '/tmp', XDG_CACHE_HOME: '/tmp/.cache', YTDLP_NO_UPDATE: '1', TMPDIR: tmpDir },
    }, (err, stdout, stderr) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      if (err) {
        const msg = (stderr || '').includes('binary_not_found')
          ? 'binary_not_found (__dirname=' + __dirname + ' cwd=' + process.cwd() + ')'
          : err.message;
        console.error('[yt-dlp] exec error: ' + msg + ' | stderr: ' + (stderr || '').slice(0, 500));
        if (err.code === 'ENOENT') {
          return resolve({ err: new Error('binary_not_found (__dirname=' + __dirname + ' cwd=' + process.cwd() + ')'), stdout: '', stderr: 'binary_not_found' });
        }
      }
      resolve({ err, stdout, stderr });
    });
  });
}

// ---------- shared helpers (from formats function) ----------

function classifyError(stderr) {
  const s = (stderr || '').toLowerCase();
  if (s.includes('binary_not_found') || s.includes('binary_prepare_failed'))
    return { code: 'engine_error', error: 'Download engine is not available on the server right now.' };
  if (s.includes('ip address is blocked') || s.includes('blocked from accessing'))
    return { code: 'ip_blocked', error: 'This platform blocked the server (IP blocked). Try another link or try again later.' };
  // YouTube's anti-bot screen ("Sign in to confirm you're not a bot") is NOT
  // a private video — the video is public, YouTube is just refusing the
  // server's IP. Say so plainly instead of claiming it needs a login.
  if (s.includes('not a bot') || s.includes('sign in to confirm') || s.includes('confirm you'))
    return { code: 'bot_check', error: 'YouTube blocked this request from our server (it asked to sign in to prove it is not a bot). The video itself is public — please try again later, or try a different video.' };
  if (s.includes('login required') || s.includes('log in') || s.includes('cookies') || s.includes('sign in to confirm'))
    return { code: 'login_required', error: 'This link needs a logged-in account (private / login-only content).' };
  if (s.includes('unsupported url') || s.includes('no video') || s.includes('not a valid url'))
    return { code: 'unsupported', error: 'This link is not supported or has no downloadable video.' };
  if (s.includes('timed out') || s.includes('timeout'))
    return { code: 'timeout', error: 'The platform took too long to respond. Please try again.' };
  if (s.includes('private video') || s.includes('this video is private'))
    return { code: 'private', error: 'This video is private.' };
  if (s.includes('video unavailable') || s.includes('removed') || s.includes('deleted'))
    return { code: 'unavailable', error: 'This video is unavailable or was removed.' };
  return { code: 'failed', error: 'Could not fetch this link. The platform may be blocking downloads right now.' };
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0] && sorted[0].url ? sorted[0].url : null;
}

function buildFormats(list) {
  const videoByHeight = new Map();
  const audioByKey = new Map();
  for (const f of list || []) {
    if (!f || !f.url || f.ext === 'mhtml') continue;
    const proto = (f.protocol || '').toLowerCase();
    if (proto && !proto.startsWith('http')) continue;
    // Some extractors (e.g. X/Twitter syndication) omit codec fields: a format
    // with a height but no codec info is a combined video+audio file.
    const hasVideo = (f.vcodec && f.vcodec !== 'none') || !!f.height;
    const hasAudio = (f.acodec && f.acodec !== 'none') || (!f.vcodec && !f.acodec && !!f.height);
    if (hasVideo) {
      const h = f.height || 0;
      if (!h) continue;
      const key = String(h);
      const item = {
        format_id: String(f.format_id),
        label: h + 'p',
        height: h,
        ext: f.ext || 'mp4',
        hasAudio: !!hasAudio,
        fps: f.fps || null,
        filesize: f.filesize || f.filesize_approx || null,
        vcodec: f.vcodec,
        // Direct link, already fetched: the Download button opens it instantly
        // instead of running a second yt-dlp lookup.
        url: f.url || null,
      };
      const prev = videoByHeight.get(key);
      if (!prev || (!prev.hasAudio && item.hasAudio) ||
          (prev.hasAudio === item.hasAudio && (item.filesize || 0) > (prev.filesize || 0))) {
        videoByHeight.set(key, item);
      }
    } else if (hasAudio) {
      const key = (f.ext || 'audio') + '|' + (f.abr || 0);
      const item = {
        format_id: String(f.format_id),
        label: (f.abr ? Math.round(f.abr) + ' kbps' : (f.ext || 'audio')).toUpperCase(),
        ext: f.ext || 'm4a',
        abr: f.abr || null,
        filesize: f.filesize || f.filesize_approx || null,
        // Direct link, already fetched: the Download button opens it instantly.
        url: f.url || null,
      };
      const prev = audioByKey.get(key);
      if (!prev || (item.filesize || 0) > (prev.filesize || 0)) audioByKey.set(key, item);
    }
  }
  const video = [...videoByHeight.values()].sort((a, b) => b.height - a.height);
  const audio = [...audioByKey.values()].sort((a, b) => (b.abr || 0) - (a.abr || 0));
  return { video, audio };
}

function proxyArgs() {
  // Proxy pool (IP rotation): YTDLP_PROXY = one proxy URL or a
  // comma-separated list to rotate the egress IP per request. Without it,
  // every request leaves from the same server IP and platforms can block it.
  const proxies = (process.env.YTDLP_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);
  return proxies.length ? ['--proxy', proxies[Math.floor(Math.random() * proxies.length)]] : [];
}

// ---------- download helpers (from download function) ----------

function safeName(title, ext) {
  const base = (title || 'video').replace(/[^\w\s\-\u0980-\u09FF.]/g, '').trim().slice(0, 80) || 'video';
  return base + '.' + (ext || 'mp4');
}

// Fetch a small file (audio / short clip) through the server so the browser
// is FORCED to download it instead of playing it. Direct .mp4/.mp3 links
// open in the browser's player; a same-origin Blob download is always saved.
// Capped at 50MB — Render has no 6MB function response limit like Netlify
// did (the Netlify cap was 5.5MB). Bigger files fall back to the direct
// link. Follows redirects (googlevideo 302s).
const MAX_PROXY_BYTES = 50 * 1024 * 1024;
function fetchSmall(startUrl, timeoutMs) {
  return new Promise((resolve) => {
    let redirects = 0;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    const go = (u) => {
      const lib = u.startsWith('https:') ? https : http;
      const req = lib.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          redirects++;
          res.resume();
          go(new URL(res.headers.location, u).toString());
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          clearTimeout(timer); res.resume();
          return finish({ ok: false, reason: 'http_' + res.statusCode });
        }
        const chunks = [];
        let total = 0;
        let tooBig = false;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_PROXY_BYTES) { tooBig = true; req.destroy(); }
          else chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(timer);
          if (tooBig) return finish({ ok: false, reason: 'too_big' });
          finish({ ok: true, buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'application/octet-stream' });
        });
        res.on('error', () => { clearTimeout(timer); finish({ ok: false, reason: 'stream_error' }); });
      });
      req.on('error', () => { clearTimeout(timer); finish({ ok: false, reason: 'fetch_error' }); });
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) { /* ignore */ } clearTimeout(timer); finish({ ok: false, reason: 'timeout' }); });
    };
    go(startUrl);
  });
}

// ---------- app ----------

const app = express();
app.use(express.json({ limit: '64kb' }));

// CORS: the frontend runs on Cloudflare Pages; this API runs here.
// Wide open on every route, including OPTIONS preflight.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'fastvideodown-api' });
});

// ---------- POST /api/formats ----------
// Body: { url, deep? } — deep=true forces the web scan first (more
// qualities, slower). No cache: every lookup runs yt-dlp fresh.
app.post('/api/formats', async (req, res) => {
  const url = ((req.body || {}).url || '').trim();
  if (!/^https?:\/\/.+/i.test(url)) {
    return res.status(400).json({ ok: false, code: 'bad_url', error: 'Please paste a valid link starting with http:// or https://' });
  }
  const pArgs = proxyArgs();
  const isX = /https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(url);

  const baseArgs = ['-J', '--no-playlist', '--skip-download', '--no-warnings',
    '--socket-timeout', '8', '--retries', '1',
    '--js-runtimes', 'node', '--remote-components', 'ejs:github'];
  const androidArgs = ['-J', '--no-playlist', '--skip-download', '--no-warnings',
    '--socket-timeout', '8', '--retries', '1',
    '--extractor-args', 'youtube:player_client=android', ...pArgs, url];
  const androidNoCertArgs = ['-J', '--no-playlist', '--skip-download', '--no-warnings',
    '--socket-timeout', '8', '--retries', '1', '--no-check-certificates',
    '--extractor-args', 'youtube:player_client=android', ...pArgs, url];
  const webArgs = [...baseArgs, '--extractor-args', 'youtube:player_client=web,android', ...pArgs, url];
  // X/Twitter: the default GraphQL API is blocked from server IPs, but the
  // public syndication (embed) endpoint still answers — use it as fallback.
  const syndicationArgs = ['-J', '--no-playlist', '--skip-download', '--no-warnings',
    '--socket-timeout', '8', '--retries', '1',
    '--extractor-args', 'twitter:api=syndication', ...pArgs, url];
  // Fast path first (android client answers in ~3s); web scan is slower.
  // Per-attempt timeouts sum to <=25s. (Render has no 26s function limit
  // like Netlify did, but keeping the same budget keeps lookups snappy.)
  const deep = !!((req.body || {}).deep);
  // No cache: every lookup runs yt-dlp fresh, so nothing is stored.
  const isYT = /https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
  // YouTube deep scan: web first (full formats with the EJS solver), then the
  // TV client — from server IPs it sometimes returns the high qualities the
  // web client withholds — then the reliable android fallback, then no-cert.
  const tvArgs = [...baseArgs, '--extractor-args', 'youtube:player_client=tv', ...pArgs, url];
  const mid = isX ? { a: syndicationArgs, t: 9000 } : { a: webArgs, t: 12000 };
  const attempts = deep
    ? (isYT
      ? [{ a: webArgs, t: 9000 }, { a: tvArgs, t: 6000 }, { a: androidArgs, t: 5000 }, { a: androidNoCertArgs, t: 5000 }]
      : [mid, { a: androidArgs, t: 8000 }, { a: androidNoCertArgs, t: 5000 }])
    : [{ a: androidArgs, t: 8000 }, mid, { a: androidNoCertArgs, t: 5000 }];

  let data = null;
  let bestData = null;
  let bestCount = 0;
  let lastErr = '';
  for (const { a, t } of attempts) {
    const { stdout, stderr } = await runYtDlp(a, t);
    lastErr = stderr || '';
    if (stdout) {
      try { data = JSON.parse(stdout); } catch (e) { data = null; }
    }
    if (data) {
      // Fast path: usable formats found — return now, don't wait for slower scans.
      const f = buildFormats(data.formats);
      if (f.video.length || f.audio.length) {
        // YouTube: don't stop at the low 360p-only fallback — a later
        // client (web/tv) may return the high qualities (720p with sound,
        // 1080p video-only, real audio-only). The android client alone only
        // ever returns itag 18 (360p), so without this the user never sees
        // 720p/1080p or a working audio-only option. Applies whenever it's
        // YouTube and only 360p with no audio (no deep flag required).
        const onlyLow = isYT && !f.video.some(v => (v.height || 0) > 360) && !f.audio.length;
        if (onlyLow) {
          const n = f.video.length + f.audio.length;
          if (n > bestCount) { bestCount = n; bestData = data; }
          data = null;
          continue;
        }
        break;
      }
      data = null;
    }
  }
  if (!data) data = bestData;

  if (!data) {
    const c = classifyError(lastErr);
    return res.status(200).json({ ok: false, ...c, detail: (lastErr || '').slice(0, 300) });
  }

  const formats = buildFormats(data.formats);
  if (!formats.video.length && !formats.audio.length) {
    return res.status(200).json({ ok: false, code: 'no_formats', error: 'No downloadable formats were found for this link.' });
  }

  res.json({
    ok: true,
    title: data.title || 'Video',
    thumbnail: pickThumbnail(data.thumbnails),
    duration: data.duration || null,
    uploader: data.uploader || data.channel || null,
    extractor: data.extractor || null,
    webpage_url: data.webpage_url || url,
    formats,
  });
});

// ---------- POST /api/download ----------
// Body: { url, formatId, ext?, title?, proxy? }
// Returns { ok, url, filename } or { ok:false, error, detail }.
// Note: returns the direct media URL; the browser downloads it straight
// from the platform CDN (or via /api/stream for a forced download).
app.post('/api/download', async (req, res) => {
  const body = req.body || {};
  const url = (body.url || '').trim();
  let formatId = String(body.formatId || 'best').trim();
  if (!/^https?:\/\/.+/i.test(url)) {
    return res.status(400).json({ ok: false, error: 'Invalid link.' });
  }
  // 'bestaudio' must stay WITHOUT a /best fallback: with 'bestaudio/best',
  // a missing audio-only format silently returns the VIDEO file, so a user
  // clicking "Audio only" would get a video mislabeled as audio. Keep it
  // strict — the attempt loop tries several clients for bestaudio, and if
  // none has it, we return a clear error instead of the wrong file.
  // The [vcodec=none] filter makes it truly audio-only: plain 'bestaudio'
  // still picks the combined 360p format (itag 18) when no audio-only
  // format is listed, because that format "has audio".
  const isAudio = formatId === 'bestaudio';
  if (isAudio) formatId = 'bestaudio[vcodec=none]';
  if (!/^[a-zA-Z0-9_\-\+\/\[\]=]+$/.test(formatId)) {
    return res.status(400).json({ ok: false, error: 'Invalid format.' });
  }
  const ext = String(body.ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const title = String(body.title || 'video').slice(0, 120);

  const pArgs = proxyArgs();
  const isX = /https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(url);

  // Fast path first: android client answers in ~3s; web scan is slower.
  // X/Twitter: fall back to the public syndication (embed) endpoint.
  // Per-attempt timeouts sum to <=25s.
  // EXCEPTION — audio: the android client returns only the combined 360p
  // format (itag 18) for many videos, so bestaudio must try the WEB client
  // first (it lists real audio-only streams like itag 140). Otherwise the
  // android attempt "succeeds" with the video file and the loop never
  // reaches the web client.
  const mk = (extra) => ['-g', '-f', formatId, '--no-playlist', '--no-warnings',
    '--socket-timeout', '8', '--retries', '1', ...extra, ...pArgs, url];
  const webAttempt = { a: mk(['--js-runtimes', 'node', '--remote-components', 'ejs:github', '--extractor-args', 'youtube:player_client=web,android']), t: 12000 };
  const androidAttempt = { a: mk(['--extractor-args', 'youtube:player_client=android']), t: 8000 };
  const attempts = isAudio
    ? [webAttempt, androidAttempt, { a: mk(['--no-check-certificates', '--extractor-args', 'youtube:player_client=android']), t: 5000 }]
    : [
      androidAttempt,
      isX
        ? { a: mk(['--extractor-args', 'twitter:api=syndication']), t: 9000 }
        : webAttempt,
      { a: mk(['--no-check-certificates', '--extractor-args', 'youtube:player_client=android']), t: 5000 },
    ];
  let direct = '';
  let stderr = '';
  for (const { a, t } of attempts) {
    const r = await runYtDlp(a, t);
    stderr = r.stderr || stderr;
    direct = (r.stdout || '').trim().split('\n')[0] || '';
    if (/^https?:\/\//.test(direct)) {
      // Audio-only guard: never hand a VIDEO file to an "Audio only"
      // download. YouTube's googlevideo URLs carry mime=video/mp4 for
      // combined/video formats and mime=audio/... for real audio. If this
      // attempt returned a video, discard it and try the next client
      // (the web client lists real audio-only streams).
      if (isAudio && /[?&]mime=video%2F/i.test(direct)) { direct = ''; continue; }
      break;
    }
  }
  if (!/^https?:\/\//.test(direct)) {
    const s = (stderr || '').toLowerCase();
    const error = s.includes('binary_not_found') || s.includes('binary_prepare_failed')
      ? 'Download engine is not available on the server right now.'
      : s.includes('not a bot') || s.includes('sign in to confirm') ? 'YouTube blocked this request from our server (bot check). The video itself is public — please try again later, or try a different video.'
      : s.includes('blocked') ? 'This platform blocked the server. Try again later.'
      : s.includes('login') || s.includes('cookies') ? 'This link needs a logged-in account.'
      : 'Could not get a download link for this format. Please try again.';
    return res.status(200).json({ ok: false, error, detail: (stderr || '').slice(0, 300) });
  }
  // Force-download mode (proxy: true): stream small files through the server
  // with Content-Disposition: attachment so the browser SAVES the file
  // instead of playing it. Falls back to the direct link when the file is
  // too big or the fetch fails.
  if (body.proxy) {
    const got = await fetchSmall(direct, 20000);
    if (got.ok) {
      res.set('Content-Type', got.contentType);
      res.set('Content-Disposition', 'attachment; filename="' + safeName(title, ext).replace(/"/g, '') + '"');
      return res.status(200).send(got.buffer);
    }
  }
  return res.status(200).json({ ok: true, url: direct, filename: safeName(title, ext) });
});

// ---------- GET /api/merge ----------
// High-quality video WITH sound (1080p and above). YouTube does NOT ship a
// pre-merged 1080p/1440p/2160p file — those qualities are video-only DASH
// streams. The only way to deliver e.g. 1080p WITH sound is to download
// the video-only stream + the audio-only stream and MERGE them with ffmpeg
// (yt-dlp does this). That is what this endpoint does, on demand:
//   GET /api/merge?url=<page url>&height=1080&filename=<name.mp4>
// It runs yt-dlp (no -g: it downloads + merges to a temp file), then
// streams the merged MP4 to the browser with Content-Disposition:
// attachment, and deletes the temp file right after. Nothing is kept —
// the temp file exists only for this one download (user rule: no cache,
// nothing stored). Merging takes a while (download both streams + mux),
// so the browser shows a "Preparing…" state while it runs. Render has no
// 26s function timeout, so long merges can finish; very long videos may
// still be slow — the frontend warns the user before starting one.
app.get('/api/merge', async (req, res) => {
  const url = (req.query.url || '').trim();
  const height = Math.max(360, Math.min(4320, parseInt(req.query.height || '1080', 10) || 1080));
  const filename = (req.query.filename || 'video.mp4').replace(/[^\w.\-]/g, '_').slice(0, 100) || 'video.mp4';
  const jsonErr = (status, error) => { if (!res.headersSent) res.status(status).json({ ok: false, error }); };
  if (!/^https?:\/\/.+/i.test(url)) return jsonErr(400, 'Missing url');

  const src = findBinarySrc();
  if (!src) return jsonErr(500, 'Download engine is not available on the server right now.');
  const tag = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpDir = '/tmp/merge-' + tag;
  const outTemplate = tmpDir + '/video.%(ext)s';
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

  const pArgs = proxyArgs();
  const args = [
    '-f', 'bestvideo[height<=' + height + ']+bestaudio/bestvideo[height<=' + height + ']+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--no-playlist', '--no-warnings',
    '--socket-timeout', '10', '--retries', '1',
    '--js-runtimes', 'node', '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=web,android',
    '-o', outTemplate,
    ...pArgs, url,
  ];
  // Generous timeout: a merge downloads two streams and muxes them.
  const merged = await new Promise((resolve) => {
    execFile(src, args, {
      timeout: 540000,
      maxBuffer: 10 * 1024 * 1024,
      // yt-dlp finds ffmpeg on PATH — the static build lives in ./bin.
      env: { ...process.env, HOME: '/tmp', XDG_CACHE_HOME: '/tmp/.cache', YTDLP_NO_UPDATE: '1', TMPDIR: tmpDir, PATH: path.join(__dirname, 'bin') + ':' + (process.env.PATH || '') },
    }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
  if (merged.err) {
    cleanup();
    const s = (merged.stderr || '').toLowerCase();
    const error = s.includes('not a bot') || s.includes('sign in to confirm')
      ? 'YouTube blocked this request from our server (bot check). The video itself is public — please try again later, or try a different video.'
      : s.includes('ffmpeg') || s.includes('ffprobe')
        ? 'The server could not merge the video and audio (ffmpeg unavailable). Try a lower quality with sound instead.'
        : 'Could not prepare this quality with sound. Please try again or pick a lower quality.';
    return jsonErr(200, error);
  }
  // Find the merged file (yt-dlp names it video.mp4 after --merge-output-format).
  let file = null;
  try {
    const files = fs.readdirSync(tmpDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f));
    if (files.length) file = path.join(tmpDir, files[0]);
  } catch (e) { /* ignore */ }
  if (!file) { cleanup(); return jsonErr(500, 'Could not prepare this quality with sound. Please try again.'); }
  res.set('Content-Type', 'video/mp4');
  res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.set('Access-Control-Allow-Origin', '*');
  try { res.set('Content-Length', String(fs.statSync(file).size)); } catch (e) { /* ignore */ }
  res.status(200);
  const stream = fs.createReadStream(file);
  stream.on('error', () => { cleanup(); try { res.end(); } catch (e) { /* ignore */ } });
  stream.on('end', cleanup);
  res.on('close', cleanup);
  stream.pipe(res);
});

// ---------- GET /api/stream ----------
// Streams a large video/image through the server so the browser is FORCED
// to download it (Content-Disposition: attachment) instead of opening it
// in a player tab. The file is piped straight from the CDN to the browser,
// chunk by chunk, without being held in memory. No size limit (Render has
// no 6MB function limit like Netlify did); a very large file on a slow
// connection may still take a while, but nothing is stored on disk.
//   GET /api/stream?url=<direct CDN url>&filename=<name.mp4>&proxyIp=<ip>
//
// WHY THE PROXY: YouTube's googlevideo URLs are IP-locked to the IP yt-dlp
// used when it resolved the link (the URL carries ip=<proxy ip> and, for
// many videos, NO ipbypass=yes). The stream runs on the Render server IP,
// so a direct fetch is rejected with 403. The frontend therefore passes
// proxyIp= (the ip= value from the direct URL); we find the Webshare proxy
// with that exact IP in YTDLP_PROXY and fetch through it, so the CDN sees
// the IP the URL was issued for.
app.get('/api/stream', async (req, res) => {
  const target = req.query.url || '';
  const filename = (req.query.filename || 'video.mp4').replace(/[^\w.\-]/g, '_').slice(0, 100) || 'video.mp4';
  const proxyIp = req.query.proxyIp || '';
  const jsonErr = (status, error) => res.status(status).json({ ok: false, error });
  if (!/^https?:\/\//.test(target)) return jsonErr(400, 'Missing url');

  // Find the Webshare proxy whose host is exactly the IP the URL was
  // issued for. YTDLP_PROXY is a comma-separated list of individual
  // proxy URLs (http://user:pass@IP:PORT). If none matches, fall back
  // to a direct fetch (works when the URL has ipbypass=yes).
  let dispatcher;
  if (proxyIp) {
    const proxies = (process.env.YTDLP_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);
    const match = proxies.find(p => {
      try { return new URL(p).hostname === proxyIp; } catch { return false; }
    });
    if (match) dispatcher = new ProxyAgent(match);
  }

  try {
    const upstream = await ufetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      redirect: 'follow',
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!upstream.ok || !upstream.body) return jsonErr(502, 'Could not fetch the file.');
    res.set('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
    // CORS: the frontend runs on Cloudflare Pages while this API runs
    // here, so the frontend's stream pre-check is cross-origin. Without
    // this header the browser blocks the pre-check (CORS), the check fails
    // and the download falls back to opening the direct link in a new tab.
    res.set('Access-Control-Allow-Origin', '*');
    const len = upstream.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    res.status(200);
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.end(); } catch (e) { /* ignore */ } });
    nodeStream.pipe(res);
  } catch (e) {
    if (!res.headersSent) return jsonErr(502, 'Stream failed.');
    try { res.end(); } catch (e2) { /* ignore */ }
  }
});

app.listen(PORT, () => {
  console.log('fastvideodown-api listening on port ' + PORT);
});
