// Dependency-free local server for the Synapse landing page (Node.js 22+).
// Run: node server.js  |  Open: http://127.0.0.1:8000/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const nodemailer = require('nodemailer');

const ROOT = __dirname;

// Load environment variables from .env file if it exists
if (fs.existsSync(path.join(ROOT, '.env'))) {
  const envContent = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const val = parts.slice(1).join('=').trim();
    if (key) {
      process.env[key] = val;
    }
  });
}

const emailUser = process.env.EMAIL_USER || 'mariavictor592@gmail.com';
const emailPass = process.env.EMAIL_PASS;

let transporter;
if (emailPass) {
  console.log(`[SMTP] Initializing Nodemailer for user: ${emailUser}`);
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailUser,
      pass: emailPass
    }
  });

  // Verify connection configuration on startup
  transporter.verify((error, success) => {
    if (error) {
      console.error('[SMTP] Startup verification failed:', error);
    } else {
      console.log('[SMTP] Connection verified. Server is ready to send messages.');
    }
  });
} else {
  console.warn('[SMTP] No EMAIL_PASS configured in environment. Simulated email mode active.');
}

const db = new DatabaseSync(path.join(ROOT, 'contact_submissions.sqlite3'));
db.exec(`CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL,
  email TEXT NOT NULL, message TEXT NOT NULL, submitted_at TEXT NOT NULL, ip_address TEXT
)`);
const attempts = new Map();

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Access-Control-Allow-Origin': 'null', 'Content-Type': `${type}; charset=utf-8` });
  res.end(body);
}

function allow(ip) {
  const now = Date.now();
  const timestamps = (attempts.get(ip) || []).filter(t => now - t < 3600000);
  if (timestamps.length >= 5) return false;
  timestamps.push(now); attempts.set(ip, timestamps); return true;
}

function safe(value) { return typeof value === 'string' ? value.trim() : ''; }

async function sendEmail({ name, email, phone, message }) {
  const mailOptions = {
    from: emailUser,
    to: 'mariavictor592@gmail.com',
    replyTo: email,
    subject: 'New Project Inquiry - NEXOR Website',
    text: `New Project Inquiry

Full Name:
${name}

Email:
${email}

Phone Number:
${phone}

Project Requirement:
${message}

Submitted At:
${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} (IST)
`
  };

  if (!emailPass) {
    console.log('[SMTP] --- SIMULATED EMAIL DISPATCH (No EMAIL_PASS in .env) ---');
    console.log('[SMTP] Subject:', mailOptions.subject);
    console.log(mailOptions.text);
    console.log('[SMTP] ------------------------------------------------------');
    return true;
  }

  console.log('[SMTP] Connecting to email service...');
  
  // Verify transporter succeeds before sending mail
  await new Promise((resolve, reject) => {
    transporter.verify((err, success) => {
      if (err) {
        console.error('[SMTP] Connection verification failed inside sendEmail:', err);
        reject(err);
      } else {
        console.log('[SMTP] Connection verified successfully.');
        resolve();
      }
    });
  });

  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('[SMTP] Error occurred:', error);
        reject(error);
      } else {
        console.log('[SMTP] Email sent successfully:', info.response);
        resolve(info);
      }
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html');
  }
  
  if (req.method === 'GET' && (req.url === '/ai-software-company.html' || req.url === '/ai-software-company')) {
    const specialistPath = fs.existsSync(path.join(ROOT, 'NEXORA_COMPANY_1', 'outputs', 'ai-software-company.html'))
      ? path.join(ROOT, 'NEXORA_COMPANY_1', 'outputs', 'ai-software-company.html')
      : path.join(ROOT, 'ai-software-company.html');
    if (fs.existsSync(specialistPath)) {
      return send(res, 200, fs.readFileSync(specialistPath), 'text/html');
    }
  }

  if (req.method !== 'POST' || req.url !== '/api/contact') return send(res, 404, JSON.stringify({ detail: 'Not found.' }));
  
  console.log('[API] Request received at /api/contact');

  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
  req.on('end', async () => {
    const ip = req.socket.remoteAddress || 'unknown';
    console.log('[API] Form submitted from IP:', ip);

    try {
      const data = JSON.parse(body);
      if (safe(data.company)) return send(res, 201, JSON.stringify({ ok: true }));
      
      const name = safe(data.name);
      const phone = safe(data.phone);
      const email = safe(data.email);
      const message = safe(data.message);

      if (!name) throw new Error('Full Name cannot be empty.');
      if (!phone || !/^[0-9+()\-\s]{7,30}$/.test(phone)) throw new Error('Phone Number is mandatory and should accept only valid phone numbers.');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email must be in a valid email format.');
      if (!message) throw new Error('Project Requirement / Message cannot be empty.');

      console.log('[API] Validation passed successfully');

      if (!allow(ip)) {
        console.warn('[API] Rate limit exceeded for IP:', ip);
        return send(res, 429, JSON.stringify({ detail: 'Please wait before sending another inquiry.' }));
      }

      // Save to local sqlite db
      db.prepare('INSERT INTO submissions (name, phone, email, message, submitted_at, ip_address) VALUES (?, ?, ?, ?, ?, ?)').run(
        name, phone, email, message, new Date().toISOString(), ip
      );

      // Dispatch inquiry email
      await sendEmail({ name, email, phone, message });

      return send(res, 201, JSON.stringify({ ok: true }));
    } catch (error) {
      console.error('[API] Error handling contact form submission:', error.message);
      return send(res, 422, JSON.stringify({ detail: error.message || 'Unable to process the inquiry.' }));
    }
  });
});
server.listen(8000, '127.0.0.1', () => console.log('Synapse is running at http://127.0.0.1:8000/'));
