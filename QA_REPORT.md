# QA + performance report

Tested with Node 22 on a 1-CPU sandbox. Baileys, MongoDB, express and pino were **stubbed** (no network there),
so everything below is logic / performance testing of this project's own code. Not tested: a real WhatsApp link,
real downloads from TikTok / YouTube / Instagram, MongoDB, and the Go `callbot` (no Go toolchain in the sandbox).

Run the tests yourself after `npm install`: `npm test` (31 tests).

## Bugs found and fixed
| # | Problem | Fix |
|---|---------|-----|
| 1 | `.ig` and `.tw` never worked: every link was rejected and the error said "Send a valid *Facebook* link" | One `PLATFORMS` table (name, command, accepted hosts) in `lib/downloader.js`; Instagram and Twitter/X are now real platforms |
| 2 | `.password` used `Math.random()` (predictable) | `crypto.randomInt()` |
| 3 | Web-login password check used `scryptSync`: each attempt froze **every** linked session for ~45 ms | async `scrypt` (thread pool) |
| 4 | Settings were written to disk synchronously on every change, non-atomically (a crash could corrupt `_settings.json`) | Debounced, async, atomic (temp file + rename), flushed on shutdown |

## Performance
| What | Before | After |
|------|--------|-------|
| 500 `setSetting` calls | 500 sync disk writes (0.66 ms each, blocking) | 1 async write |
| 10 simultaneous web logins | ~420 ms of frozen event loop | max stall ~8 ms |
| Download larger than the limit, no Content-Length | whole file loaded into RAM, then rejected | stopped after ~4 MB of a 200 MB stream (46 ms) |
| Many users downloading at once | unlimited yt-dlp / fetch jobs | max 3 at a time (`MAX_DL_JOBS`), rest wait in line |
| Messages in one batch | processed one after another; a slow download blocked the rest | run concurrently |
| First reply after start | could wait up to 30 s for the profile-picture card | waits max 1.5 s, picture shared between replies, failed fetch retried after 2 min |
| Status de-duplication map | full scan of the map on every status once it passed 2000 entries (simulated: ~198 M iterations per 20 k statuses) | cleaned once a minute |
| Group-metadata cache, status debug map | grew forever | evicted / capped |
| Static files (`public/`) | no caching | 1 h cache, HTML always fresh |

## Checked and OK
All 114 commands (206 names) load with no duplicate names and run without crashing when called with no arguments;
button messages fall back to plain text when the button send fails; `.calc` refuses anything except maths;
download URL checks reject look-alike hosts (`evil-instagram.com`, `instagram.com.evil.io`), `file:` and `javascript:` links.

## New env var
`MAX_DL_JOBS` (default 3): how many downloads / yt-dlp runs may happen at the same time.

## Admin additions (broadcast, logs, audit, security, backup)
Tested in a sandbox with stubbed Baileys / MongoDB / express (no network). `tests/adminx.test.js` (new, needs `npm install` for express) covers
the log masking, audit storage, scheduled jobs, backup encrypt / decrypt / restore (including a path-traversal file name), login lockout
(with a mocked clock) and the HTTP routes. Not tested: a real browser, a real restore of live WhatsApp sessions, MongoDB backups.

| # | Problem | Fix |
|---|---------|-----|
| 5 | A route that threw an error **before its first await** (for example a wrong admin password, many `/api/admin/*` validations) skipped the JSON error handler and reached Express as a plain error, so the page only showed "Something went wrong" | `wrap()` now runs the handler inside `.then()`, so every thrown `HttpError` is answered as JSON with its own message |
| 6 | Admin audit list was memory only (100 entries, no IP) | Stored (1000 entries) with IP |
