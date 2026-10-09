// God's Noisey BoyZ: a private turntable.fm-style room for friends.
// One room, up to 5 DJ seats taking turns, synced YouTube playback.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const yt = require('./youtube');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ------------------------------------------------------------------ config
const CONFIG_PATH = path.join(ROOT, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(path.join(ROOT, 'config.example.json'), CONFIG_PATH);
const config = {
  siteName: "God's Noisey BoyZ", password: 'changeme', port: 3000,
  youtubeApiKey: '', maxDjs: 5, lameSkipFraction: 0.5,
  ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')),
};
const PORT = Number(process.env.PORT) || config.port;

const SECRET_PATH = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(SECRET_PATH)) fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(SECRET_PATH, 'utf8').trim();

const CATS = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'cats', 'cats.json'), 'utf8'));
const CAT_IDS = new Set(CATS.cats.map((c) => c.id));

// ------------------------------------------------------------------ storage
const DB_PATH = path.join(DATA_DIR, 'db.json');
const db = { users: {}, queues: {}, history: [], chat: [] };
if (fs.existsSync(DB_PATH)) {
  try { Object.assign(db, JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))); } catch (e) {
    console.error('Could not read data/db.json, starting fresh:', e.message);
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_PATH);
  }, 800);
}

const newId = () => crypto.randomBytes(8).toString('hex');
const queueOf = (uid) => (db.queues[uid] ||= []);
const publicUser = (u) => u && { id: u.id, name: u.name, cat: u.cat, points: u.points || 0 };

// ------------------------------------------------------------------ sessions
const COOKIE = 'nb_session';
const sign = (uid) => uid + '.' + crypto.createHmac('sha256', SECRET).update(uid).digest('base64url');
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const uid = token.split('.')[0];
  const good = sign(uid);
  if (good.length !== token.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(token))) return null;
  return db.users[uid] || null;
}
function readCookie(header) {
  const m = (header || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}
function passwordOk(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(String(config.password)).digest();
  return crypto.timingSafeEqual(a, b);
}
function cleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// Login throttle: 8 wrong passwords per IP per 10 minutes.
const failures = new Map();
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';

// ------------------------------------------------------------------ http
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/api/me', (req, res) => {
  const user = verify(readCookie(req.headers.cookie));
  res.json({ siteName: config.siteName, user: publicUser(user), cats: CATS.cats, sprites: CATS, hasApiKey: !!config.youtubeApiKey });
});

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && rec.count >= 8 && now - rec.first < 10 * 60e3) {
    return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  }
  const { password, name, cat } = req.body || {};
  if (!passwordOk(password)) {
    const r = rec && now - rec.first < 10 * 60e3 ? rec : { count: 0, first: now };
    r.count++;
    failures.set(ip, r);
    return res.status(401).json({ error: "That's not the password." });
  }
  failures.delete(ip);
  const clean = cleanName(name);
  if (!clean) return res.status(400).json({ error: 'Pick a username.' });
  const chosenCat = CAT_IDS.has(cat) ? cat : CATS.cats[0].id;
  // No accounts: the same name on a new device picks up that person's queue and points.
  let user = Object.values(db.users).find((u) => u.name.toLowerCase() === clean.toLowerCase());
  if (!user) {
    user = { id: newId(), name: clean, cat: chosenCat, points: 0, createdAt: now };
    db.users[user.id] = user;
  } else {
    user.cat = chosenCat;
  }
  save();
  res.cookie(COOKIE, sign(user.id), { httpOnly: true, sameSite: 'lax', maxAge: 365 * 864e5, path: '/' });
  pushUsers();
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

// ------------------------------------------------------------------ room state
const room = {
  djs: [],        // user ids in seat order
  turn: 0,        // index of the next DJ to play
  current: null,  // { song, djId, startedAt, duration, votes: Map, snags: Set }
  online: new Map(), // userId -> socket count
};
let endTimer = null;
const offlineTimers = new Map();
const LEAD_MS = 1500; // give every player a moment to load before the clock starts

function system(text) {
  const msg = { id: newId(), type: 'system', text, ts: Date.now() };
  db.chat.push(msg);
  if (db.chat.length > 150) db.chat.splice(0, db.chat.length - 150);
  io.emit('chat', msg);
  save();
}

function roomPayload() {
  const c = room.current;
  return {
    serverNow: Date.now(),
    maxDjs: config.maxDjs,
    djs: room.djs,
    listeners: [...room.online.keys()],
    current: c && {
      song: c.song,
      djId: c.djId,
      startedAt: c.startedAt,
      duration: c.duration,
      awesomes: [...c.votes].filter(([, v]) => v > 0).map(([k]) => k),
      lames: [...c.votes].filter(([, v]) => v < 0).map(([k]) => k),
      snags: [...c.snags],
    },
  };
}
const pushRoom = () => io.emit('room', roomPayload());
const pushUsers = () => io.emit('users', Object.values(db.users).map(publicUser));
const pushQueue = (uid) => io.to('u:' + uid).emit('queue', queueOf(uid));
const pushHistory = () => io.emit('history', db.history.slice(-100));

function removeDj(uid) {
  const i = room.djs.indexOf(uid);
  if (i === -1) return false;
  room.djs.splice(i, 1);
  if (i < room.turn) room.turn--;
  return true;
}

function finishCurrent() {
  const c = room.current;
  if (!c) return;
  const awesomes = [...c.votes.values()].filter((v) => v > 0).length;
  const lames = [...c.votes.values()].filter((v) => v < 0).length;
  const dj = db.users[c.djId];
  if (dj) dj.points = (dj.points || 0) + awesomes;
  db.history.push({
    id: newId(), videoId: c.song.videoId, title: c.song.title, channel: c.song.channel,
    thumb: c.song.thumb, djId: c.djId, djName: dj ? dj.name : '?',
    awesomes, lames, snags: c.snags.size, playedAt: c.startedAt,
  });
  if (db.history.length > 500) db.history.splice(0, db.history.length - 500);
  room.current = null;
  pushHistory();
  pushUsers();
  save();
}

function playNext() {
  clearTimeout(endTimer);
  finishCurrent();
  while (room.djs.length) {
    room.turn %= room.djs.length;
    const djId = room.djs[room.turn];
    const q = queueOf(djId);
    const idx = q.findIndex((s) => !s.blocked);
    if (idx === -1) {
      removeDj(djId);
      system(`${db.users[djId]?.name || 'A DJ'} ran out of songs and stepped down.`);
      continue;
    }
    // Turntable rule: the song you play goes to the bottom of your queue.
    const [song] = q.splice(idx, 1);
    q.push(song);
    pushQueue(djId);
    // Don't wrap here: if someone joins the booth before the next song, they're next in line.
    room.turn = room.turn + 1;
    room.current = {
      song, djId, startedAt: Date.now() + LEAD_MS,
      duration: song.duration || 0, votes: new Map(), snags: new Set(),
    };
    scheduleEnd();
    pushRoom();
    save();
    return;
  }
  room.current = null;
  pushRoom();
}

function scheduleEnd() {
  clearTimeout(endTimer);
  const c = room.current;
  if (!c || !c.duration) return;
  const ms = c.startedAt + c.duration * 1000 + 1500 - Date.now();
  endTimer = setTimeout(playNext, Math.max(1000, ms));
}

function checkLameSkip() {
  const c = room.current;
  if (!c) return;
  const votes = [...c.votes.values()];
  const lames = votes.filter((v) => v < 0).length;
  const awesomes = votes.filter((v) => v > 0).length;
  const audience = [...room.online.keys()].filter((id) => id !== c.djId).length;
  const needed = Math.max(2, Math.ceil(audience * config.lameSkipFraction));
  if (lames >= needed && lames > awesomes) {
    system(`"${c.song.title}" got lamed off the decks.`);
    playNext();
  }
}

// ------------------------------------------------------------------ sockets
io.use((socket, next) => {
  const user = verify(readCookie(socket.handshake.headers.cookie));
  if (!user) return next(new Error('unauthorized'));
  socket.data.uid = user.id;
  next();
});

function rateLimit(socket, key, max, windowMs) {
  const now = Date.now();
  const bucket = (socket.data[key] ||= []);
  while (bucket.length && now - bucket[0] > windowMs) bucket.shift();
  if (bucket.length >= max) return false;
  bucket.push(now);
  return true;
}

io.on('connection', (socket) => {
  const uid = socket.data.uid;
  const me = () => db.users[uid];
  socket.join('u:' + uid);

  clearTimeout(offlineTimers.get(uid));
  offlineTimers.delete(uid);
  const wasOnline = room.online.has(uid);
  room.online.set(uid, (room.online.get(uid) || 0) + 1);

  socket.emit('init', {
    me: publicUser(me()),
    users: Object.values(db.users).map(publicUser),
    queue: queueOf(uid),
    history: db.history.slice(-100),
    chat: db.chat.slice(-100),
    room: roomPayload(),
  });
  if (!wasOnline) {
    pushRoom();
    system(`${me().name} joined.`);
  }

  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);
  const fail = (ack, e) => {
    if (!e.userFacing) console.error(e);
    reply(ack, { error: e.userFacing ? e.message : 'Something went wrong talking to YouTube. Try again in a moment.' });
  };

  socket.on('clock', (ack) => reply(ack, Date.now()));

  // ---- chat
  socket.on('chat', (text) => {
    const clean = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500);
    if (!clean || !rateLimit(socket, 'chatRate', 6, 5000)) return;
    const u = me();
    const msg = { id: newId(), type: 'user', userId: uid, name: u.name, cat: u.cat, text: clean, ts: Date.now() };
    db.chat.push(msg);
    if (db.chat.length > 150) db.chat.splice(0, db.chat.length - 150);
    io.emit('chat', msg);
    save();
  });

  // ---- profile
  socket.on('profile', ({ cat } = {}, ack) => {
    if (!CAT_IDS.has(cat)) return reply(ack, { error: 'Unknown cat.' });
    me().cat = cat;
    save();
    pushUsers();
    reply(ack, { ok: true });
  });

  // ---- queue
  socket.on('queue:add', async ({ url, mode = 'auto', song } = {}, ack) => {
    if (!rateLimit(socket, 'addRate', 10, 10000)) return reply(ack, { error: 'Slow down a little.' });
    try {
      const q = queueOf(uid);
      let songs;
      if (song && song.videoId) {
        songs = [await yt.lookupVideo(song.videoId, config.youtubeApiKey)];
      } else {
        const { videoId, playlistId } = yt.parseUrl(url);
        const wantList = playlistId && (mode === 'playlist' || (mode === 'auto' && !videoId));
        if (wantList) songs = await yt.importPlaylist(playlistId, config.youtubeApiKey);
        else if (videoId) songs = [await yt.lookupVideo(videoId, config.youtubeApiKey)];
        else throw yt.userError("That doesn't look like a YouTube link.");
      }
      const have = new Set(q.map((s) => s.videoId));
      let added = 0;
      let blocked = 0;
      for (const s of songs) {
        if (have.has(s.videoId)) continue;
        if (!s.embeddable) { blocked++; continue; }
        have.add(s.videoId);
        q.push({ id: newId(), videoId: s.videoId, title: s.title, channel: s.channel, duration: s.duration, thumb: s.thumb, addedAt: Date.now() });
        added++;
      }
      if (q.length > 1000) q.splice(0, q.length - 1000);
      save();
      pushQueue(uid);
      reply(ack, { added, blocked, skipped: songs.length - added - blocked });
    } catch (e) {
      fail(ack, e);
    }
  });

  socket.on('search', async (q, ack) => {
    if (!rateLimit(socket, 'searchRate', 5, 10000)) return reply(ack, { error: 'Slow down a little.' });
    try {
      reply(ack, { results: (await yt.search(String(q || '').slice(0, 100), config.youtubeApiKey)).filter((s) => s.embeddable) });
    } catch (e) {
      fail(ack, e);
    }
  });

  socket.on('queue:remove', (id) => {
    const q = queueOf(uid);
    const i = q.findIndex((s) => s.id === id);
    if (i !== -1) { q.splice(i, 1); save(); pushQueue(uid); }
  });

  socket.on('queue:move', ({ id, to } = {}) => {
    const q = queueOf(uid);
    const i = q.findIndex((s) => s.id === id);
    if (i === -1) return;
    const [s] = q.splice(i, 1);
    let j = i;
    if (to === 'top') j = 0;
    else if (to === 'bottom') j = q.length;
    else if (to === 'up') j = Math.max(0, i - 1);
    else if (to === 'down') j = Math.min(q.length, i + 1);
    else if (Number.isInteger(to)) j = Math.max(0, Math.min(q.length, to));
    q.splice(j, 0, s);
    save();
    pushQueue(uid);
  });

  socket.on('queue:clear', () => { db.queues[uid] = []; save(); pushQueue(uid); });

  socket.on('queue:shuffle', () => {
    const q = queueOf(uid);
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    save();
    pushQueue(uid);
  });

  // ---- decks
  socket.on('dj:up', (ack) => {
    if (room.djs.includes(uid)) return reply(ack, { ok: true });
    if (room.djs.length >= config.maxDjs) return reply(ack, { error: 'All the DJ seats are taken.' });
    if (!queueOf(uid).some((s) => !s.blocked)) return reply(ack, { error: 'Add some songs to your queue first.' });
    room.djs.push(uid);
    system(`${me().name} stepped up to the decks.`);
    if (!room.current) playNext();
    else pushRoom();
    reply(ack, { ok: true });
  });

  socket.on('dj:down', () => {
    const wasPlaying = room.current && room.current.djId === uid;
    if (!removeDj(uid)) return;
    system(`${me().name} stepped down.`);
    if (wasPlaying) playNext();
    else pushRoom();
  });

  socket.on('skip', () => {
    if (room.current && room.current.djId === uid) playNext();
  });

  // ---- reactions
  socket.on('vote', (v) => {
    const c = room.current;
    if (!c || c.djId === uid || Date.now() < c.startedAt) return;
    const val = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (val === 0) c.votes.delete(uid);
    else c.votes.set(uid, val);
    pushRoom();
    if (val < 0) checkLameSkip();
  });

  socket.on('snag', (ack) => {
    const c = room.current;
    if (!c) return reply(ack, { error: 'Nothing is playing.' });
    const q = queueOf(uid);
    if (!q.some((s) => s.videoId === c.song.videoId)) {
      const s = c.song;
      q.push({ id: newId(), videoId: s.videoId, title: s.title, channel: s.channel, duration: s.duration, thumb: s.thumb, addedAt: Date.now() });
      save();
      pushQueue(uid);
    }
    if (c.djId !== uid) c.snags.add(uid);
    pushRoom();
    reply(ack, { ok: true });
  });

  // ---- player reports (fill gaps when there's no API key, and handle embed blocks)
  socket.on('player:duration', ({ videoId, seconds } = {}) => {
    const c = room.current;
    const secs = Math.round(Number(seconds));
    if (!c || c.song.videoId !== videoId || c.duration || !(secs > 0 && secs < 6 * 3600)) return;
    c.duration = secs;
    c.song.duration = secs;
    for (const q of Object.values(db.queues)) for (const s of q) if (s.videoId === videoId) s.duration = secs;
    scheduleEnd();
    pushRoom();
    save();
  });

  socket.on('player:title', ({ videoId, title } = {}) => {
    const c = room.current;
    const t = String(title || '').slice(0, 200).trim();
    if (!c || c.song.videoId !== videoId || !t || !/^YouTube video /.test(c.song.title)) return;
    c.song.title = t;
    for (const q of Object.values(db.queues)) for (const s of q) if (s.videoId === videoId) s.title = t;
    pushRoom();
    save();
  });

  socket.on('player:ended', ({ videoId } = {}) => {
    const c = room.current;
    if (!c || c.song.videoId !== videoId) return;
    const elapsed = (Date.now() - c.startedAt) / 1000;
    if (elapsed > 5 && (!c.duration || elapsed > c.duration - 6)) playNext();
  });

  socket.on('player:blocked', ({ videoId } = {}) => {
    const c = room.current;
    if (!c || c.song.videoId !== videoId) return;
    for (const s of queueOf(c.djId)) if (s.videoId === videoId) s.blocked = true;
    pushQueue(c.djId);
    system(`"${c.song.title}" can't be played outside YouTube, so it was skipped.`);
    room.current = null; // don't log it in history
    playNext();
  });

  socket.on('disconnect', () => {
    const n = (room.online.get(uid) || 1) - 1;
    if (n > 0) return room.online.set(uid, n);
    room.online.delete(uid);
    pushRoom();
    // Give people a minute to reconnect before taking their DJ seat away.
    offlineTimers.set(uid, setTimeout(() => {
      offlineTimers.delete(uid);
      if (room.online.has(uid)) return;
      const u = db.users[uid];
      const wasPlaying = room.current && room.current.djId === uid;
      if (removeDj(uid)) {
        system(`${u ? u.name : 'A DJ'} left the decks.`);
        if (wasPlaying) playNext();
        else pushRoom();
      }
      if (u) system(`${u.name} left.`);
    }, 60e3));
  });
});

server.listen(PORT, () => {
  console.log(`\n  ${config.siteName} is running at http://localhost:${PORT}\n`);
  if (config.password === 'changeme') {
    console.log('  WARNING: the password is still "changeme". Edit config.json and restart.\n');
  }
  if (!config.youtubeApiKey) {
    console.log('  Tip: add a YouTube API key to config.json to enable playlist import and search.\n');
  }
});

function shutdown() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
