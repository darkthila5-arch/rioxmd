import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const imdb = await import('../commands/imdb.js');
const cmd = imdb.default[0];

const realFetch = globalThis.fetch;
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.OMDB_API_KEY; });

let n = 0;
function ctx(args = [], sendMessage) {
  const out = [];
  const sent = [];
  return { out, sent, c: {
    args, sessionId: `i${++n}`.padEnd(24, 'i'), jid: 'x@s.whatsapp.net', msg: { key: { id: 'M' } },
    sock: { sendMessage: sendMessage || (async (_j, content, opts) => { sent.push({ content, opts }); }) },
    reply: async (t) => { out.push(t); }
  } };
}

const HIT = { id: 'tt1375666', imdb_id: 'tt1375666', type: 'movie', name: 'Inception', releaseInfo: '2010', poster: 'https://images.metahub.space/poster/inception.jpg', imdbRating: '8.8' };
const DETAIL = { ...HIT, description: 'A thief who steals secrets through dreams is given a final job.', genres: ['Action', 'Sci-Fi'], runtime: '148 min', director: ['Christopher Nolan'], cast: ['Leonardo DiCaprio', 'Elliot Page'], awards: 'Won 4 Oscars' };
const cinemeta = (movies = [HIT], series = []) => async (u) => {
  if (u.includes('/catalog/movie/')) return jsonRes({ metas: movies });
  if (u.includes('/catalog/series/')) return jsonRes({ metas: series });
  if (u.includes('/meta/')) {
    const id = u.match(/(tt\d+)\.json/)?.[1];
    const row = [...movies, ...series].find((m) => m.id === id);
    return jsonRes({ meta: { ...DETAIL, ...row } });
  }
  throw new Error(`unexpected url ${u}`);
};

test('imdb: parseQuery splits a trailing year', () => {
  assert.deepEqual(imdb.parseQuery(['Dune', '2021']), { title: 'Dune', year: '2021' });
  assert.deepEqual(imdb.parseQuery(['Dune', '(2021)']), { title: 'Dune', year: '2021' });
  assert.deepEqual(imdb.parseQuery(['2012']), { title: '2012', year: '' }); // a title that is only a number stays a title
  assert.deepEqual(imdb.parseQuery(['The', 'Matrix']), { title: 'The Matrix', year: '' });
});
test('imdb: no argument shows usage without any network call', async () => {
  globalThis.fetch = () => { throw new Error('no network expected'); };
  const { c, out } = ctx([]);
  await cmd.run(c);
  assert.match(out[0], /Usage/);
});
test('imdb: sends the poster with a caption (Cinemeta, no key)', async () => {
  globalThis.fetch = cinemeta();
  const { c, sent, out } = ctx(['inception']);
  await cmd.run(c);
  assert.equal(out.length, 0);
  assert.equal(sent[0].content.image.url, HIT.poster);
  const cap = sent[0].content.caption;
  assert.match(cap, /Inception.*2010/);
  assert.match(cap, /8\.8\/10/);
  assert.match(cap, /148 min/);
  assert.match(cap, /Christopher Nolan/);
  assert.match(cap, /imdb\.com\/title\/tt1375666\//);
});
test('imdb: falls back to a text reply when the poster cannot be sent', async () => {
  globalThis.fetch = cinemeta();
  const { c, out } = ctx(['inception'], async () => { throw new Error('upload failed'); });
  await cmd.run(c);
  assert.match(out[0], /Inception/);
});
test('imdb: finds a series when there is no movie, and prefers the asked year', async () => {
  const show = { ...HIT, id: 'tt0903747', imdb_id: 'tt0903747', type: 'series', name: 'Breaking Bad', releaseInfo: '2008–2013' };
  globalThis.fetch = cinemeta([], [show]);
  const found = await imdb.lookupTitle({ title: 'breaking bad', year: '' });
  assert.equal(found.id, 'tt0903747');
  const old = { ...HIT, id: 'tt0000001', imdb_id: 'tt0000001', releaseInfo: '1990' };
  globalThis.fetch = cinemeta([old, HIT]);
  assert.equal((await imdb.lookupTitle({ title: 'x', year: '2010' })).id, 'tt1375666');
});
test('imdb: unknown title and network error give friendly messages', async () => {
  globalThis.fetch = cinemeta([], []);
  let r = ctx(['zzzzqqqq']); await cmd.run(r.c);
  assert.match(r.out[0], /could not find/i);
  globalThis.fetch = async () => { throw new Error('boom'); };
  r = ctx(['inception']); await cmd.run(r.c);
  assert.ok(r.out[0]); // either "not found" (Cinemeta swallowed the error) or the friendly error, never a crash
});
test('imdb: uses OMDb first when OMDB_API_KEY is set, and ignores N/A values', async () => {
  process.env.OMDB_API_KEY = 'k3y';
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return jsonRes({ Response: 'True', Title: 'Inception', Year: '2010', Type: 'movie', Rated: 'PG-13', Runtime: '148 min', Genre: 'Action, Sci-Fi', Director: 'Christopher Nolan', Actors: 'Leonardo DiCaprio, Elliot Page', Plot: 'Dreams.', Awards: 'N/A', Poster: 'N/A', imdbRating: '8.8', imdbVotes: '2,700,000', imdbID: 'tt1375666' }); };
  const { c, out, sent } = ctx(['Inception', '2010']);
  await cmd.run(c);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /omdbapi\.com.*apikey=k3y.*t=Inception.*y=2010/);
  assert.equal(sent.length, 0); // poster is N/A -> plain text
  assert.match(out[0], /PG-13/);
  assert.match(out[0], /2,700,000 votes/);
  assert.doesNotMatch(out[0], /N\/A|🏆/);
});
test('imdb: a bad OMDb answer falls back to Cinemeta', async () => {
  process.env.OMDB_API_KEY = 'k3y';
  globalThis.fetch = async (u) => (u.includes('omdbapi') ? jsonRes({ Response: 'False', Error: 'Invalid API key!' }) : cinemeta()(u));
  assert.equal((await imdb.lookupTitle({ title: 'inception', year: '' })).id, 'tt1375666');
});
test('imdb: a long plot is shortened and non-https posters / bad ids are dropped', () => {
  const t = imdb.fromCinemeta({ imdb_id: 'tt1234567', name: 'X', description: 'a'.repeat(900), poster: 'http://insecure/p.jpg' });
  assert.equal(t.poster, '');
  assert.ok(imdb.imdbText(t).length < 900);
  assert.equal(imdb.fromCinemeta({ imdb_id: 'kitsu:1', name: 'X' }), null);
});
