// Trivia questions from the Open Trivia Database (https://opentdb.com, CC BY-SA 4.0).
//
// - Rate limit: one request per IP every 5 seconds → all requests go through one queue.
// - A session token avoids repeat questions (tokens expire after 6 h of inactivity).
// - Unused questions are cached in localStorage, so the next game starts instantly.
// - If the API can't be reached, a small built-in question set keeps the game going.

const API = 'https://opentdb.com';
const SPACING_MS = 5300;     // a bit more than the 5 s rate limit
const TOKEN_MAX_AGE = 5.5 * 3600 * 1000;
const POOL_CAP = 40;         // cached questions per category
const MIN_READY = 4;         // try to keep at least this many per slot
const KEYS = { pool: 'boardgames.trivia.pool.v1', token: 'boardgames.trivia.token', slots: 'boardgames.trivia.slots' };

// Every OpenTDB category (id) plus a few combinations. Keys are what the streamer types.
export const CATEGORIES = {
  general: { name: 'General Knowledge', ids: [9] },
  history: { name: 'History', ids: [23] },
  entertainment: { name: 'Entertainment', ids: [11, 12, 14, 15] },
  science: { name: 'Science & Nature', ids: [17] },
  math: { name: 'Mathematics', ids: [19] },
  comics: { name: 'Comics', ids: [29] },
  arts: { name: 'Arts & Literature', ids: [10, 13, 25] },
  books: { name: 'Books', ids: [10] },
  film: { name: 'Film', ids: [11] },
  music: { name: 'Music', ids: [12] },
  theatre: { name: 'Musicals & Theatre', ids: [13] },
  tv: { name: 'Television', ids: [14] },
  videogames: { name: 'Video Games', ids: [15] },
  boardgames: { name: 'Board Games', ids: [16] },
  computers: { name: 'Computers', ids: [18] },
  mythology: { name: 'Mythology', ids: [20] },
  sports: { name: 'Sports', ids: [21] },
  geography: { name: 'Geography', ids: [22] },
  politics: { name: 'Politics', ids: [24] },
  art: { name: 'Art', ids: [25] },
  celebrities: { name: 'Celebrities', ids: [26] },
  animals: { name: 'Animals', ids: [27] },
  vehicles: { name: 'Vehicles', ids: [28] },
  gadgets: { name: 'Gadgets', ids: [30] },
  anime: { name: 'Anime & Manga', ids: [31] },
  cartoons: { name: 'Cartoons & Animation', ids: [32] },
};

export const DEFAULT_SLOTS = ['general', 'history', 'entertainment', 'science', 'math', 'comics'];
export const SLOT_COLORS = ['#3d8bff', '#ffd23f', '#ff4fb4', '#3ddc84', '#ff8a3d', '#a66bff'];

const decode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

export class QuestionBank {
  constructor({ fetch = globalThis.fetch?.bind(globalThis), storage = safeStorage(), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.fetch = fetch;
    this.storage = storage;
    this.now = now;
    this.sleep = sleep;
    this.pools = this.#read(KEYS.pool) ?? {};   // categoryKey → [question]
    this.token = this.#read(KEYS.token);         // { value, lastUsed }
    const saved = this.#read(KEYS.slots);
    this.slotKeys = Array.isArray(saved) && saved.length === 6 && saved.every((k) => CATEGORIES[k]) ? saved : [...DEFAULT_SLOTS];
    this.queue = Promise.resolve();
    this.lastRequest = 0;
    this.pending = new Set();
    this.offlineUntil = 0;
    this.listeners = new Set();
  }

  // ───────────── slots (the 6 categories on the board) ─────────────

  get slots() {
    return this.slotKeys.map((key, i) => ({ key, name: CATEGORIES[key].name, color: SLOT_COLORS[i] }));
  }

  setSlot(index, key) {
    if (!CATEGORIES[key] || index < 0 || index > 5) return false;
    this.slotKeys[index] = key;
    this.#write(KEYS.slots, this.slotKeys);
    this.#changed();
    return true;
  }

  resetSlots() {
    this.slotKeys = [...DEFAULT_SLOTS];
    this.#write(KEYS.slots, this.slotKeys);
    this.#changed();
  }

  // ───────────── questions ─────────────

  count(slot) { return (this.pools[this.slotKeys[slot]] ?? []).length; }
  ready() { return this.slotKeys.every((_, i) => this.count(i) > 0); }

  // Synchronous: the game needs a question right now. Falls back to built-in questions.
  take(slot, rng = { next: Math.random }) {
    const key = this.slotKeys[slot];
    const pool = this.pools[key] ?? [];
    let q = pool.shift();
    this.#write(KEYS.pool, this.pools);
    if (pool.length < MIN_READY) this.fill(slot);
    let source = 'opentdb';
    if (!q) {
      q = fallbackQuestion(key, rng);
      source = 'builtin';
    }
    const answers = [q.correct, ...q.incorrect];
    // shuffle (true/false questions keep True before False)
    if (q.type === 'boolean') answers.sort((a, b) => (a === 'True' ? -1 : b === 'True' ? 1 : 0));
    else for (let i = answers.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [answers[i], answers[j]] = [answers[j], answers[i]];
    }
    return {
      text: q.text,
      answers,
      correctIndex: answers.indexOf(q.correct),
      difficulty: q.difficulty ?? 'medium',
      category: CATEGORIES[key].name,
      slot,
      source,
    };
  }

  // Top up every slot (called when a lobby opens). Resolves when done or failed.
  preload() {
    return Promise.all(this.slotKeys.map((_, i) => this.fill(i)));
  }

  // Wait until each slot has a question, or until `ms` passed.
  async waitReady(ms = 8000) {
    const end = this.now() + ms;
    while (!this.ready() && this.now() < end && this.now() >= this.offlineUntil) await this.sleep(250);
    return this.ready();
  }

  fill(slot) {
    const key = this.slotKeys[slot];
    if ((this.pools[key]?.length ?? 0) >= MIN_READY || this.pending.has(key)) return Promise.resolve();
    this.pending.add(key);
    const job = this.queue.then(() => this.#fetchCategory(key)).catch((err) => console.warn('[trivia] fetch failed', err)).finally(() => this.pending.delete(key));
    this.queue = job;
    return job;
  }

  async #fetchCategory(key) {
    if (this.now() < this.offlineUntil) return;
    const ids = CATEGORIES[key].ids;
    const id = ids[Math.floor(Math.random() * ids.length)];
    for (const amount of [10, 5, 2]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await this.#getToken();
        const url = `${API}/api.php?amount=${amount}&category=${id}&encode=url3986${token ? `&token=${token}` : ''}`;
        const data = await this.#request(url);
        if (!data) return; // offline
        const code = data.response_code;
        if (code === 0) return this.#add(key, data.results);
        if (code === 1) break;                                 // not enough questions → ask for fewer
        if (code === 3) { this.token = null; continue; }       // token unknown → new one
        if (code === 4) { await this.#resetToken(); continue; } // seen everything → reset
        if (code === 5) continue;                              // rate limited → the queue waits
        return;                                                // 2 = invalid parameter
      }
    }
  }

  #add(key, results) {
    const pool = (this.pools[key] ??= []);
    const seen = new Set(pool.map((q) => q.text));
    for (const r of results) {
      const q = {
        text: decode(r.question),
        correct: decode(r.correct_answer),
        incorrect: r.incorrect_answers.map(decode),
        difficulty: r.difficulty,
        type: r.type,
      };
      if (!seen.has(q.text)) { pool.push(q); seen.add(q.text); }
    }
    if (pool.length > POOL_CAP) pool.splice(0, pool.length - POOL_CAP);
    this.#write(KEYS.pool, this.pools);
    this.#changed();
  }

  async #getToken() {
    if (this.token && this.now() - this.token.lastUsed < TOKEN_MAX_AGE) {
      this.token.lastUsed = this.now();
      this.#write(KEYS.token, this.token);
      return this.token.value;
    }
    const data = await this.#request(`${API}/api_token.php?command=request`);
    if (data?.response_code === 0 && data.token) {
      this.token = { value: data.token, lastUsed: this.now() };
      this.#write(KEYS.token, this.token);
      return data.token;
    }
    return null; // works without a token too, just with possible repeats
  }

  async #resetToken() {
    if (!this.token) return;
    await this.#request(`${API}/api_token.php?command=reset&token=${this.token.value}`);
    this.token.lastUsed = this.now();
  }

  // One HTTP request, spaced to respect the rate limit. Returns parsed JSON or null when offline.
  async #request(url) {
    const wait = this.lastRequest + SPACING_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequest = this.now();
    try {
      const res = await this.fetch(url);
      return await res.json();
    } catch (err) {
      console.warn('[trivia] Open Trivia DB unreachable, using built-in questions for now', err);
      this.offlineUntil = this.now() + 30_000;
      return null;
    }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #changed() { for (const fn of this.listeners) try { fn(); } catch { /* ignore */ } }

  #read(key) {
    try { return JSON.parse(this.storage?.getItem(key) ?? 'null'); } catch { return null; }
  }

  #write(key, value) {
    try { this.storage?.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  }
}

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// ───────────── built-in questions (used only when the API can't deliver) ─────────────

const q = (text, correct, ...incorrect) => ({ text, correct, incorrect, difficulty: 'easy', type: 'multiple' });

export const BUILTIN = {
  general: [
    q('Which planet is known as the Red Planet?', 'Mars', 'Venus', 'Jupiter', 'Mercury'),
    q('How many days are in a leap year?', '366', '365', '364', '367'),
    q('What is the largest ocean on Earth?', 'Pacific Ocean', 'Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'),
    q('Which color do you get by mixing blue and yellow paint?', 'Green', 'Purple', 'Orange', 'Brown'),
    q('What is the capital city of Japan?', 'Tokyo', 'Kyoto', 'Osaka', 'Seoul'),
    q('How many legs does a spider have?', '8', '6', '10', '12'),
  ],
  history: [
    q('In which year did World War II end?', '1945', '1944', '1946', '1939'),
    q('Who was the first President of the United States?', 'George Washington', 'Thomas Jefferson', 'Abraham Lincoln', 'John Adams'),
    q('In which year did the Berlin Wall fall?', '1989', '1991', '1987', '1990'),
    q('Which civilization built Machu Picchu?', 'The Inca', 'The Aztecs', 'The Maya', 'The Olmecs'),
    q('Who was the first person to walk on the Moon?', 'Neil Armstrong', 'Buzz Aldrin', 'Yuri Gagarin', 'Michael Collins'),
    q('Ancient Rome is said to have been built on how many hills?', 'Seven', 'Five', 'Nine', 'Twelve'),
  ],
  entertainment: [
    q('Which band released the album "Abbey Road"?', 'The Beatles', 'The Rolling Stones', 'Queen', 'Pink Floyd'),
    q("What is the name of Mario's brother in the Nintendo games?", 'Luigi', 'Wario', 'Toad', 'Yoshi'),
    q('Which TV series is set in the fictional town of Hawkins, Indiana?', 'Stranger Things', 'Twin Peaks', 'Riverdale', 'Dark'),
    q('Who composed "The Four Seasons"?', 'Antonio Vivaldi', 'Wolfgang Amadeus Mozart', 'Johann Sebastian Bach', 'Ludwig van Beethoven'),
    q('In Minecraft, which block is used to build a Nether portal frame?', 'Obsidian', 'Bedrock', 'Netherrack', 'Cobblestone'),
    q('In which film series does the line "May the Force be with you" appear?', 'Star Wars', 'Star Trek', 'Dune', 'The Matrix'),
  ],
  science: [
    q('What is the chemical symbol for gold?', 'Au', 'Ag', 'Gd', 'Go'),
    q('Which gas do plants take in from the air for photosynthesis?', 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'),
    q('How many bones are in the adult human body?', '206', '201', '212', '196'),
    q('Which planet is the largest in our Solar System?', 'Jupiter', 'Saturn', 'Neptune', 'Earth'),
    q('At sea level, water boils at how many degrees Celsius?', '100', '90', '120', '80'),
    q('What is the closest star to Earth?', 'The Sun', 'Proxima Centauri', 'Sirius', 'Polaris'),
  ],
  math: [
    q('What is 7 × 8?', '56', '54', '58', '64'),
    q('How many sides does a hexagon have?', '6', '5', '7', '8'),
    q('What is the square root of 144?', '12', '14', '11', '16'),
    q('What is π rounded to two decimal places?', '3.14', '3.41', '3.16', '3.12'),
    q('What is 15% of 200?', '30', '15', '20', '35'),
    q('The interior angles of a triangle add up to how many degrees?', '180', '360', '90', '270'),
  ],
  comics: [
    q("What is Superman's home planet?", 'Krypton', 'Mars', 'Thanagar', 'Apokolips'),
    q("What is Batman's secret identity?", 'Bruce Wayne', 'Clark Kent', 'Peter Parker', 'Tony Stark'),
    q("Which metal is bonded to Wolverine's skeleton?", 'Adamantium', 'Vibranium', 'Titanium', 'Uru'),
    q("What is the first name of Spider-Man's aunt?", 'May', 'June', 'Martha', 'Anna'),
    q('Which city does Batman protect?', 'Gotham City', 'Metropolis', 'Star City', 'Central City'),
    q("What is the name of Thor's hammer?", 'Mjolnir', 'Stormbreaker', 'Gungnir', 'Excalibur'),
  ],
};

export function fallbackQuestion(key, rng = { next: Math.random }) {
  const list = BUILTIN[key] ?? BUILTIN.general;
  return list[Math.floor(rng.next() * list.length)];
}
