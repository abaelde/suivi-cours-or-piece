'use strict';
const fs = require('fs');
const path = require('path');

function loadEnvOnce() {
  if (process.env.__ENV_LOADED) return;
  const root = path.join(__dirname, '..', '..');
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  }
  process.env.__ENV_LOADED = '1';
}

module.exports = { loadEnvOnce };

