// Where the companion app keeps its files, outside the program folder, so updates never touch them:
//   Windows  %APPDATA%\TwitchBoardGames
//   macOS    ~/Library/Application Support/TwitchBoardGames
//   Linux    $XDG_CONFIG_HOME/twitch-board-games (or ~/.config/…)
// Override with the BOARDGAMES_DATA environment variable.
//
//   settings.json   app settings (port, Twitch client ID override, update checks)
//   auth.json       Twitch login tokens: keep this file private
//   auth-bot.json   optional bot account login (same: keep private)
//   data.json       what the overlay saves: viewer stats, trivia categories and question cache
//   backups/        copies of data.json (one per day, and one before every update)

import { mkdir, readFile, writeFile, rename, readdir, rm, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(env = process.env, platform = process.platform) {
  if (env.BOARDGAMES_DATA) return env.BOARDGAMES_DATA;
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'TwitchBoardGames');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'TwitchBoardGames');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'twitch-board-games');
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

// Write to a temp file, then rename: a crash mid-write can't leave half a file behind.
export async function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

export class Store {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.files = {
      settings: join(dir, 'settings.json'),
      auth: join(dir, 'auth.json'),
      authBot: join(dir, 'auth-bot.json'),
      data: join(dir, 'data.json'),
      backups: join(dir, 'backups'),
    };
    this.kv = {};
    this.saveTimer = null;
    this.saving = Promise.resolve();
  }

  async open() {
    await mkdir(this.files.backups, { recursive: true });
    this.kv = await readJson(this.files.data, {});
    this.settings = await readJson(this.files.settings, {});
    await this.backup('daily');
    return this;
  }

  // ---- overlay key/value data (debounced: stats can change several times per game) ----
  getAll() { return { ...this.kv }; }
  set(key, value) { this.kv[key] = String(value); this.#scheduleSave(); }
  delete(key) { delete this.kv[key]; this.#scheduleSave(); }

  #scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saving = this.saving.then(() => writeJson(this.files.data, this.kv)).catch((err) => console.error('[store] could not save data.json:', err.message));
    return this.saving;
  }

  // ---- settings & auth ----
  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    await writeJson(this.files.settings, this.settings);
    return this.settings;
  }

  // kind: 'main' (the streamer) or 'bot'
  #authFile(kind) { return kind === 'bot' ? this.files.authBot : this.files.auth; }
  loadAuth(kind = 'main') { return readJson(this.#authFile(kind), null); }
  saveAuth(auth, kind = 'main') { return auth ? writeJson(this.#authFile(kind), auth) : rm(this.#authFile(kind), { force: true }); }

  // ---- backups: data-YYYY-MM-DD.json once a day (keeps 14), plus data-before-vX.json before updates (keeps 5) ----
  async backup(kind, label = '') {
    if (!Object.keys(this.kv).length) return null;
    await this.flush();
    const name = kind === 'daily' ? `data-${new Date().toISOString().slice(0, 10)}.json` : `data-before-${label}.json`;
    const target = join(this.files.backups, name);
    try { await copyFile(this.files.data, target); } catch { return null; }
    await this.#prune(kind === 'daily' ? /^data-\d{4}-\d\d-\d\d\.json$/ : /^data-before-/, kind === 'daily' ? 14 : 5);
    return target;
  }

  async #prune(pattern, keep) {
    const names = (await readdir(this.files.backups)).filter((n) => pattern.test(n)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - keep))) await rm(join(this.files.backups, n), { force: true });
  }
}
