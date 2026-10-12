require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Pool } = require('pg');
const QRCode = require('qrcode');

const app = express();
const port = Number(process.env.PORT || 8080);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const demoEnabled = process.env.DEMO_MODE !== 'false';
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'BeyondBorders2026!';
const adminAttempts = new Map();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "https:"],
      "connect-src": ["'self'"],
      "media-src": ["'self'", "blob:"],
      "font-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'", "https://accounts.google.com"]
    }
  }
}));
app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.SESSION_COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, avatar_url FROM users WHERE id = $1', [id]);
    done(null, rows[0] || false);
  } catch (error) { done(error); }
});

if (googleEnabled) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value || null;
      const avatar = profile.photos?.[0]?.value || null;
      const { rows } = await pool.query(
        `INSERT INTO users (google_id, email, name, avatar_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url
         RETURNING id, email, name, avatar_url`,
        [profile.id, email, profile.displayName || 'Participant', avatar]
      );
      done(null, rows[0]);
    } catch (error) { done(error); }
  }));
}

function requireUser(req, res, next) {
  if (req.isAuthenticated?.()) return next();
  return res.status(401).json({ error: 'Sign in to collect stamps.' });
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(401).json({ error: 'Admin authentication required.' });
}

function constantTimeMatch(input, expected) {
  const left = Buffer.from(String(input || ''));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ googleAuth: googleEnabled, demoMode: demoEnabled }));

app.get('/auth/google', (req, res, next) => {
  if (!googleEnabled) return res.redirect('/?auth=configure-google');
  return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});
app.get('/auth/google/callback', (req, res, next) => {
  if (!googleEnabled) return res.redirect('/?auth=configure-google');
  return passport.authenticate('google', { failureRedirect: '/?auth=failed', successRedirect: '/' })(req, res, next);
});
app.post('/auth/demo', async (req, res, next) => {
  if (!demoEnabled) return res.status(404).json({ error: 'Demo mode is disabled.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ('demo-user', 'participant@example.com', 'Impact Participant')
       ON CONFLICT (google_id) DO UPDATE SET name = EXCLUDED.name RETURNING id, email, name, avatar_url`
    );
    req.login(rows[0], error => error ? next(error) : res.json({ user: rows[0] }));
  } catch (error) { next(error); }
});
app.post('/auth/logout', (req, res, next) => req.logout(error => error ? next(error) : req.session.destroy(() => res.status(204).end())));

app.get('/api/admin/session', (req, res) => res.json({ authenticated: Boolean(req.session?.isAdmin), username: req.session?.isAdmin ? adminUsername : null }));
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const attempt = adminAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (attempt.lockedUntil > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const valid = constantTimeMatch(req.body?.username, adminUsername) && constantTimeMatch(req.body?.password, adminPassword);
  if (!valid) {
    attempt.count += 1;
    if (attempt.count >= 5) { attempt.lockedUntil = Date.now() + 15 * 60 * 1000; attempt.count = 0; }
    adminAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  adminAttempts.delete(ip);
  req.session.isAdmin = true;
  req.session.adminUsername = adminUsername;
  return res.json({ authenticated: true, username: adminUsername });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.isAdmin = false;
  delete req.session.adminUsername;
  req.session.save(() => res.status(204).end());
});

app.get('/api/admin/overview', requireAdmin, async (_req, res, next) => {
  try {
    const [summary, activities] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*)::int FROM users WHERE google_id <> 'demo-user') AS registered_participants,
        (SELECT COUNT(*)::int FROM scans) AS total_scans,
        (SELECT COUNT(*)::int FROM stamps) AS total_stamps`),
      pool.query(`SELECT a.slug, a.title, a.event_date, a.time_label, a.location, a.description, a.sdg_ids, q.code AS qr_code,
        COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT(
          'name', u.name, 'email', u.email, 'avatar_url', u.avatar_url, 'scanned_at', s.scanned_at
        ) ORDER BY s.scanned_at DESC)
        FROM scans s JOIN users u ON u.id = s.user_id WHERE s.activity_slug = a.slug), '[]'::json) AS participants
        FROM activities a LEFT JOIN qr_codes q ON q.activity_slug = a.slug
        ORDER BY a.event_date`)
    ]);
    res.json({ summary: summary.rows[0], activities: activities.rows });
  } catch (error) { next(error); }
});

app.get('/api/admin/activities/:slug/qr.png', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT a.slug, a.title, q.code FROM activities a JOIN qr_codes q ON q.activity_slug = a.slug WHERE a.slug = $1`, [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Event day not found.' });
    const png = await QRCode.toBuffer(rows[0].code, { type: 'png', width: 1200, margin: 4, errorCorrectionLevel: 'H', color: { dark: '#123D35', light: '#FFFDF8' } });
    res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="beyond-borders-${rows[0].slug}-qr.png"`, 'Cache-Control': 'no-store' });
    res.send(png);
  } catch (error) { next(error); }
});

app.get('/api/activities', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT slug, title, event_date, time_label, location, description, sdg_ids FROM activities ORDER BY event_date');
    res.json(rows);
  } catch (error) { next(error); }
});

app.get('/api/me', async (req, res, next) => {
  if (!req.isAuthenticated?.()) return res.json({ user: null, stamps: [], recent: [] });
  try {
    const [stamps, recent] = await Promise.all([
      pool.query('SELECT sdg_id, activity_slug, earned_at FROM stamps WHERE user_id = $1 ORDER BY sdg_id', [req.user.id]),
      pool.query(`SELECT a.title, a.location, s.activity_slug, MAX(s.earned_at) AS earned_at, ARRAY_AGG(s.sdg_id ORDER BY s.sdg_id) AS sdg_ids
                  FROM stamps s JOIN activities a ON a.slug = s.activity_slug WHERE s.user_id = $1
                  GROUP BY a.title, a.location, s.activity_slug ORDER BY earned_at DESC LIMIT 6`, [req.user.id])
    ]);
    res.json({ user: req.user, stamps: stamps.rows, recent: recent.rows });
  } catch (error) { next(error); }
});

app.post('/api/stamps/redeem', requireUser, async (req, res, next) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code || code.length > 100) return res.status(400).json({ error: 'Enter a valid activity code.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT q.code, q.active, q.expires_at, a.slug, a.title, a.sdg_ids
       FROM qr_codes q JOIN activities a ON a.slug = q.activity_slug WHERE q.code = $1 FOR UPDATE`, [code]
    );
    const qr = found.rows[0];
    if (!qr || !qr.active || (qr.expires_at && new Date(qr.expires_at) < new Date())) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This activity code is invalid or has expired.' });
    }
    const scan = await client.query(
      `INSERT INTO scans (user_id, activity_slug, qr_code) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, activity_slug) DO NOTHING RETURNING id`, [req.user.id, qr.slug, code]
    );
    if (!scan.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You already collected the stamps from this activity.' });
    }
    const added = await client.query(
      `INSERT INTO stamps (user_id, sdg_id, activity_slug)
       SELECT $1, unnest($2::int[]), $3 ON CONFLICT (user_id, sdg_id) DO NOTHING RETURNING sdg_id`,
      [req.user.id, qr.sdg_ids, qr.slug]
    );
    await client.query('COMMIT');
    res.json({ activity: { slug: qr.slug, title: qr.title }, goals: qr.sdg_ids, newlyAdded: added.rows.map(row => row.sdg_id) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const activities = [
  ['culture-values', 'Thai Culture & Values', '2026-02-09', '17:00 - 19:00', 'SCIT0101, Assumption University', 'Respect, kindness, hospitality, unity, community spirit, and intercultural understanding.', [4,17]],
  ['language-identity', 'Thai Language & Identity', '2026-02-10', '17:00 - 19:00', 'SCIT0101, Assumption University', 'Thai pronouns, address terms, useful expressions, respectful communication, and cultural exchange.', [4,10]],
  ['food-sharing', 'Thai Culinary Heritage', '2026-02-11', '17:00 - 19:30', 'Kitchen Room, Assumption University', 'Traditional dishes, local ingredients, food-sharing culture, teamwork, and Thai culinary knowledge.', [2,3,6,12]],
  ['craft-play', 'Craftsmanship & Local Wisdom', '2026-02-12', '10:00 - 14:00', 'SM Center, Assumption University', 'Bracelet making, creativity, patience, practical skills, and appreciation of Thai craftsmanship.', [4,8,11]],
  ['culture-action', 'Thai Culture in Action', '2026-02-13', '16:00 - 20:00', 'Football Field, Assumption University', 'Traditional games, food experiences, community spirit, cultural participation, and club collaboration.', [3,10,12,17]],
  ['green-living', 'Community, Culture & Local Living', '2026-02-15', '08:00 - 15:00', 'Bang Krachao, Bangkok', 'Cycling, local food, floating-market culture, environmental heritage, and sustainable community life.', [11,12,13,15]]
];

async function ensureDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY, google_id TEXT UNIQUE NOT NULL, email TEXT, name TEXT NOT NULL,
      avatar_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activities (
      slug TEXT PRIMARY KEY, title TEXT NOT NULL, event_date DATE NOT NULL, time_label TEXT NOT NULL,
      location TEXT NOT NULL, description TEXT NOT NULL, sdg_ids INTEGER[] NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qr_codes (
      code TEXT PRIMARY KEY, activity_slug TEXT NOT NULL REFERENCES activities(slug) ON DELETE CASCADE,
      active BOOLEAN NOT NULL DEFAULT TRUE, expires_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS scans (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_slug TEXT NOT NULL REFERENCES activities(slug), qr_code TEXT NOT NULL,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, activity_slug)
    );
    CREATE TABLE IF NOT EXISTS stamps (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sdg_id INTEGER NOT NULL CHECK (sdg_id BETWEEN 1 AND 17), activity_slug TEXT NOT NULL REFERENCES activities(slug),
      earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id, sdg_id)
    );
  `);
  for (const activity of activities) {
    await pool.query(`INSERT INTO activities (slug,title,event_date,time_label,location,description,sdg_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (slug) DO UPDATE SET
      title=EXCLUDED.title,event_date=EXCLUDED.event_date,time_label=EXCLUDED.time_label,
      location=EXCLUDED.location,description=EXCLUDED.description,sdg_ids=EXCLUDED.sdg_ids`, activity);
    await pool.query(`INSERT INTO qr_codes (code, activity_slug) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`,
      [`BEYOND-BORDERS-DAY-${activities.indexOf(activity)+1}`, activity[0]]);
  }
  await pool.query(`DELETE FROM stamps`);
  await pool.query(`INSERT INTO stamps (user_id, sdg_id, activity_slug, earned_at)
    SELECT DISTINCT ON (s.user_id, goal.sdg_id) s.user_id, goal.sdg_id, s.activity_slug, s.scanned_at
    FROM scans s JOIN activities a ON a.slug = s.activity_slug
    CROSS JOIN LATERAL UNNEST(a.sdg_ids) AS goal(sdg_id)
    ORDER BY s.user_id, goal.sdg_id, s.scanned_at`);
}

ensureDatabase()
  .then(() => app.listen(port, () => console.log(`Beyond Borders Passport running on port ${port}`)))
  .catch(error => { console.error('Database initialization failed', error); process.exit(1); });
