# RIO X MD

Multi-session WhatsApp bot (Baileys) with a modern pairing website (pair code or QR), downloaders, owner tools, status tools and real call answering (Go service).

> Baileys is an unofficial WhatsApp client and may break when WhatsApp changes. Use it only with your own account.

## Features
| Area | What it does |
|---|---|
| Pairing site | Link your own number with a pair code or QR. Live "online" counter. |
| `.pair` command | Anyone can send `.pair 94771234567` (or just `.pair` in a private chat) and the bot answers with a pair code and a **Copy Code** button, so they can link their own number as a bot. Rate limited, respects "new links paused" and `MAX_SESSIONS`. Can be switched off in `/admin` → Commands. |
| Menu | `.menu` image + buttons, `.alive`, emoji reaction on every command, bot DP link-preview card on every reply. |
| Downloaders | TikTok, Facebook, Pinterest, YouTube song / video. |
| TikTok search | `.tts <words>` shows results as swipeable cards with **VIDEO / AUDIO / MORE** buttons. |
| Sri Lanka news | `.news`, `.hiru`, `.derana`, `.itn` and **auto posting** of new headlines to the groups and channels you add. |
| Status tools | Auto view, auto react (your own emojis), auto save, view-once recovery. |
| Owner tools | public / private mode, broadcast, block, join, leave, bio, profile picture, restart. |
| Web settings | After linking, the bot sends a password to your own chat. Log in at `/settings` with your number to switch features on or off. |
| Admin site | `/admin` controls all sessions: search, tick many numbers and change an option, restart, send passwords or messages, reset or unlink them in one go. It can also pause new links. |
| Admin: Broadcast | `/admin` → Broadcast. Send a message to every linked number's own chat (all or only online) **now or at a chosen time**. Scheduled messages are saved, can be cancelled, and are sent one number at a time. A message more than 10 minutes late after a restart is marked *Missed* instead of being sent. |
| Admin: Logs | Live server log (refreshes every 3 s) with search, level filter (warnings / errors), pause and download. Phone numbers, passwords, API keys and database links are hidden. Memory only. |
| Admin: Audit | Every admin action with the IP it came from, saved for restarts (last 1000), searchable, CSV download. |
| Admin: Security | Admin login lockout per IP (5 wrong passwords: 10 min, then 30 min, 2 h, 6 h, 24 h), login history (IP, browser, result), list of locked IPs with **Unblock**, trusted IPs. If an attack comes from many IPs, unknown IPs are slowed down while IPs that logged in before keep working. |
| Admin: Backup | Export every linked number (WhatsApp login data + settings) as **one encrypted `.riobak` file** (AES-256-GCM, passphrase 8+ chars). Import adds numbers that are not linked yet; running numbers are never overwritten. Same storage type needed (files or MongoDB). |
| Premium branding | Numbers with active premium can set their own **bot name, footer text and logo picture** on the `/settings` page (Branding card). It is used in every reply, menu and link card of that number only. Free numbers see the card locked; when premium ends the defaults return (saved values are kept). Logo = direct https link to a JPG/PNG/WEBP (max 3 MB), checked and downloaded server-side. |
| Admin channels (auto react) | `/admin` → **Channels**. The host adds a WhatsApp channel and the numbers follow it and **react to every new post automatically** (live, a few seconds after the post, each number after its own random pause; a backup check runs every minute). Choose **all online numbers** or only the numbers that opted in, set the emojis, and switch auto react on or off per channel. **React to one post**: paste a post link (`https://whatsapp.com/channel/0029Va.../123`) and the numbers react to it one by one. A **Check** button shows exactly what WhatsApp answers for a channel (can it read posts, live updates, errors). |
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
| `LOG_DECRYPT` | `true` shows the encryption messages (`Bad MAC`, `Failed to decrypt`, `Closing session`) that are hidden by default. Use it when contacts see "Waiting for this message". |
| `DEFAULT_COUNTRY_CODE` | Used by `.pair` for numbers typed like `0771234567` (default `94`). |
| `BOOST_POLL_MIN` | Minutes between the backup check for new channel posts (default 1). |
| `BOOST_LIVE_MIN_S`, `BOOST_LIVE_MAX_S` | Random pause (seconds) before each number reacts to a live post (default 3 and 20). Raise the max (for example 60) when many numbers are linked. |
| `BOOST_GAP_MS`, `BOOST_MAX_ACTIONS`, `BOOST_DISABLED` | Pause between follow / react actions, actions per check, and `true` to switch the whole channel feature off. |

## Who can use what
- **Host owner** = `OWNER_NUMBER` / `OWNER_LID`. Only the host owner can use `.momenu` and the commands in it: `.restart`, all AUTO NEWS commands, DOWNLOAD TOOLS (`.ytcheck`, `.dlcheck`) and all CALL commands except `.callreject` (`.call`, `.callstream`, `.autoanswer`, `.setcallaudio`, `.setcallvideo`, `.setcallmsg`, `.callpreview`, `.delcallmedia`, packs, `.callto`). Real call answering and auto answer only run on the host owner's own number. The same options are locked on the `/settings` page for every other number.
- **Session owner** = whoever linked a number. Their commands are listed in `.menu` under **OWNER COMMANDS** (`.mode`, `.callreject`, `.broadcast`, `.forward`, `.block`, `.join`, `.leave`, `.setbio`, `.setpp`, `.webpass`, `.premium`, channel songs). They work only on the linked number itself.
- Everybody else gets an "owner only" reply.

## Commands
Send `menu` or `help` without the prefix and it works too.

**Public (`.menu`)**
- General: `.alive`, `.ping`, `.runtime`, `.about`, `.owner`, `.status`, `.pair <your number>`
- Download: `.tt <link>`, `.fb <link>`, `.pin <link>`, `.song <name or link>`, `.tts <search words>` (TikTok search), `.ttdl <link>` / `.ttmp3 <link>` (TikTok video / sound straight away)
- News: `.news [hiru|derana|itn]`, `.hiru`, `.derana`, `.itn`
- Channel songs (owner): `.csong <channel link | jid> <song name>` posts the thumbnail + details and then the song as a **voice note** to a WhatsApp channel (or group). Without a channel it posts in the current chat. Needs ffmpeg (included in the Docker image) and, if YouTube shows a bot check, YouTube cookies (`YTDLP_COOKIES`).
- Media / stickers: `.tosticker` (photo → sticker), `.toasticker` (video / GIF → animated sticker), `.toimg` (sticker → photo), `.tovideo` (animated sticker → video), `.sticker` / `.media` (help). Reply to the media or send it with the command as the caption. Stickers carry the bot name as pack name and the footer as publisher (a premium number's own brand is used instead). Needs ffmpeg (in the Docker image). `.tovideo` uses `anim_dump` from the `webp` package when it is installed (also in the Docker image) and has a built-in fallback when it is not. `MAX_STICKER_JOBS` (default 2) limits how many conversions run at once.
- Full DP (owner): `.fulldp` (reply to a picture, or send it with `.fulldp` as the caption) sets the profile picture **exactly as it is**: same size, no resize, no crop, no blur, no background layer (`.setpp` shrinks it to a 720x720 square). Newer WhatsApp versions show the DP in its original width and height when it is opened; only the round thumbnail is square. Send the picture as a *File / Document* so WhatsApp does not compress it first.
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
- `.viewonce on|off`: send a copy of every view-once photo / video / voice note you receive to your own chat. `.vv` (reply to a view-once message) saves it to your own chat, see *Silent vv* below.
- **Silent vv:** reply to a view-once photo / video / voice note with `vv` (or `.vv`) or with one of your vv emojis (default 😂 or 👀, change with `.vvemoji 😍 🔥`, `.vvemoji reset`). The file is sent to your **own chat** with the details (type, who sent it, chat or group name, time, caption). Nothing is answered, reacted or sent in the chat where you replied. Only your own messages count; an emoji reply to a normal (not view-once) photo does nothing.
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
- Log in with the number and password. You can switch on or off: public / private mode, status view / react / save, the reaction emojis, view-once copies, **auto read, "typing…" and "recording…" indicators, always online**, call reject. The call-answering options (auto answer, answer calls, repeat clip, reject message) are **hidden for normal numbers** and shown only on the host owner's own number (`OWNER_NUMBER`). Real call answering needs `.callstream on` in WhatsApp (one-time device link).
- **Account** section: send yourself a new password (ends this login), reset all your options to the defaults, or unlink your number.
- `.webpass` (owner) sends a new password to your own chat. Numbers linked before this update have no password yet: send `.webpass` once.
- Only a salted hash of the password is stored. 5 wrong attempts block a number or an IP for 10 minutes. Logins are signed, `HttpOnly`, `SameSite=Strict` cookies that last 12 hours.

**For the host (`/admin`)**
- Set `ADMIN_PASSWORD` (10+ characters), optionally `ADMIN_USER`, and `WEB_SECRET`. Admin logins last 4 hours.
- Overview tiles: linked numbers, online now, new links open/paused, memory, uptime, storage, call service.
- **Control every session**: search and filter the list (all / online / offline), tick the numbers you want (or *Select online*), then use the **Control box**: change one option for all of them (any option from the settings page), restart, send new web passwords, send a message to each number's own chat, reset settings, or unlink and delete. Restart, passwords, messages and unlinking run in the background one number at a time (slow on purpose, so WhatsApp never sees a burst) with a live progress bar.
- **Commands tab**: every command can be switched on or off for all numbers. Commands are **grouped in the same categories as the menu** (General, Download, News, Media, Group, Fun, Status, Owner, Download tools, Auto news, Call, Host owner), each group has **All on / All off**. New commands appear automatically (listed under *Other* until you add them to `CMD_CATS` in `lib/web.js`).
- **Command access** (Commands tab, every row): choose **who can use a command** (Everyone / Number owner / Host admin) and switch **👑 Premium** on or off for it. With Premium on, only numbers the admin gave premium days can use the command (the host admin always can), for example make `.chsong` premium. A command can only be made *stricter* than its built-in level (an owner command can never become public). Changed rows are marked *Custom*; setting a row back to its built-in values clears it.
- **Channels tab**: add a channel for auto react, react to one post by link, per-channel auto react switch, **Check** diagnostics, remove a channel. See *Admin channels* below.
- **New links switch**: pause or reopen the pair page for everyone. Linked numbers keep working. The choice is saved with the other settings.
- Click one number to manage it alone: status, settings, restart, web password, message, reset, unlink.
- A log of recent admin actions (kept in memory, cleared on restart). Numbers are shown partly hidden.
- WhatsApp auth keys and session files are never shown.

## Admin channels (auto react) and `.pair`
**Admin channels** (`/admin` → Channels)
1. Paste the channel link, optionally the emojis, choose who joins (*All online numbers* or *Only numbers that switched on "Support other channels"*) and keep **React to every new post automatically** on. The numbers follow the channel within a minute.
2. Every new post is reacted to live: WhatsApp pushes the post to each following number and that number reacts after a random 3 to 20 seconds. A backup check every minute catches posts the live push missed. A post is reacted to once per number. Posts that existed before the channel was added are not reacted to.
3. **React to one post**: paste a post link, pick the numbers, press *React now*. Numbers react one by one with a pause between them; progress is shown under the button. *Follow the channel first* makes numbers that do not follow it yet follow it.
4. The switch on each channel turns auto react off (the numbers only follow) and on again (starts from the newest post). **Check** shows what the server sees: whether posts can be read, live updates, number of followers, last error. If auto react does not work, press Check and read the output, the Render logs also show `Boost: reading posts ... works`, `Boost: live post ... received` or `Boost: could not read posts ...`.
5. The Overview *Channel support* switch pauses everything (follow, unfollow, react).
Using *All online numbers* acts on accounts without their owners switching anything on, and following / reacting a lot can get accounts limited by WhatsApp. Keep the number of numbers and channels small.

**`.pair`**: `.pair 94771234567` sends a pair code with a Copy Code button; in a private chat `.pair` alone uses the chat partner's number. Limits: one request per minute and 5 per hour per chat, the same number at most once per 2 minutes. After linking, the new bot greets the user and sends the web password as usual. Switch it off in `/admin` → Commands if you do not want public pairing through WhatsApp.

## Troubleshooting
- **"Waiting for this message" on the bot's replies or in your own chat**: the bot answers WhatsApp's re-send requests (it keeps what it sent for 2 hours) and, for messages to the owner's own chat, refreshes the encryption sessions with the owner's phone / PC after every connect and at most every 20 minutes (`Self sessions refreshed` in the logs). Reply cards use a small 300x300 thumbnail. Make sure the same number is never running in two places at once (two Render services, or a copy on your PC), that breaks the encryption. Set `LOG_DECRYPT=true` to see decrypt errors.
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
