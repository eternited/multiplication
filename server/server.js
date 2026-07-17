const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || (() => {
  console.warn('[WARN] JWT_SECRET not set — tokens will invalidate on restart! Set JWT_SECRET in .env');
  return crypto.randomBytes(32).toString('hex');
})();

const app = express();
const db = new Database(path.join(__dirname, 'multiplication.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_data (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    data       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

app.use(express.json({ limit: '2mb' }));

// Serve frontend
app.get('/', (_req, res) =>
  res.sendFile(path.resolve(__dirname, '..', 'index.html'))
);

// Auth middleware
const auth = (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
  try {
    req.user = jwt.verify(h.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
};

// Login or register — name is the only identifier, no password
app.post('/api/login', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  if (name.length > 50) return res.status(400).json({ error: 'name too long' });

  let user = db.prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE').get(name);
  if (!user) {
    const r = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run(name, Date.now());
    user = { id: r.lastInsertRowid, name };
  }

  const row = db.prepare('SELECT data FROM user_data WHERE user_id = ?').get(user.id);
  const data = row ? JSON.parse(row.data) : { facts: {}, sessions: [] };
  const token = jwt.sign({ uid: user.id, name: user.name }, SECRET, { expiresIn: '365d' });

  res.json({ token, name: user.name, uid: user.id, data });
});

// Get data
app.get('/api/data', auth, (req, res) => {
  const row = db.prepare('SELECT data FROM user_data WHERE user_id = ?').get(req.user.uid);
  res.json({ data: row ? JSON.parse(row.data) : { facts: {}, sessions: [] } });
});

// Save data
app.put('/api/data', auth, (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'data required' });
  db.prepare(`
    INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.user.uid, JSON.stringify(data), Date.now());
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Multiplication server running on port ${PORT}`));
