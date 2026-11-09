// Secret admin link. With ADMIN_CODE set, the admin login page is only at  /admin/<ADMIN_CODE>.
// Plain /admin (or /admin/anything-else) just sends the visitor to the pair site, so nobody who guesses "/admin" sees a login page.
// Without ADMIN_CODE the old behaviour stays (/admin shows the login), so nobody is locked out after an update.
// This hides the page only: the admin password, the lockout and every /api/admin call stay protected as before.
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Letters, digits, "-" and "_", 6 to 64 characters. Anything else is ignored (reported through `problem`).
export function parseAdminCode(raw) {
  const code = String(raw || '').trim();
  if (!code) return { code: '', problem: '' };
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(code)) return { code: '', problem: 'ADMIN_CODE is ignored: use 6 to 64 letters, digits, "-" or "_".' };
  return { code, problem: '' };
}

// Express handler for  /admin  and  /admin/:code.  sendPage(res) sends views/admin.html.
export function adminPageHandler(code, sendPage, home = '/') {
  const want = code ? sha(code) : null;
  return (req, res) => {
    if (!want) return req.params?.code ? res.redirect(302, home) : sendPage(res); // no code set: old behaviour
    const given = req.params?.code;
    if (given && crypto.timingSafeEqual(sha(given), want)) return sendPage(res);
    return res.redirect(302, home);                                               // wrong / missing code: pair site, nothing else
  };
}
