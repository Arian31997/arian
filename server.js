'use strict';
require('dotenv').config();
const path = require('path'), crypto = require('crypto');
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || '';
const SERVER_KEY = process.env.SERVER_KEY || '';
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'demo';
if (JWT_SECRET.length < 32) { console.error('JWT_SECRET در فایل .env باید حداقل ۳۲ کاراکتر باشد'); process.exit(1); }

/* ---------- Database ---------- */
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'velora.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  mobile TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  sub_id TEXT, sub_exp INTEGER DEFAULT 0,
  avatar TEXT DEFAULT '', discord TEXT DEFAULT '', steam TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT, body TEXT, created INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS apps(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT, body TEXT, created INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan TEXT, amount INTEGER, created INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY, name TEXT, max INTEGER, players INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS queue(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, pri INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(user_id, server_id));
`);
const seed = db.prepare('INSERT OR IGNORE INTO servers(id,name,max,players) VALUES(?,?,?,0)');
seed.run('wl', 'سرور اصلی', 120); seed.run('dev', 'سرور آزمایشی', 32);

const PLANS = {
  silver: { n: 'نقره‌ای', p: 150000, l: 1 },
  gold: { n: 'طلایی', p: 300000, l: 2 },
  plat: { n: 'پلاتینیوم', p: 500000, l: 3 }
};
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12);

/* ---------- Helpers ---------- */
const FA = '۰۱۲۳۴۵۶۷۸۹';
const normDigits = s => String(s).replace(/[۰-۹]/g, d => FA.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const str = v => (typeof v === 'string' ? v.trim() : '');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const level = u => (u.sub_id && u.sub_exp > Date.now() && PLANS[u.sub_id] ? PLANS[u.sub_id].l : 0);

function pub(u) {
  const active = u.sub_id && u.sub_exp > Date.now() && PLANS[u.sub_id];
  const list = t => db.prepare(`SELECT title t, body b, created d, status s FROM ${t} WHERE user_id=? ORDER BY id`).all(u.id);
  return {
    u: u.username, m: u.mobile, e: u.email, cr: u.created,
    sub: active ? { id: u.sub_id, n: PLANS[u.sub_id].n, l: PLANS[u.sub_id].l, exp: u.sub_exp } : null,
    av: u.avatar || '', dc: u.discord || '', sm: u.steam || '',
    tk: list('tickets'), ap: list('apps')
  };
}
const fresh = id => pub(db.prepare('SELECT * FROM users WHERE id=?').get(id));

function setSession(res, id) {
  res.cookie('vl_token', jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' }), {
    httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5
  });
}
function readUser(req) {
  const t = req.cookies.vl_token;
  if (!t) return null;
  try { return db.prepare('SELECT * FROM users WHERE id=?').get(jwt.verify(t, JWT_SECRET).id) || null; } catch (e) { return null; }
}
function auth(req, res, next) {
  const u = readUser(req);
  if (!u) { res.clearCookie('vl_token'); return bad(res, 'ابتدا وارد حساب شوید', 401); }
  req.user = u; next();
}
function queueView(userId) {
  const out = {};
  for (const s of db.prepare('SELECT id FROM servers').all()) {
    const rows = db.prepare('SELECT user_id, pri FROM queue WHERE server_id=? ORDER BY pri DESC, created ASC, rowid ASC').all(s.id);
    const i = rows.findIndex(r => r.user_id === userId);
    if (i >= 0) out[s.id] = { p: rows[i].pri, pos: i + 1 };
  }
  return out;
}
function keyOk(req) {
  const k = Buffer.from(req.get('x-server-key') || ''), s = Buffer.from(SERVER_KEY);
  return s.length > 0 && k.length === s.length && crypto.timingSafeEqual(k, s);
}

/* ---------- App ---------- */
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      frameSrc: ['https://www.aparat.com'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '900kb' }));
app.use(cookieParser());
// جلوگیری از CSRF: درخواست‌های تغییردهنده فقط از همین دامنه
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const o = req.get('origin');
  if (o) { try { if (new URL(o).host !== req.get('host')) return bad(res, 'درخواست نامعتبر', 403); } catch (e) { return bad(res, 'درخواست نامعتبر', 403); } }
  next();
});
const apiLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'درخواست‌های زیاد؛ کمی بعد دوباره امتحان کنید' } });
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'تلاش‌های زیاد؛ ۱۵ دقیقه دیگر دوباره امتحان کنید' } });
app.use('/api', apiLimit);

/* ---------- Auth ---------- */
app.post('/api/register', authLimit, wrap(async (req, res) => {
  const U = str(req.body.u), M = normDigits(str(req.body.m)), E = str(req.body.e).toLowerCase(), P = typeof req.body.p === 'string' ? req.body.p : '';
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(U)) return bad(res, 'نام کاربری ۳ تا ۲۰ حرف و فقط انگلیسی، عدد، - و _ باشد');
  if (!/^09\d{9}$/.test(M)) return bad(res, 'شماره موبایل معتبر نیست (مثل 09123456789)');
  if (E.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(E)) return bad(res, 'ایمیل معتبر نیست');
  if (P.length < 8 || P.length > 72) return bad(res, 'رمز باید بین ۸ تا ۷۲ کاراکتر باشد');
  const dup = db.prepare('SELECT username, email, mobile FROM users WHERE username=? OR email=? OR mobile=?').get(U, E, M);
  if (dup) {
    if (dup.username.toLowerCase() === U.toLowerCase()) return bad(res, 'این نام کاربری قبلاً گرفته شده', 409);
    if (dup.email.toLowerCase() === E) return bad(res, 'این ایمیل قبلاً ثبت شده', 409);
    return bad(res, 'این شماره قبلاً ثبت شده', 409);
  }
  const hash = await bcrypt.hash(P, 12);
  try {
    const r = db.prepare('INSERT INTO users(username,mobile,email,pass_hash,created) VALUES(?,?,?,?,?)').run(U, M, E, hash, Date.now());
    setSession(res, r.lastInsertRowid);
    res.status(201).json({ user: fresh(r.lastInsertRowid) });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return bad(res, 'این اطلاعات قبلاً ثبت شده', 409);
    throw e;
  }
}));

app.post('/api/login', authLimit, wrap(async (req, res) => {
  const U = str(req.body.u).toLowerCase(), P = typeof req.body.p === 'string' ? req.body.p : '';
  if (!U || !P) return bad(res, 'همه فیلدها را پر کنید');
  const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(U, U);
  const ok = await bcrypt.compare(P, u ? u.pass_hash : DUMMY_HASH); // زمان پاسخ برای حساب ناموجود هم یکسان است
  if (!u || !ok) return bad(res, 'نام کاربری یا رمز اشتباه است', 401);
  setSession(res, u.id);
  res.json({ user: pub(u) });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('vl_token'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { const u = readUser(req); u ? res.json({ user: pub(u) }) : bad(res, 'وارد نشده‌اید', 401); });

/* ---------- Shop ---------- */
app.post('/api/shop/buy', auth, (req, res) => {
  const plan = PLANS[req.body.id];
  if (!plan) return bad(res, 'اشتراک نامعتبر است');
  if (PAYMENT_MODE !== 'demo') return bad(res, 'درگاه پرداخت هنوز متصل نشده است', 501);
  // برای درگاه واقعی: اینجا سفارش pending بسازید، کاربر را به درگاه بفرستید و فقط پس از verify موفق، اشتراک را فعال کنید.
  const u = req.user, id = req.body.id;
  const base = u.sub_id === id && u.sub_exp > Date.now() ? u.sub_exp : Date.now();
  const exp = base + 30 * 864e5;
  db.transaction(() => {
    db.prepare('INSERT INTO orders(user_id,plan,amount,created,status) VALUES(?,?,?,?,?)').run(u.id, id, plan.p, Date.now(), 'demo-paid');
    db.prepare('UPDATE users SET sub_id=?, sub_exp=? WHERE id=?').run(id, exp, u.id);
  })();
  res.json({ user: fresh(u.id) });
});

/* ---------- Tickets / Applications ---------- */
app.post('/api/tickets', auth, (req, res) => {
  const t = str(req.body.t), b = str(req.body.b);
  if (!t || !b) return bad(res, 'همه فیلدها را پر کنید');
  if (t.length > 60 || b.length > 500) return bad(res, 'متن بیش از حد طولانی است');
  db.prepare('INSERT INTO tickets(user_id,title,body,created,status) VALUES(?,?,?,?,?)').run(req.user.id, t, b, Date.now(), 'ارسال شد');
  res.status(201).json({ ok: true });
});
app.post('/api/apps', auth, (req, res) => {
  const t = str(req.body.t), b = str(req.body.b);
  if (!t || !b) return bad(res, 'همه فیلدها را پر کنید');
  if (t.length > 40 || b.length > 1500) return bad(res, 'متن بیش از حد طولانی است');
  if (b.length < 50) return bad(res, 'بک‌استوری حداقل ۵۰ حرف باشد');
  if (db.prepare("SELECT 1 FROM apps WHERE user_id=? AND status='در انتظار بررسی'").get(req.user.id)) return bad(res, 'یک درخواست در انتظار بررسی دارید', 409);
  db.prepare('INSERT INTO apps(user_id,title,body,created,status) VALUES(?,?,?,?,?)').run(req.user.id, t, b, Date.now(), 'در انتظار بررسی');
  res.status(201).json({ ok: true });
});

/* ---------- Profile ---------- */
const LINKS = { dc: 'discord', sm: 'steam' };
app.post('/api/link/:k', auth, (req, res) => {
  const col = LINKS[req.params.k], v = str(req.body.v);
  if (!col) return bad(res, 'نوع لینک نامعتبر است', 404);
  if (!/^[\w .#@-]{2,40}$/.test(v)) return bad(res, 'شناسه نامعتبر است (فقط حروف انگلیسی، عدد و . _ - # @)');
  db.prepare(`UPDATE users SET ${col}=? WHERE id=?`).run(v, req.user.id);
  res.json({ user: fresh(req.user.id) });
});
app.delete('/api/link/:k', auth, (req, res) => {
  const col = LINKS[req.params.k];
  if (!col) return bad(res, 'نوع لینک نامعتبر است', 404);
  db.prepare(`UPDATE users SET ${col}='' WHERE id=?`).run(req.user.id);
  res.json({ user: fresh(req.user.id) });
});
app.post('/api/avatar', auth, (req, res) => {
  const img = typeof req.body.img === 'string' ? req.body.img : '';
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(img);
  if (!m) return bad(res, 'فقط عکس PNG، JPG یا WEBP مجاز است');
  const bytes = Math.floor(m[2].length * 3 / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  if (bytes > 500 * 1024) return bad(res, 'حجم عکس بیشتر از ۵۰۰ کیلوبایت است');
  db.prepare('UPDATE users SET avatar=? WHERE id=?').run(img, req.user.id);
  res.json({ user: fresh(req.user.id) });
});

/* ---------- Servers & queue ---------- */
app.get('/api/servers', (req, res) => {
  const u = readUser(req);
  const servers = db.prepare('SELECT id, name n, players c, max m FROM servers ORDER BY rowid').all();
  res.json({ servers, queue: u ? queueView(u.id) : {} });
});
app.post('/api/queue/:id', auth, (req, res) => {
  const s = db.prepare('SELECT id FROM servers WHERE id=?').get(req.params.id);
  if (!s) return bad(res, 'سرور پیدا نشد', 404);
  const p = Number.isInteger(req.body.p) ? req.body.p : 0;
  if (p < 0 || p > level(req.user)) return bad(res, 'برای این اولویت اشتراک لازم است', 403);
  db.prepare('INSERT OR IGNORE INTO queue(user_id,server_id,pri,created) VALUES(?,?,?,?)').run(req.user.id, s.id, p, Date.now());
  res.json({ queue: queueView(req.user.id) });
});
app.delete('/api/queue/:id', auth, (req, res) => {
  db.prepare('DELETE FROM queue WHERE user_id=? AND server_id=?').run(req.user.id, req.params.id);
  res.json({ queue: queueView(req.user.id) });
});

// --- مخصوص سرور بازی (با هدر X-Server-Key) ---
app.post('/api/servers/:id/players', (req, res) => {
  if (!keyOk(req)) return bad(res, 'دسترسی غیرمجاز', 403);
  const s = db.prepare('SELECT max FROM servers WHERE id=?').get(req.params.id);
  if (!s) return bad(res, 'سرور پیدا نشد', 404);
  const n = req.body.players;
  if (!Number.isInteger(n) || n < 0 || n > s.max) return bad(res, 'تعداد بازیکن نامعتبر است');
  db.prepare('UPDATE servers SET players=? WHERE id=?').run(n, req.params.id);
  res.json({ ok: true });
});
app.post('/api/servers/:id/queue/pop', (req, res) => {
  if (!keyOk(req)) return bad(res, 'دسترسی غیرمجاز', 403);
  const row = db.prepare('SELECT q.user_id, u.username FROM queue q JOIN users u ON u.id=q.user_id WHERE q.server_id=? ORDER BY q.pri DESC, q.created ASC, q.rowid ASC LIMIT 1').get(req.params.id);
  if (!row) return res.json({ username: null });
  db.prepare('DELETE FROM queue WHERE user_id=? AND server_id=?').run(row.user_id, req.params.id);
  res.json({ username: row.username });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res) => bad(res, 'مسیر پیدا نشد', 404));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return bad(res, 'درخواست نامعتبر');
  if (err.type === 'entity.too.large') return bad(res, 'حجم درخواست زیاد است', 413);
  console.error(err);
  bad(res, 'خطای داخلی سرور', 500);
});

app.listen(PORT, () => console.log(`VELORA running on http://localhost:${PORT}`));
