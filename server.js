// Dependency-free local server for the Synapse landing page (Node.js 22+).
// Run: node server.js  |  Open: http://127.0.0.1:8000/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const db = new DatabaseSync(path.join(ROOT, 'contact_submissions.sqlite3'));
db.exec(`CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL,
  email TEXT NOT NULL, message TEXT NOT NULL, submitted_at TEXT NOT NULL, ip_address TEXT
)`);
const attempts = new Map();

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Access-Control-Allow-Origin': 'null' });
  res.end(body);
}
function allow(ip) {
  const now = Date.now();
  const timestamps = (attempts.get(ip) || []).filter(t => now - t < 3600000);
  if (timestamps.length >= 5) return false;
  timestamps.push(now); attempts.set(ip, timestamps); return true;
}
function safe(value) { return typeof value === 'string' ? value.trim() : ''; }

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html');
  }
  if (req.method !== 'POST' || req.url !== '/api/contact') return send(res, 404, JSON.stringify({ detail: 'Not found.' }));
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      if (safe(data.company)) return send(res, 201, JSON.stringify({ ok: true }));
      const name = safe(data.name), phone = safe(data.phone), email = safe(data.email), message = safe(data.message);
      if (name.length < 2 || name.length > 100) throw new Error('Please enter your full name.');
      if (!/^[0-9+()\-\s]{7,30}$/.test(phone)) throw new Error('Please enter a valid phone number.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Please enter a valid email address.');
      if (message.length < 10 || message.length > 5000) throw new Error('Please enter a message between 10 and 5,000 characters.');
      const ip = req.socket.remoteAddress || 'unknown';
      if (!allow(ip)) return send(res, 429, JSON.stringify({ detail: 'Please wait before sending another inquiry.' }));
      db.prepare('INSERT INTO submissions (name, phone, email, message, submitted_at, ip_address) VALUES (?, ?, ?, ?, ?, ?)').run(name, phone, email, message, new Date().toISOString(), ip);
      return send(res, 201, JSON.stringify({ ok: true }));
    } catch (error) { return send(res, 422, JSON.stringify({ detail: error.message || 'Unable to process the inquiry.' })); }
  });
});
server.listen(8000, '127.0.0.1', () => console.log('Synapse is running at http://127.0.0.1:8000/'));
