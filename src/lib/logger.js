// Tiny logger with timestamps + optional file tee.
// Keeps console.log sane when running long multi-city batches.

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;
let logStream = null;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, parts) {
  if (LEVELS[level] < currentLevel) return;
  const line = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${parts.join(' ')}`;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);
  if (logStream) logStream.write(line + '\n');
}

export function setLevel(level) {
  currentLevel = LEVELS[level] ?? LEVELS.info;
}

export function enableFileLog(runLabel) {
  const logsDir = path.resolve('logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `${runLabel}.log`);
  logStream = fs.createWriteStream(file, { flags: 'a' });
  return file;
}

export const log = {
  debug: (...p) => write('debug', p),
  info: (...p) => write('info', p),
  warn: (...p) => write('warn', p),
  error: (...p) => write('error', p),
  step: (n, total, msg) => write('info', [`[${n}/${total}]`, msg]),
};
