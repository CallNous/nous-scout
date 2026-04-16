// Franchise filter. Matches shop name against the blocklist in config/scoring.json.
// Case-insensitive substring match — intentionally loose so variants like
// "Canadian Tire Auto Service Centre" get caught.

import fs from 'node:fs';
import path from 'node:path';

let cachedList = null;

function load() {
  if (cachedList) return cachedList;
  const file = path.resolve('config/scoring.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cachedList = (cfg.franchises || []).map((s) => s.toLowerCase());
  return cachedList;
}

export function isFranchise(shopName) {
  if (!shopName) return false;
  const name = shopName.toLowerCase();
  return load().some((f) => name.includes(f));
}

export function loadConfig() {
  const file = path.resolve('config/scoring.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
