// .imdb <movie or series> [year]   (aliases .movie, .film)   Rating, plot and poster.
// Works with NO key: it uses Cinemeta (https://v3-cinemeta.strem.io, free). If the host sets OMDB_API_KEY
// (free key from https://www.omdbapi.com/apikey.aspx) OMDb is tried first and Cinemeta is the backup.
import { PREFIX } from '../lib/config.js';

const TIMEOUT_MS = 12000;
const COOLDOWN_MS = 5000;
const CINEMETA = 'https://v3-cinemeta.strem.io';
const lastUse = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of lastUse) if (t - v > 60e3) lastUse.delete(k); }, 5 * 60e3).unref();

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const clean = (v) => { const s = String(v ?? '').trim(); return s && s !== 'N/A' ? s : ''; };
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => clean(x)).filter(Boolean);
const okPoster = (u) => (/^https:\/\//i.test(clean(u)) ? clean(u) : '');
const okId = (id) => (/^tt\d{5,10}$/.test(String(id || '')) ? String(id) : '');

// "inception 2010" -> { title: 'inception', year: '2010' }
export function parseQuery(args) {
  let title = (Array.isArray(args) ? args.join(' ') : String(args || '')).replace(/\s+/g, ' ').trim().slice(0, 80);
  let year = '';
  const m = title.match(/^(.*\S)\s+\(?((?:19|20)\d{2})\)?$/);
  if (m) { title = m[1]; year = m[2]; }
  return { title, year };
}

// Both sources are turned into the same shape, so one formatter is enough.
export function fromOmdb(d) {
  if (!d || d.Response === 'False' || !okId(d.imdbID)) return null;
  return {
    id: d.imdbID, title: clean(d.Title), year: clean(d.Year), type: clean(d.Type), rated: clean(d.Rated), runtime: clean(d.Runtime),
    genres: list(d.Genre), director: clean(d.Director), cast: list(d.Actors), plot: clean(d.Plot), awards: clean(d.Awards),
    rating: clean(d.imdbRating), votes: clean(d.imdbVotes), poster: okPoster(d.Poster)
  };
}
export function fromCinemeta(m) {
  const id = okId(m?.imdb_id || m?.id);
  if (!id) return null;
  return {
    id, title: clean(m.name), year: clean(m.releaseInfo || m.year), type: clean(m.type), rated: '', runtime: clean(m.runtime),
    genres: list(m.genres), director: list(m.director).join(', '), cast: list(m.cast), plot: clean(m.description), awards: clean(m.awards),
    rating: clean(m.imdbRating), votes: '', poster: okPoster(m.poster)
  };
}

async function viaOmdb(key, { title, year }) {
  const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&t=${encodeURIComponent(title)}&plot=short${year ? `&y=${year}` : ''}`;
  return fromOmdb(await getJson(url));
}

async function viaCinemeta({ title, year }) {
  const q = encodeURIComponent(title);
  const [movies, series] = await Promise.all(['movie', 'series'].map((t) => getJson(`${CINEMETA}/catalog/${t}/top/search=${q}.json`).then((j) => j?.metas || []).catch(() => [])));
  const all = [...movies, ...series];
  const hit = (year && all.find((m) => String(m.releaseInfo || m.year || '').startsWith(year))) || all[0];
  const id = okId(hit?.imdb_id || hit?.id);
  if (!id) return null;
  const type = hit.type === 'series' ? 'series' : 'movie';
  try { // the detail page has the plot, cast and runtime; the search row alone is still good enough if it fails
    const detail = (await getJson(`${CINEMETA}/meta/${type}/${id}.json`))?.meta;
    if (detail) return fromCinemeta({ ...hit, ...detail, type });
  } catch { /* use the search row */ }
  return fromCinemeta({ ...hit, type });
}

export async function lookupTitle(query) {
  const key = (process.env.OMDB_API_KEY || '').trim();
  if (key) {
    try { const r = await viaOmdb(key, query); if (r) return r; }
    catch (err) { console.error('imdb OMDb error, trying Cinemeta:', err?.message || err); }
  }
  return viaCinemeta(query);
}

// Pure formatter (tested without network).
export function imdbText(t) {
  const kind = t.type === 'series' ? '📺 Series' : '🎬 Movie';
  const rating = t.rating ? `⭐ *${t.rating}/10*${t.votes ? ` (${t.votes} votes)` : ''}` : '⭐ No rating yet';
  const plot = t.plot.length > 600 ? `${t.plot.slice(0, 597).trimEnd()}...` : t.plot;
  const lines = [`🎬 *${t.title}*${t.year ? ` (${t.year})` : ''}`, '', rating, `${kind}${t.rated ? ` • ${t.rated}` : ''}${t.runtime ? ` • ⏱️ ${t.runtime}` : ''}`];
  if (t.genres.length) lines.push(`🎭 ${t.genres.slice(0, 4).join(', ')}`);
  if (t.director) lines.push(`🎥 Director: ${t.director}`);
  if (t.cast.length) lines.push(`👥 Cast: ${t.cast.slice(0, 4).join(', ')}`);
  if (t.awards) lines.push(`🏆 ${t.awards}`);
  if (plot) lines.push('', `📝 ${plot}`);
  lines.push('', `🔗 https://www.imdb.com/title/${t.id}/`);
  return lines.join('\n');
}

export default [
  {
    name: 'imdb', aliases: ['movie', 'film'], react: '🎬',
    async run({ args, reply, sock, jid, msg, sessionId }) {
      const query = parseQuery(args);
      if (!query.title) return reply(`🎬 *IMDb*\n\nUsage: ${PREFIX}imdb <movie or series> [year]\nExample: ${PREFIX}imdb Inception\nExample: ${PREFIX}imdb Dune 2021`);
      const key = `${sessionId}:${jid}`;
      if (Date.now() - (lastUse.get(key) || 0) < COOLDOWN_MS) return reply('⏳ Wait a few seconds and try again.');
      lastUse.set(key, Date.now());
      try {
        const found = await lookupTitle(query);
        if (!found || !found.title) return reply(`❌ I could not find *${query.title}*. Check the spelling, or add the year, for example ${PREFIX}imdb Dune 2021`);
        const caption = imdbText(found);
        if (found.poster) {
          try { return await sock.sendMessage(jid, { image: { url: found.poster }, caption }, { quoted: msg }); }
          catch (err) { console.error('imdb poster failed, sending text:', err?.message || err); }
        }
        return reply(caption);
      } catch (err) {
        console.error('imdb error:', err?.message || err);
        return reply('❌ Could not get the movie details right now. Try again in a minute.');
      }
    }
  }
];
