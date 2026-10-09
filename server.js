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
  youtubeApiKey: '', maxDjs: 5, lameSkipFraction: 0.5, crowd: 24, bpmApiKey: '',
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
// tempos: videoId -> { bpm, offset (ms from the song's start to a beat, or null), source, at }
const db = { users: {}, queues: {}, history: [], chat: [], playlists: [], tempos: {} };
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

const MAX_QUEUE = 2000; // songs per queue (big imported playlists fit)
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
// Invite links carry a code derived from the password, so changing the
// password in config.json also retires every old invite link.
const INVITE_CODE = crypto.createHmac('sha256', SECRET).update('invite:' + config.password).digest('base64url').slice(0, 16);
function inviteOk(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(INVITE_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// share.bat logs cloudflared's output here; the newest quick-tunnel address in it
// is the room's public link (checked live before we hand it out).
const TUNNEL_LOG = path.join(DATA_DIR, 'tunnel.log');
async function publicUrl() {
  let text = '';
  try { text = fs.readFileSync(TUNNEL_LOG, 'utf8'); } catch { return null; }
  const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  if (!found) return null;
  const url = found[found.length - 1];
  try {
    const res = await fetch(url + '/api/me', { signal: AbortSignal.timeout(5000) });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

function cleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}
function playlistName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()
    .slice(0, 60).replace(/[\s\-–—|:,·]+$/, '');
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
  res.json({
    siteName: config.siteName, user: publicUser(user), cats: CATS.cats, sprites: CATS, hasApiKey: !!config.youtubeApiKey,
    crowd: Math.max(0, Math.min(40, Number(config.crowd) || 0)), // NPC cats on the dance floor
  });
});

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && rec.count >= 8 && now - rec.first < 10 * 60e3) {
    return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  }
  const { password, invite, name, cat } = req.body || {};
  if (!(invite ? inviteOk(invite) : passwordOk(password))) {
    const r = rec && now - rec.first < 10 * 60e3 ? rec : { count: 0, first: now };
    r.count++;
    failures.set(ip, r);
    return res.status(401).json(invite
      ? { error: 'That invite link is out of date. Ask for a new one, or type the password.', badInvite: true }
      : { error: "That's not the password." });
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

// Anyone already in the room can hand out the invite link.
app.get('/api/invite', async (req, res) => {
  if (!verify(readCookie(req.headers.cookie))) return res.status(401).json({ error: 'Log in first.' });
  res.json({ code: INVITE_CODE, publicUrl: await publicUrl() });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// No max-age: browsers revalidate (cheap 304s via ETag), so updates reach everyone on the next load.
app.use(express.static(path.join(ROOT, 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

// ------------------------------------------------------------------ room state
const room = {
  djs: [],        // user ids in turn order (the order they sat down)
  seats: [],      // seat index -> user id or null: where each DJ sits at the booth
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
    seats: Array.from({ length: config.maxDjs }, (_, i) => room.seats[i] || null),
    listeners: [...room.online.keys()],
    current: c && {
      song: c.song,
      djId: c.djId,
      startedAt: c.startedAt,
      duration: c.duration,
      awesomes: [...c.votes].filter(([, v]) => v > 0).map(([k]) => k),
      lames: [...c.votes].filter(([, v]) => v < 0).map(([k]) => k),
      snags: [...c.snags],
      beat: c.beat || null,
    },
  };
}

// ------------------------------------------------------------------ tempo
// Each song's beat is stored by video: bpm plus, once someone has tapped
// along, the offset (ms into the song) of a beat. Offsets are in song time,
// the position in the video, so they hold every time the song plays.
function beatFor(song) {
  const t = db.tempos[song.videoId];
  if (!t || !t.bpm) return null;
  return { bpm: t.bpm, offset: t.offset ?? null, source: t.source };
}

// "Artist - Title (Official Video)" -> { artist, title } for the BPM lookup.
function songQuery(song) {
  let title = String(song.title || '');
  let artist = String(song.channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) { artist = dash[1]; title = dash[2]; }
  title = title.split(/\s+[-–—|]\s+/)[0]; // drop extra " - 45", " - Remastered", " | Lyrics" parts
  title = title.replace(/[([][^)\]]*[)\]]/g, '').replace(/\b(ft\.?|feat\.?|featuring)\s.*$/i, '').replace(/["“”]/g, '').trim();
  artist = artist.replace(/\s*(,|&|\bx\b|ft\.?|feat\.?).*$/i, '').trim();
  return { title, artist };
}

// GetSongBPM (free key, https://getsongbpm.com/api). The older api.getsongbpm.com
// host sits behind a bot check, so only the current one is used.
// Returns the bpm, null if the service doesn't know the song, or undefined if
// it couldn't be asked (bad or inactive key, network trouble) so it's retried.
const BPM_HOSTS = ['https://api.getsong.co'];
async function fetchBpm(title, artist, key) {
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'X-API-KEY': key } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  };
  const fit = (n) => (n >= 40 && n <= 250 ? n : null);
  for (const host of BPM_HOSTS) {
    try {
      const k = encodeURIComponent(key);
      // Title + artist first; then title alone, but only trusting hits by the same artist.
      const tries = artist ? [['both', `song:${title} artist:${artist}`], ['song', title]] : [['song', title]];
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const sameArtist = (hit) => {
        const a = norm(hit.artist && hit.artist.name);
        const b = norm(artist);
        return !b || (a && (a.includes(b) || b.includes(a)));
      };
      for (const [type, lookup] of tries) {
        const data = await get(`${host}/search/?api_key=${k}&type=${type}&lookup=${encodeURIComponent(lookup)}`);
        const hits = (Array.isArray(data.search) ? data.search : []).filter((h) => type === 'both' || sameArtist(h));
        for (const hit of hits.slice(0, 5)) {
          let bpm = fit(Number(hit.tempo));
          if (!bpm && hit.id) {
            const song = await get(`${host}/song/?api_key=${k}&id=${encodeURIComponent(hit.id)}`);
            bpm = fit(Number(song.song && song.song.tempo));
          }
          if (bpm) return bpm;
        }
      }
      return null; // the service answered; it just doesn't know this song
    } catch (e) {
      console.error(`BPM lookup via ${host} failed:`, e.message);
    }
  }
  return undefined;
}

const lookingUp = new Set();
async function lookupTempo(song) {
  const known = db.tempos[song.videoId];
  if (!config.bpmApiKey || lookingUp.has(song.videoId)) return;
  if (known && (known.bpm || Date.now() - known.at < 7 * 864e5)) return; // misses retry after a week
  lookingUp.add(song.videoId);
  try {
    const { title, artist } = songQuery(song);
    if (!title) return;
    const bpm = await fetchBpm(title, artist, config.bpmApiKey);
    if (bpm === undefined) return; // couldn't ask; try again next time the song plays
    if (db.tempos[song.videoId] && db.tempos[song.videoId].source === 'tap') return; // a tap beat us to it
    db.tempos[song.videoId] = bpm ? { bpm, offset: null, source: 'lookup', at: Date.now() } : { bpm: null, at: Date.now() };
    save();
    const c = room.current;
    if (bpm && c && c.song.videoId === song.videoId && !c.beat) {
      c.beat = beatFor(song);
      pushRoom();
    }
  } finally {
    lookingUp.delete(song.videoId);
  }
}
const pushRoom = () => io.emit('room', roomPayload());
const pushUsers = () => io.emit('users', Object.values(db.users).map(publicUser));
const pushQueue = (uid) => io.to('u:' + uid).emit('queue', queueOf(uid));
const pushHistory = () => io.emit('history', db.history.slice(-100));
// Saved playlists are shared with the whole room; only the songs' summary goes out.
const playlistSummaries = () => db.playlists.map((p) => ({
  id: p.id, name: p.name, ownerId: p.ownerId, count: p.songs.length,
  duration: p.songs.reduce((t, s) => t + (s.duration || 0), 0),
}));
const pushPlaylists = () => io.emit('playlists', playlistSummaries());
const copySong = (s) => ({
  id: newId(), videoId: s.videoId, title: s.title, channel: s.channel, duration: s.duration,
  thumb: s.thumb, addedAt: Date.now(), ...(s.blocked ? { blocked: true } : {}),
});

function removeDj(uid) {
  const i = room.djs.indexOf(uid);
  if (i === -1) return false;
  room.djs.splice(i, 1);
  if (i < room.turn) room.turn--;
  const s = room.seats.indexOf(uid);
  if (s !== -1) room.seats[s] = null;
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
    // Only songs that haven't played yet; a DJ who has played everything steps down.
    const idx = db.users[djId]?.shuffle ? shufflePick(q) : q.findIndex(playable);
    if (idx === -1) {
      removeDj(djId);
      system(`${db.users[djId]?.name || 'A DJ'} played every song in their queue and left the decks.`);
      continue;
    }
    // Turntable rule: the song you play goes to the bottom of your queue, marked played.
    const [song] = q.splice(idx, 1);
    song.played = true;
    song.lastPlayed = Date.now();
    q.push(song);
    pushQueue(djId);
    // Don't wrap here: if someone joins the booth before the next song, they're next in line.
    room.turn = room.turn + 1;
    room.current = {
      song, djId, startedAt: Date.now() + LEAD_MS,
      duration: song.duration || 0, votes: new Map(), snags: new Set(),
      beat: beatFor(song),
    };
    lookupTempo(song).catch((e) => console.error('BPM lookup:', e.message));
    scheduleEnd();
    pushRoom();
    save();
    return;
  }
  room.current = null;
  pushRoom();
}

const playable = (s) => !s.blocked && !s.played;

// Shuffle play: a random pick from the songs that haven't played yet.
function shufflePick(q) {
  const ok = q.map((s, i) => [s, i]).filter(([s]) => playable(s));
  if (!ok.length) return -1;
  return ok[Math.floor(Math.random() * ok.length)][1];
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
    shuffle: !!me().shuffle,
    playlists: playlistSummaries(),
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

  // ---- beat: someone taps along; positions are ms into the song on their player
  socket.on('beat:tap', ({ videoId, positions } = {}, ack) => {
    const c = room.current;
    if (!c || c.song.videoId !== videoId) return reply(ack, { error: 'That song already ended.' });
    if (!rateLimit(socket, 'tapRate', 4, 4000)) return reply(ack, { error: 'Slow down a little.' });
    const t = (Array.isArray(positions) ? positions : []).map(Number).filter(Number.isFinite).slice(-16);
    if (t.length < 4 || t.some((x, i) => i && x <= t[i - 1])) return reply(ack, { error: 'Tap at least 4 times in a row.' });
    // Fit a straight line through the taps: position = a + i * beatMs.
    const n = t.length;
    const mi = (n - 1) / 2;
    const mt = t.reduce((s, x) => s + x, 0) / n;
    let num = 0;
    let den = 0;
    t.forEach((x, i) => { num += (i - mi) * (x - mt); den += (i - mi) ** 2; });
    const beatMs = num / den;
    const a = mt - beatMs * mi;
    if (!(beatMs >= 240 && beatMs <= 1500)) return reply(ack, { error: "That's too fast or too slow to be the beat." });
    if (t.some((x, i) => Math.abs(x - (a + beatMs * i)) > beatMs * 0.3)) return reply(ack, { error: 'Those taps were a bit uneven. Try again.' });
    const bpm = Math.round(6000000 / beatMs) / 100;
    const offset = Math.round((((a % beatMs) + beatMs) % beatMs));
    db.tempos[videoId] = { bpm, offset, source: 'tap', at: Date.now(), by: uid };
    c.beat = beatFor(c.song);
    save();
    pushRoom();
    reply(ack, { bpm });
  });

  // ---- emotes: make your avatar do a move or a reaction for everyone to see
  const EMOTES = new Set(['cheer', 'jump', 'clap', 'disco', 'robot', 'wave', 'twist', 'roof', 'boo']);
  socket.on('emote', (clip) => {
    if (!EMOTES.has(clip) || !rateLimit(socket, 'emoteRate', 3, 4000)) return;
    io.emit('emote', { userId: uid, clip });
  });

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
        if (have.has(s.videoId)) {
          // Re-adding a song that already played queues it up to play again.
          const old = q.find((x) => x.videoId === s.videoId && x.played);
          if (old) { delete old.played; added++; }
          continue;
        }
        if (!s.embeddable) { blocked++; continue; }
        have.add(s.videoId);
        q.push({ id: newId(), videoId: s.videoId, title: s.title, channel: s.channel, duration: s.duration, thumb: s.thumb, addedAt: Date.now() });
        added++;
      }
      if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
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

  // Batch edits from a multi-select in the queue.
  const idSet = (ids) => new Set(Array.isArray(ids) ? ids.slice(0, MAX_QUEUE).map(String) : []);
  socket.on('queue:removeMany', (ids) => {
    const drop = idSet(ids);
    const q = queueOf(uid);
    const keep = q.filter((s) => !drop.has(s.id));
    if (keep.length === q.length) return;
    q.splice(0, q.length, ...keep);
    save();
    pushQueue(uid);
  });

  // Moves the chosen songs, in their current order, to the top, the bottom, or
  // just before another song.
  socket.on('queue:moveMany', ({ ids, to, before } = {}) => {
    const pick = idSet(ids);
    const q = queueOf(uid);
    const moved = q.filter((s) => pick.has(s.id));
    if (!moved.length) return;
    const rest = q.filter((s) => !pick.has(s.id));
    let at = rest.length;
    if (to === 'top') at = 0;
    else if (before) {
      const i = rest.findIndex((s) => s.id === before);
      if (i !== -1) at = i;
    }
    rest.splice(at, 0, ...moved);
    q.splice(0, q.length, ...rest);
    save();
    pushQueue(uid);
  });

  socket.on('queue:clear', () => { db.queues[uid] = []; save(); pushQueue(uid); });

  socket.on('queue:replayAll', () => {
    for (const s of queueOf(uid)) delete s.played;
    save();
    pushQueue(uid);
  });

  socket.on('queue:shufflePlay',(on, ack) => {
    me().shuffle = !!on;
    save();
    reply(ack, { shuffle: me().shuffle });
  });

  socket.on('queue:shuffle', () => {
    const q = queueOf(uid);
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    save();
    pushQueue(uid);
  });

  // ---- saved playlists
  socket.on('playlist:save', ({ name } = {}, ack) => {
    const clean = playlistName(name) || 'Untitled';
    const q = queueOf(uid);
    if (!q.length) return reply(ack, { error: 'Your queue is empty, so there is nothing to save.' });
    // Saving under a name you already used updates that playlist.
    let p = db.playlists.find((x) => x.ownerId === uid && x.name.toLowerCase() === clean.toLowerCase());
    if (!p) {
      if (db.playlists.filter((x) => x.ownerId === uid).length >= 50) return reply(ack, { error: 'You have 50 playlists already. Delete one first.' });
      p = { id: newId(), name: clean, ownerId: uid, createdAt: Date.now() };
      db.playlists.push(p);
    }
    p.songs = q.map(copySong);
    p.updatedAt = Date.now();
    save();
    pushPlaylists();
    reply(ack, { ok: true, id: p.id, name: p.name, count: p.songs.length });
  });

  // Import a YouTube playlist as a saved playlist. Without an API key the browser
  // reads the video ids through the YouTube player and sends them along.
  socket.on('playlist:import', async ({ playlistId, ids } = {}, ack) => {
    if (!rateLimit(socket, 'importRate', 3, 30000)) return reply(ack, { error: 'Slow down a little.' });
    try {
      if (!/^[A-Za-z0-9_-]{10,64}$/.test(String(playlistId || ''))) throw yt.userError("That doesn't look like a YouTube playlist link.");
      const key = config.youtubeApiKey;
      const [found, title] = await Promise.all([
        Array.isArray(ids) ? yt.lookupMany(ids.slice(0, 300).map(String), key) : yt.importPlaylist(playlistId, key),
        yt.playlistTitle(playlistId, key),
      ]);
      const seen = new Set();
      const songs = found.filter((s) => s.embeddable && !seen.has(s.videoId) && seen.add(s.videoId));
      if (!songs.length) throw yt.userError("Couldn't read any playable songs from that playlist.");
      const name = playlistName(title) || 'YouTube playlist';
      // Importing the same YouTube playlist again refreshes your copy.
      let p = db.playlists.find((x) => x.ownerId === uid && x.source === playlistId);
      if (!p) {
        if (db.playlists.filter((x) => x.ownerId === uid).length >= 50) throw yt.userError('You have 50 playlists already. Delete one first.');
        p = { id: newId(), ownerId: uid, source: playlistId, createdAt: Date.now() };
        db.playlists.push(p);
      }
      p.name = name;
      p.songs = songs.map(copySong);
      p.updatedAt = Date.now();
      save();
      pushPlaylists();
      reply(ack, { ok: true, id: p.id, name: p.name, count: p.songs.length, blocked: found.length - songs.length });
    } catch (e) {
      fail(ack, e);
    }
  });

  socket.on('playlist:load',({ id, mode } = {}, ack) => {
    const p = db.playlists.find((x) => x.id === id);
    if (!p) return reply(ack, { error: 'That playlist is gone.' });
    const songs = p.songs.map(copySong);
    if (mode === 'append') {
      const q = queueOf(uid);
      const have = new Set(q.map((s) => s.videoId));
      const fresh = songs.filter((s) => !have.has(s.videoId));
      q.push(...fresh);
      if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
      reply(ack, { ok: true, added: fresh.length });
    } else {
      db.queues[uid] = songs;
      reply(ack, { ok: true, added: songs.length });
    }
    save();
    pushQueue(uid);
  });

  // Anyone in the room can tidy up playlists; chat says who removed what.
  socket.on('playlist:delete', (id, ack) => {
    const i = db.playlists.findIndex((x) => x.id === id);
    if (i === -1) return reply(ack, { error: 'That playlist is already gone.' });
    const [p] = db.playlists.splice(i, 1);
    save();
    pushPlaylists();
    if (p.ownerId !== uid) system(`${me().name} removed the playlist "${p.name}" (saved by ${db.users[p.ownerId]?.name || 'someone'}).`);
    reply(ack, { ok: true });
  });

  // ---- decks
  // Take a seat: the one clicked if it's free, else the first free one. Turns
  // go in the order people sat down, whichever seat they picked.
  socket.on('dj:up', (seat, ack) => {
    if (typeof seat === 'function') { ack = seat; seat = null; }
    if (room.djs.includes(uid)) return reply(ack, { ok: true });
    if (room.djs.length >= config.maxDjs) return reply(ack, { error: 'All the DJ seats are taken.' });
    const q = queueOf(uid);
    if (!q.some(playable)) {
      return reply(ack, { error: q.some((s) => s.played && !s.blocked)
        ? 'Every song in your queue has played. Add new songs, load a playlist, or press "Replay all".'
        : 'Add some songs to your queue first.' });
    }
    const free = (i) => Number.isInteger(i) && i >= 0 && i < config.maxDjs && !room.seats[i];
    let at = free(seat) ? seat : -1;
    for (let i = 0; at === -1 && i < config.maxDjs; i++) if (free(i)) at = i;
    if (at === -1) return reply(ack, { error: 'All the DJ seats are taken.' });
    room.seats[at] = uid;
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
