#!/usr/bin/env node
// Script to promote a user to admin
// Usage: node make-admin.js email@example.com

require('dotenv').config();
const db = require('./database');

const email = process.argv[2];

if (!email) {
  console.error('Usage: node make-admin.js email@example.com');
  process.exit(1);
}

// Find user
const user = db.prepare('SELECT id, email, username, is_admin FROM users WHERE email = ?').get(email);

if (!user) {
  console.error(`User not found: ${email}`);
  process.exit(1);
}

console.log('Found user:', user);

if (user.is_admin === 1) {
  console.log('User is already an admin!');
  process.exit(0);
}

// Promote to admin
db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(email);

const updated = db.prepare('SELECT id, email, username, is_admin FROM users WHERE email = ?').get(email);
console.log('Updated user:', updated);
console.log('✅ User promoted to admin successfully!');
