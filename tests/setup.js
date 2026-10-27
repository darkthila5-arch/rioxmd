// Runs before every test file: use a throwaway session folder and never try to download yt-dlp.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rio-test-'));
process.env.YTDLP_PATH = process.env.YTDLP_PATH || (process.platform === 'win32' ? 'cmd' : '/bin/true');
