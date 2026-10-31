# RIO X MD

Multi-session WhatsApp bot (Baileys) with a modern pairing website (pair code or QR), downloaders, owner tools, status tools and real call answering (Go service).

> Baileys is an unofficial WhatsApp client and may break when WhatsApp changes. Use it only with your own account.

## Features
| Area | What it does |
|---|---|
| Pairing site | Link your own number with a pair code or QR. Live "online" counter. |
| Menu | `.menu` image + buttons, `.alive`, emoji reaction on every command, bot DP link-preview card on every reply. |
| Downloaders | TikTok, Facebook, Pinterest, YouTube song / video. |
| TikTok search | `.tts <words>` shows results as swipeable cards with **VIDEO / AUDIO / MORE** buttons. |
| Sri Lanka news | `.news`, `.hiru`, `.derana`, `.itn` and **auto posting** of new headlines to the groups and channels you add. |
| Status tools | Auto view, auto react (your own emojis), auto save, view-once recovery. |
| Owner tools | public / private mode, broadcast, block, join, leave, bio, profile picture, restart. |
| Web settings | After linking, the bot sends a password to your own chat. Log in at `/settings` with your number to switch features on or off. |
| Admin site | `/admin` controls all sessions: search, tick many numbers and change an option, restart, send passwords or messages, reset or unlink them in one go. It can also pause new links. |
| Premium branding | Numbers with active premium can set their own **bot name, footer text and logo picture** on the `/settings` page (Branding card). It is used in every reply, menu and link card of that number only. Free numbers see the card locked; when premium ends the defaults return (saved values are kept). Logo = direct https link to a JPG/PNG/WEBP (max 3 MB), checked and downloaded server-side. |
| Channel support (premium) | A premium user adds a WhatsApp channel on `/settings`. Numbers whose owner switched on **Support other channels** (off by default, only the owner can change it, never in bulk or by the admin) follow it and react to new posts. Opting out, removing the channel or the premium ending makes them unfollow. Actions are spaced out and capped (`BOOST_GAP_MS`, `BOOST_MAX_ACTIONS`, `BOOST_POLL_MIN`, `BOOST_MAX_CHANNELS`, `BOOST_DISABLED=true` to switch it off). |
| Calls | Reject calls, reject + auto reply with a saved audio / video, or **really answer** and stream a saved audio / video into the call. |

## Run locally
```bash
cp .env.example .env     # set PAIRING_API_KEY (12+ chars) and OWNER_NUMBER
npm install
npm start
```
Open `http://localhost:3000`, enter your number (digits only, with country code) and press **Generate Pair Code**.
Needs Node 20+. For downloads install `ffmpeg`; yt-dlp is downloaded automatically. For real call answering also build the Go service (see below).

## Deploy on Render (Docker)
The repo ships a `Dockerfile` (Node bot + Go call service + ffmpeg + git) and `render.yaml` with `runtime: docker`.
1. Push the repo to GitHub (never commit `.env`, `sessions/`).
2. Render → **New → Blueprint** (or **New → Web Service → Language: Docker**), plan **Starter** or higher.
3. Set the environment variables below. Add a **persistent disk** mounted at `/var/data` and set `SESSION_DIR=/var/data/sessions`.
4. Health check path: `/health`.
Important: a service created as "Node" cannot be switched to Docker. Create a new Docker service, copy the variables, then delete the old one (two services on the same sessions disconnect each other).
Without a disk, files are wiped on every redeploy. With `MONGO_URL` the WhatsApp sessions, settings and saved call clips are also kept in MongoDB. The call-service link (`SESSION_DIR/_callbot`) needs the disk.

## Project layout and adding commands
```
index.js            pairing website + API, startup / shutdown
views/              /settings and /admin pages (script and styles in public/web.js, public/web.css)
lib/                shared code (config, storage, session, router, menu, downloader, calls, status ...)
commands/           one file per group of commands, loaded automatically
```
To add a command, open a file in `commands/` (or create a new `.js` file there) and add an object:
```js
export default [
  { name: 'hello', aliases: ['hi'], async run({ reply, name }) { return reply(`Hello ${name}!`); } },
];
```
Optional fields: `owner: true` (owner only), `hidden: true` (silent for everyone else), `react: '👋'` (emoji on the command message).
`run()` receives `sock, msg, jid, sessionId, args, command, name, reply, isOwner, isAdmin, targetJid`. Then add one line for it in the menu text in `lib/menu.js`. A broken command file only disables itself, the others keep working.

## Environment variables
| Variable | Meaning |
|---|---|
| `PAIRING_API_KEY` | Secret for the pairing API (only enforced when `PAIRING_REQUIRE_KEY=true`). |
| `OWNER_NUMBER` | Your number with country code, digits only. Owner button, owner contact card, `.restart`. |
| `BOT_NAME`, `PREFIX` | Bot name and command prefix (default `.`). |
| `MENU_IMAGE` | Picture for the menu / alive message (also the DP-card fallback). Downloaded once and cached; if the host is blocked from Render the bot also tries an image proxy. For zero network dependence, put the picture at `public/menu.jpg` and it is used first. |
| `BUTTONS` | Default `off`: image + text (always shows). `on` = try tappable buttons first (WhatsApp often hides them, so only use if they work for you). |
| `MODE` | `public` (default) or `private` (only the owner can use the bot). `.mode` changes it per session. |
| `CARD_URL` | Link opened by the DP card on replies. |
| `MONGO_URL`, `MONGO_DB` | MongoDB Atlas connection. Sessions survive redeploys. Allow `0.0.0.0/0` in Atlas network access. |
| `SESSION_DIR` | Where sessions and settings are stored (`/var/data/sessions` on Render). |
| `MAX_SESSIONS` | Maximum linked numbers (default 20). |
| `MAX_DL_MB` | Download size limit (default 50). |
| `YTDLP_PATH`, `YTDLP_COOKIES` | yt-dlp location / YouTube cookies when YouTube asks for a bot check. |
| `CALLBOT_DIR`, `CALLBOT_PORT` | Optional, call service data folder / localhost port (8099). |
| `PUBLIC_URL` | Public address of the site (for example `https://your-app.onrender.com`). Used in the web password message. Render's own `RENDER_EXTERNAL_URL` is used when this is empty. |
| `WEB_SECRET` | Long random text used to sign web logins. Set it, otherwise everyone is logged out on each restart. |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Login for `/admin` (user defaults to `admin`). The admin site stays off unless the password has 10+ characters. |
| `TIMEZONE` | Greeting and clock time zone (default `Asia/Colombo`). |
| `TIKTOK_RAPIDAPI_KEY` | Your RapidAPI key for `.tts` (ScrapTik, subscribe on rapidapi.com, the free plan is enough). **Never put it in the repo or share it: set it only in Render's Environment tab.** |
| `TIKTOK_SEARCH_URL` | Optional: any other JSON search API for `.tts`. Paste the URL from its "Code snippet" and write `{q}` where the search words go. RapidAPI URLs get the key and host headers added automatically. |
| `TIKTOK_RAPIDAPI_PATH` | Optional: path of a `tiktok-scraper20` search endpoint, only if its automatic path guess fails. |
| `NEWS_LANG` | `si` (default, Sinhala) or `en`: language of the news feeds. |
| `NEWS_POLL_MIN` | Minutes between news checks (default 3). |

## Commands
Send `menu` or `help` without the prefix and it works too.

**Public (`.menu`)**
- General: `.alive`, `.ping`, `.runtime`, `.about`, `.owner`, `.status`
- Download: `.tt <link>`, `.fb <link>`, `.pin <link>`, `.song <name or link>`, `.tts <search words>` (TikTok search), `.ttdl <link>` / `.ttmp3 <link>` (TikTok video / sound straight away)
- News: `.news [hiru|derana|itn]`, `.hiru`, `.derana`, `.itn`
- Channel songs (owner): `.csong <channel link | jid> <song name>` posts the thumbnail + details and then the song as a **voice note** to a WhatsApp channel (or group). Without a channel it posts in the current chat. Needs ffmpeg (included in the Docker image) and, if YouTube shows a bot check, YouTube cookies (`YTDLP_COOKIES`).
- Media / stickers: `.tosticker` (photo → sticker), `.toasticker` (video / GIF → animated sticker), `.toimg` (sticker → photo), `.tovideo` (animated sticker → video), `.sticker` / `.media` (help). Reply to the media or send it with the command as the caption. Stickers carry the bot name as pack name and the footer as publisher (a premium number's own brand is used instead). Needs ffmpeg (in the Docker image). `.tovideo` uses `anim_dump` from the `webp` package when it is installed (also in the Docker image) and has a built-in fallback when it is not. `MAX_STICKER_JOBS` (default 2) limits how many conversions run at once.
- Group (anyone): `.groupinfo`, `.grouphelp`, `.admins`, `.rules`, `.tagadmins`, `.poll Question | A | B`, `.gsettings`
- Group admin (the bot must be a group admin): `.kick`, `.add`, `.promote`, `.demote`, `.warn`, `.resetwarn`, `.warnlist`, `.tagall`, `.hidetag`, `.del`, `.group open|close` (`.mute` / `.unmute`), `.setname`, `.setdesc`, `.setgpp`, `.link`, `.revoke`, `.lockinfo` / `.unlockinfo`, `.ephemeral`, `.requests`, `.approveall`, `.rejectall`, `.rules set <text>`, `.antilink off|on|all`, `.welcome` / `.goodbye` (`on`, `off`, `set <text>`, `reset`, placeholders `{user} {group} {count} {desc}`)
- Fun (`.funmenu`): `.joke`, `.fact`, `.quote`, `.8ball`, `.dice`, `.coin`, `.rps`, `.pick`, `.rate`, `.ship`, `.truth`, `.dare`, `.wyr`, `.hug`, `.slap`, `.reverse`, `.mock`, `.clap`, `.calc`, `.password`, `.roast`, `.compliment`, `.pickup`, `.fortune`, `.iq`, `.slot`, `.riddle`, `.mathquiz`, `.answer`, `.guess`
- Tools: `.fancy`, `.upside`, `.binary` / `.unbinary`, `.morse`, `.b64` / `.unb64`, `.qr`, `.random`, `.time`, `.remind`
- Status & view-once (work for the account that linked the bot): `.autostatus`, `.statusseen`, `.statusreact`, `.statusemoji`, `.statussave`, `.viewonce`, `.vv`, `.save`

**Owner (`.momenu`, aliases `.ownermenu`, `.omenu`)** works only for the linked account or `OWNER_NUMBER`. For everybody else `.momenu` is ignored silently and owner commands answer "owner only".
- News auto posting: `.newson [hiru derana itn]` (this chat), `.hiru on|off` / `.derana on|off` / `.itn on|off` (one channel, this chat), `.newsadd <group link | channel link | jid> [sources]`, `.newsoff`, `.newsdel <target>`, `.newslist`
- `.mode public|private`, `.broadcast <text>`, `.block` / `.unblock`, `.join <group link>`, `.leave`, `.setbio <text>`, `.setpp` (reply to an image), `.restart` (only `OWNER_NUMBER`, restarts every session)
- Calls: `.call`, `.callstream`, `.callreject`, `.autoanswer`, `.setcallaudio`, `.setcallvideo`, `.setcallmsg`, `.callpreview`, `.delcallmedia`

## Downloaders
- `.tt` / `.fb` show a preview with **Video / Audio / Document** buttons. TikTok uses the tikwm API first, then yt-dlp. Facebook uses yt-dlp.
- `.pin <pinterest or pin.it link>`: image pins are sent straight away (original size when possible), video pins show **Video / Document** buttons. It reads the public pin page and falls back to yt-dlp.
- `.song <name or link>`: YouTube audio / document / video. If YouTube blocks the server, add cookies (`YTDLP_COOKIES` or a Render secret file `cookies.txt`).
- Only public content works. Files over `MAX_DL_MB` are refused. Download only what you have the right to save.

## TikTok search (`.tts`)
`.tts funny cats` searches TikTok and answers with swipeable cards (picture, title, author, views). Each card has three buttons: **VIDEO** (sends the video), **AUDIO** (sends the sound) and **MORE** (the normal Video / Audio / Document menu). The same downloads work without buttons: `.ttdl <link>` and `.ttmp3 <link>`. Needs `BUTTONS=on`; otherwise the results come as a text list with the links.

Search providers are tried in this order until one returns videos: your `TIKTOK_SEARCH_URL`, **ScrapTik** (`TIKTOK_RAPIDAPI_KEY`), `tiktok-scraper20`, tikwm, a free public API, Bing. Free public search APIs change or die often and some block Render's IP, so for a dependable setup subscribe to ScrapTik on RapidAPI and set `TIKTOK_RAPIDAPI_KEY` in Render. If every provider fails, the Render logs show one line per provider with the reason (`TikTok search error: ...`).

## Sri Lanka news and auto posting
- `.news` shows the latest headlines of Hiru, Derana and ITN. `.hiru`, `.derana`, `.itn` show one channel.
- **Auto posting:** the bot checks the news sites every few minutes (`NEWS_POLL_MIN`) and posts every **new** story (picture, headline, short text, link) to the chats you added. Run `.newson` inside a group, or `.newsadd <group link / channel link / jid>` from anywhere. Owner only. Targets are saved with the other settings (MongoDB or `SESSION_DIR`).
- The first check after the first start only remembers the existing stories and posts nothing. At most 3 new stories per channel are posted per check, with a pause between chats, because bulk posting is what gets numbers restricted.
- For **WhatsApp channels** the linked number must be the channel owner or admin; for **groups** it must be a member.
- Facebook pages cannot be read without Facebook's API, so stories come from the news sites themselves. Derana uses its RSS feed, Hiru is read from its home page, ITN blocks servers and falls back to Google News (text and link, usually no picture). The Render logs show which source each channel uses (`News: hiru uses ...`).

## Emoji reactions and the DP card
Every command message gets an emoji reaction (🏓 ping, 🎵 tt, 📌 pin ...). Every text reply carries a link-preview style card with the bot's profile picture (falls back to `MENU_IMAGE`). `.setpp` refreshes it.

## Status tools and view-once recovery
All switches are **OFF** by default and are per linked account.
- `.statusseen on|off`: view every new status automatically.
- `.statusreact on|off`: react to fresh statuses (under 30 min old) with a random emoji from your list, after a short random pause. `.statusemoji 😍 🔥 ❤️` sets the list, `.statusemoji reset` restores the default.
- `.statussave on|off`: send every status (photo, video, voice, text) to your own chat with the sender's name. Statuses older than 6 hours are skipped.
- `.viewonce on|off`: send a copy of every view-once photo / video / voice note you receive to your own chat. `.vv` (reply to a view-once message) opens it in the current chat.
- `.save` (reply to a photo / video / voice note) sends it to your own chat. Do not reply to a **status** with `.save`: a reply to a status goes to the person who posted it. Use `.statussave on` for statuses.
- `.autostatus` shows all the switches.
Reacting to many statuses automatically can look like spam to WhatsApp, use it moderately.

## Calls
Owner only, per linked account. The owner's own number and `OWNER_NUMBER` are never rejected or answered, group calls are ignored.

**Reject / auto reply (works everywhere)**
- `.callreject on|off` rejects incoming calls and sends a message (`.setcallmsg <text>` changes it).
- `.autoanswer on|off` rejects the ringing call and sends your saved audio (voice call) or video (video call) to the caller as a message.
- Save the clips by replying to a voice note / video with `.setcallaudio` / `.setcallvideo` (max 15 MB). `.callpreview` plays them back, `.delcallmedia audio|video` removes one.

**Real answering (`.callstream`, Docker deploy only)**
`.callstream on` makes the bot pick up incoming calls and play your saved clip into the call: voice call → the audio clip, video call → the video clip (picture + its own sound). Afterwards it hangs up (`.callstream loop on` repeats until the caller hangs up).
- Baileys cannot answer calls, so a small Go service in `callbot/` (hypermeow, a whatsmeow fork, + [meowcaller](https://github.com/purpshell/meowcaller)) is started by the bot.
- First time: `.callstream on` sends an 8 character code. WhatsApp → *Linked devices → Link a device → Link with phone number instead* → type it. This links the call service as a second device on your number (WhatsApp allows up to 4). The bot confirms in the chat.
- Other commands: `.callstream status|off|unlink`, `.callstream loop on|off`.
- Clips are converted by ffmpeg: audio → 16 kHz mono, video → H.264 480 px wide, 15 fps, max 3 min.
- If the service is not installed or not linked, `.callreject` / `.autoanswer` still work.
- Local build: `cd callbot && go mod tidy && go build -o ../bin/callbot .` (Go 1.24+ and ffmpeg needed), then `npm start`. Tests: `cd callbot && go test ./...`.
- Limits: meowcaller is a young reverse-engineered library; its own docs mark outgoing video as not validated, so video may not show on every phone. WhatsApp can change its protocol at any time.

## Web settings page (`/settings`) and admin site (`/admin`)
**For every linked user**
- When a number is linked, the bot sends a 12 character password to that number's own chat, with the link to `/settings`.
- Log in with the number and password. You can switch on or off: public / private mode, status view / react / save, the reaction emojis, view-once copies, **auto read, "typing…" and "recording…" indicators, always online**, call reject, auto answer, call loop and the reject message. Real call answering can be turned off here, but turning it on needs `.callstream on` in WhatsApp (one-time device link).
- **Account** section: send yourself a new password (ends this login), reset all your options to the defaults, or unlink your number.
- `.webpass` (owner) sends a new password to your own chat. Numbers linked before this update have no password yet: send `.webpass` once.
- Only a salted hash of the password is stored. 5 wrong attempts block a number or an IP for 10 minutes. Logins are signed, `HttpOnly`, `SameSite=Strict` cookies that last 12 hours.

**For the host (`/admin`)**
- Set `ADMIN_PASSWORD` (10+ characters), optionally `ADMIN_USER`, and `WEB_SECRET`. Admin logins last 4 hours.
- Overview tiles: linked numbers, online now, new links open/paused, memory, uptime, storage, call service.
- **Control every session**: search and filter the list (all / online / offline), tick the numbers you want (or *Select online*), then use the **Control box**: change one option for all of them (any option from the settings page), restart, send new web passwords, send a message to each number's own chat, reset settings, or unlink and delete. Restart, passwords, messages and unlinking run in the background one number at a time (slow on purpose, so WhatsApp never sees a burst) with a live progress bar.
- **New links switch**: pause or reopen the pair page for everyone. Linked numbers keep working. The choice is saved with the other settings.
- Click one number to manage it alone: status, settings, restart, web password, message, reset, unlink.
- A log of recent admin actions (kept in memory, cleared on restart). Numbers are shown partly hidden.
- WhatsApp auth keys and session files are never shown.

## Troubleshooting
- **`MENU_IMAGE could not be downloaded ... timeout`**: some image hosts (catbox.moe) are unreachable from Render. The bot caches the picture, tries an image proxy as well, and falls back to the bundled picture. For a fix that needs no network, save your picture as `public/menu.jpg`.
- **Buttons not showing**: WhatsApp sometimes accepts button messages and never displays them. Check the Render logs for `Button send failed` and `Button tap:` lines.
- **`.tts` says "search failed"**: see the `TikTok search error:` line in the logs; it lists every provider and why it failed.

## What happens on restart
Paired sessions are restored automatically (from MongoDB or `SESSION_DIR`). Unpaired attempts expire after 5 minutes. Logged-out sessions are deleted.

## Security
- Pairing endpoints are rate limited and, with `PAIRING_REQUIRE_KEY=true`, need `PAIRING_API_KEY` (timing-safe check, placeholder key rejected).
- Session folders and the MongoDB `auth` collection hold WhatsApp auth keys: never share or publish them.
- The call service listens on `127.0.0.1` only and needs a secret that is generated on every start.
- Automated use of an account can get it restricted by WhatsApp. Use only with the account owner's consent.

## Call packs and outgoing calls (owner)
A pack is a named audio + video set. The bot can call a number and stream a pack into the call once they pick up.
- `.addpack <name>` (reply to an audio, then again to a video), `.packs`, `.delpack <name>`
- `.callto <number with country code> <pack> [voice|video]` e.g. `.callto 94771234567 pack1`
- Needs the call service linked once (`.callstream on`). One call per minute, hangs up if nobody answers in 45 s. Only call people who agree to it.
- Outgoing calls are compiled with `go build -tags dial`. `callbot/dial.go` contains the single meowcaller call (`StartCall`) that must match your meowcaller version; the Dockerfile falls back to a build without it if that does not compile (`.callto` then reports "not compiled in").
