require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 8080);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const demoEnabled = process.env.DEMO_MODE !== 'false';

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

app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const activities = [
  ['culture-values', 'Culture & Values', '2026-02-09', '17:00 - 19:00', 'SCIT0101, Assumption University', 'Opening, SDG learning, Thai cultural values, and passport orientation.', [4,9]],
  ['language-identity', 'Language & Identity', '2026-02-10', '17:00 - 19:00', 'SCIT0101, Assumption University', 'Thai language, cultural etiquette, and inclusive communication.', [4]],
  ['food-sharing', 'Food & Sharing', '2026-02-11', '17:00 - 19:30', 'Kitchen Room, Assumption University', 'Thai cooking, food hygiene, portion control, and responsible resources.', [2,6,12]],
  ['craft-play', 'Craft & Play', '2026-02-12', '10:00 - 14:00', 'SM Center, Assumption University', 'Bracelet making and Thai board games for creativity and economic inclusion.', [1,8]],
  ['culture-action', 'Culture in Action', '2026-02-13', '16:00 - 20:00', 'Football Field, Assumption University', 'Thai games, picnic spaces, community booths, music, and SDG discovery zones.', [3,10,12,16,17]],
  ['green-living', 'Green Living', '2026-02-15', '08:00 - 15:00', 'Bang Krachao, Bangkok', 'Cycling, nature exploration, photo mapping, and sustainable local lifestyles.', [7,13,14,15]]
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
      [`LIVING-DAY-${activities.indexOf(activity)+1}`, activity[0]]);
  }
}

ensureDatabase()
  .then(() => app.listen(port, () => console.log(`Beyond Borders Passport running on port ${port}`)))
  .catch(error => { console.error('Database initialization failed', error); process.exit(1); });
