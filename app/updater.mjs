// Update check and install for the companion app.
//
// Versions come from GitHub Releases of the update repo (default DanVibesTTV/Twitch-Board-Games;
// forks can point settings.updateRepo at their own). A release is made automatically whenever
// package.json's version changes on main (.github/workflows/release.yml).
//
// Install = download the release's source tarball, check it, then copy its files over the program
// folder. Things that are never touched: your data folder (stats, login, settings), files you added
// yourself, and sounds/sounds.json once you've edited it. Files a release removed are deleted only
// if an earlier update installed them (tracked in installed-files.json in the data folder).

import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { readJson, writeJson } from './store.mjs';

export const DEFAULT_REPO = 'DanVibesTTV/Twitch-Board-Games';
const KEEP_IF_PRESENT = new Set(['sounds/sounds.json']);
const SKIP = [/^\.git(\/|$)/, /^\.github\//, /^node_modules\//];

export class Updater {
  constructor({ root, store, version, repo = DEFAULT_REPO, fetch = globalThis.fetch, log = console }) {
    Object.assign(this, { root, store, version, repo, fetch, log });
    this.latest = null;      // { version, name, notes, url, tarball, publishedAt }
    this.lastCheck = null;
    this.error = null;
    this.installing = false;
  }

  get available() { return !!this.latest && compareVersions(this.latest.version, this.version) > 0; }

  async isGitClone() {
    try { return (await stat(join(this.root, '.git'))).isDirectory(); } catch { return false; }
  }

  async status() {
    return {
      current: this.version,
      latest: this.latest,
      available: this.available,
      lastCheck: this.lastCheck,
      error: this.error,
      installing: this.installing,
      repo: this.repo,
      gitClone: await this.isGitClone(),
    };
  }

  async check() {
    this.lastCheck = Date.now();
    try {
      const res = await this.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TwitchBoardGames-companion' },
      });
      if (res.status === 404) { this.latest = null; this.error = 'no releases published yet'; return this.status(); }
      if (!res.ok) throw new Error(`GitHub said ${res.status}`);
      const r = await res.json();
      this.latest = {
        version: String(r.tag_name).replace(/^v/i, ''),
        name: r.name || r.tag_name,
        notes: r.body ?? '',
        url: r.html_url,
        tarball: r.tarball_url,
        publishedAt: r.published_at,
      };
      this.error = null;
    } catch (err) {
      this.error = `update check failed: ${err.message}`;
    }
    return this.status();
  }

  async install() {
    if (this.installing) throw new Error('already installing');
    if (!this.available) throw new Error('no newer version available');
    if (await this.isGitClone()) throw new Error('this folder is a git clone: update it with "git pull" instead');
    this.installing = true;
    try {
      const res = await this.fetch(this.latest.tarball, { headers: { 'User-Agent': 'TwitchBoardGames-companion' } });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const files = extractTarGz(Buffer.from(await res.arrayBuffer()));
      // Sanity check before touching anything: it has to look like this project.
      for (const must of ['index.html', 'package.json', 'app/companion.mjs']) {
        if (!files.has(must)) throw new Error(`download doesn't look like Stream Board Games (missing ${must})`);
      }
      const pkg = JSON.parse(files.get('package.json').toString('utf8'));
      if (compareVersions(pkg.version, this.version) <= 0) throw new Error(`downloaded version ${pkg.version} isn't newer`);

      await this.store.backup('update', `v${this.version}`);
      const manifestFile = join(this.store.dir, 'installed-files.json');
      const previous = new Set(await readJson(manifestFile, []));
      const written = [];
      for (const [path, data] of files) {
        if (SKIP.some((re) => re.test(path))) continue;
        const target = safeJoin(this.root, path);
        const current = await readFile(target).catch(() => null);
        written.push(path);
        // Unchanged files aren't rewritten (Windows reads a running .bat file as it goes).
        if (current?.equals(data)) continue;
        if (current && KEEP_IF_PRESENT.has(path)) continue; // the streamer edited it
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
      }
      const now = new Set(written);
      for (const old of previous) {
        if (!now.has(old) && !files.has(old)) await rm(safeJoin(this.root, old), { force: true });
      }
      await writeJson(manifestFile, [...now]);
      this.log.log(`[update] installed ${pkg.version}`);
      return { version: pkg.version, files: written.length };
    } finally {
      this.installing = false;
    }
  }
}

// Minimal .tar.gz reader (ustar + GNU/pax long names), enough for GitHub's source tarballs.
// Returns Map<relative path, Buffer> with the top-level "owner-repo-sha/" folder stripped.
export function extractTarGz(gz) {
  const tar = gunzipSync(gz);
  const files = new Map();
  let longName = null;
  let paxPath = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(345, 155);
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { paxPath = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null; continue; }
    if (type === 'g') continue; // global pax header (GitHub puts the commit id here)
    longName = null;
    paxPath = null;
    if (type !== '0' && type !== '7') continue; // regular files only
    name = name.split('/').slice(1).join('/');
    if (name) files.set(name, Buffer.from(body));
  }
  return files;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function safeJoin(root, rel) {
  const target = normalize(join(root, rel));
  if (!target.startsWith(normalize(root) + sep)) throw new Error(`unsafe path in download: ${rel}`);
  return target;
}
