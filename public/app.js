/* God's Noisey BoyZ client */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const hash = (str) => { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

  // ------------------------------------------------------------ state
  let CATS = [];
  let hasApiKey = false;
  let me = null;
  let socket = null;
  let clockOffset = 0;
  const users = new Map();
  let room = null;
  let queue = [];
  let history = [];
  let playlists = [];
  let lastSongKey; // undefined until the first room update, so joining never fires an alert
  const serverNow = () => Date.now() + clockOffset;
  const userName = (id) => (users.get(id) || {}).name || 'Someone';
  const userCat = (id) => (users.get(id) || {}).cat || (CATS[0] && CATS[0].id);

  // ------------------------------------------------------------ cat sprites
  // Atlases and clips are described by cats/cats.json; dance.js picks the frames.
  // mode: dance | groove | chill | still. seed: whose dance sequence (user id).
  // anchor: server time the sequence starts from (the current song's start).
  function catNode(catId, { size = 'md', mode = 'still', seed, anchor = 0 } = {}) {
    const n = el('span', 'cat cat-' + size);
    setCat(n, catId, { mode, seed, anchor });
    return n;
  }
  function setCat(n, catId, { mode = 'still', seed, anchor = 0 } = {}) {
    n.style.backgroundImage = `url(cats/${catId}.png?v=${SPRITE_VERSION})`;
    n.setAttribute('role', 'img');
    const cat = CATS.find((c) => c.id === catId);
    n.setAttribute('aria-label', cat ? cat.name : 'cat');
    Dance.attach(n, { skin: catId, mode, seed, anchor });
  }
  const SPRITE_VERSION = 5;

  // The NPC crowd is the same for everyone: skins and spots come from fixed seeds.
  let npcs = [];
  function makeNpcs(count) {
    return Array.from({ length: count }, (_, i) => {
      const rand = Dance.seedRand('npc:' + i);
      return { id: 'npc:' + i, skin: CATS[Math.floor(rand() * CATS.length)].id, row: 2 + (i % 2), jitter: (rand() - 0.5) * 3 };
    });
  }

  function catGrid(container, selected, onPick) {
    container.replaceChildren();
    for (const c of CATS) {
      const b = el('button', 'cat-option');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === selected));
      b.title = c.dance ? `${c.blurb}. Signature move: ${c.dance}.` : c.blurb;
      b.append(catNode(c.id, { size: 'sm', mode: c.id === selected ? 'dance' : 'chill', seed: 'pick:' + c.id }), el('span', '', c.name));
      b.addEventListener('click', () => {
        for (const o of container.children) {
          const on = o === b;
          o.setAttribute('aria-checked', String(on));
          o.querySelector('.cat').dataset.mode = on ? 'dance' : 'chill';
        }
        Dance.react('pick:' + c.id, 'jump', 700);
        onPick(c.id);
      });
      container.append(b);
    }
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    const info = await res.json();
    CATS = info.cats;
    npcs = makeNpcs(info.crowd || 0);
    Dance.init(info.sprites);
    Dance.now = serverNow; // everyone's dancing runs on the server's clock
    hasApiKey = info.hasApiKey;
    document.title = info.siteName;
    for (const n of document.querySelectorAll('[data-site-name]')) n.textContent = info.siteName;
    if (info.user) enterRoom(info.user);
    else showDoor();
  }

  function showDoor() {
    $('#room').hidden = true;
    $('#gate').hidden = true;
    $('#door').hidden = false;
    let picked = store.get('nb_cat', CATS[0].id);
    if (!CATS.some((c) => c.id === picked)) picked = CATS[0].id;
    catGrid($('#door-cats'), picked, (id) => { picked = id; });
    $('#door-name').value = store.get('nb_name', '');
    // An invite link (?invite=...) stands in for the password.
    let invite = new URLSearchParams(location.search).get('invite');
    const showPassword = (on) => {
      $('#door-invited').hidden = on;
      $('#door-password-field').hidden = !on;
      $('#door-password').required = on;
    };
    showPassword(!invite);
    const form = $('#door-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      $('#door-error').textContent = '';
      const body = { name: $('#door-name').value, cat: picked };
      if (invite) body.invite = invite;
      else body.password = $('#door-password').value;
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        $('#door-error').textContent = data.error || 'Could not get in.';
        if (data.badInvite) { invite = null; showPassword(true); }
        return;
      }
      store.set('nb_name', body.name);
      store.set('nb_cat', picked);
      $('#door-password').value = '';
      enterRoom(data.user);
    };
    (store.get('nb_name', '') && !invite ? $('#door-password') : $('#door-name')).focus();
  }

  function enterRoom(user) {
    me = user;
    // Don't leave the invite code sitting in the address bar once you're in.
    if (location.search) window.history.replaceState(null, '', location.pathname); // `history` here is the play history
    $('#door').hidden = true;
    $('#room').hidden = false;
    $('#gate').hidden = false;
    $('#gate-btn').focus();
    $('#search-form').hidden = !hasApiKey;
    renderMe();
    connect();
    loadYouTube();
  }

  // ------------------------------------------------------------ socket
  function connect() {
    if (socket) return;
    socket = io({ withCredentials: true });
    socket.on('connect', syncClock);
    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') { socket.disconnect(); socket = null; showDoor(); }
    });
    socket.on('init', (d) => {
      me = d.me;
      users.clear();
      for (const u of d.users) users.set(u.id, u);
      queue = d.queue;
      renderShuffle(d.shuffle);
      playlists = d.playlists || [];
      renderPlaylists();
      history = d.history;
      $('#chat-log').replaceChildren();
      for (const m of d.chat) addChat(m, false);
      setRoom(d.room);
      renderQueue();
      renderHistory();
      renderBoard();
      renderMe();
    });
    socket.on('room', setRoom);
    socket.on('users', (list) => {
      users.clear();
      for (const u of list) users.set(u.id, u);
      if (me) me = users.get(me.id) || me;
      renderMe();
      renderStage();
      renderBoard();
      renderPlaylists();
    });
    socket.on('queue', (q) => { queue = q; renderQueue(); renderStage(); renderPlaylists(); });
    socket.on('history', (h) => { history = h; renderHistory(); });
    socket.on('playlists', (list) => { playlists = list; renderPlaylists(); });
    socket.on('chat', (m) => addChat(m, true));
  }

  function syncClock() {
    let best = null;
    let n = 0;
    const once = () => {
      const t0 = Date.now();
      socket.emit('clock', (server) => {
        const t1 = Date.now();
        const rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt, offset: server - (t0 + t1) / 2 };
        if (++n < 5) setTimeout(once, 150);
        else clockOffset = best.offset;
      });
    };
    once();
  }

  // Reactions: the whole room cheers or jumps when a new song drops, claps when
  // the music stops, and a cat cheers the moment its owner votes Awesome.
  let prevAwesomes = new Set();
  function roomReactions(prevKey, prevRoom, r) {
    const c = r.current;
    const everyone = [...new Set([...r.listeners, ...r.djs, ...npcs.map((n) => n.id)])];
    if (prevKey === undefined) { // just arrived: take the room as it is, no fanfare
      prevAwesomes = new Set(c ? c.awesomes : []);
      return;
    }
    if (lastSongKey !== prevKey) {
      for (const id of everyone) {
        const rand = Dance.seedRand(id + lastSongKey);
        if (c) Dance.react(id, rand() < 0.5 ? 'jump' : 'cheer', 2000 + rand() * 700, rand() * 350);
        else if (prevKey) Dance.react(id, 'clap', 2400, rand() * 300);
      }
      prevAwesomes = new Set();
    }
    const now = new Set(c ? c.awesomes : []);
    for (const id of now) if (!prevAwesomes.has(id)) Dance.react(id, 'cheer', 1300);
    prevAwesomes = now;
    for (const id of c ? c.snags : []) {
      if (prevRoom && prevRoom.current && !prevRoom.current.snags.includes(id)) Dance.react(id, 'jump', 1000);
    }
  }

  function setRoom(r) {
    const prevKey = lastSongKey;
    const prevRoom = room;
    room = r;
    const c = r.current;
    lastSongKey = c ? c.song.videoId + ':' + c.startedAt : null;
    roomReactions(prevKey, prevRoom, r);
    if (c && lastSongKey !== prevKey && prevKey !== undefined && notifyOk() && c.djId !== me.id) {
      notify(`Now playing: ${c.song.title}`, `${userName(c.djId)} is on the decks`);
    }
    renderStage();
    renderNow();
    syncPlayer();
  }

  // ------------------------------------------------------------ stage
  function renderStage() {
    if (!room || !me) return;
    const c = room.current;
    const awesomes = new Set(c ? c.awesomes : []);
    const lames = new Set(c ? c.lames : []);
    const snags = new Set(c ? c.snags : []);

    // DJ seats
    const seats = $('#seats');
    const decks = $('#booth-decks');
    seats.replaceChildren();
    decks.replaceChildren();
    let spotIndex = -1;
    for (let i = 0; i < room.maxDjs; i++) {
      const djId = room.djs[i];
      const seat = el('div', 'seat');
      const deck = el('div', 'deck');
      deck.append(el('span', 'platter'), el('span', 'platter'));
      if (djId) {
        const playing = c && c.djId === djId;
        if (playing) { spotIndex = i; deck.classList.add('spinning'); }
        seat.append(
          el('span', 'nametag', userName(djId) + (djId === me.id ? ' (you)' : '')),
          catNode(userCat(djId), { size: 'dj', mode: playing ? 'dance' : c ? 'groove' : 'chill', seed: djId, anchor: c ? c.startedAt : 0 }),
        );
      } else {
        const inSeat = room.djs.includes(me.id);
        if (!inSeat) {
          const b = el('button', 'seat-open', 'Take this seat');
          b.type = 'button';
          b.addEventListener('click', stepUp);
          seat.append(b);
        }
      }
      seats.append(seat);
      decks.append(deck);
    }
    for (const n of seats.querySelectorAll('.cat')) n.style.setProperty('--s', '1.75');
    const spot = $('#spotlight');
    spot.classList.toggle('on', spotIndex >= 0);
    if (spotIndex >= 0) spot.style.left = `calc(16px + (100% - 32px) * ${(spotIndex + 0.5) / room.maxDjs})`;

    // Crowd
    const crowd = $('#crowd');
    crowd.replaceChildren();
    const fans = room.listeners.filter((id) => !room.djs.includes(id));
    // Spread fans evenly across the floor in a stable order, staggering every other one back a row.
    fans.sort((a, b) => hash(a) - hash(b));
    fans.forEach((id, i) => {
      const h = hash(id);
      const row = i % 2;
      const jitter = ((h >>> 5) % 7) - 3;
      const fan = el('div', 'fan');
      fan.style.left = `${8 + (84 * (i + 0.5)) / fans.length + jitter * 0.6}%`;
      fan.style.bottom = `${6 + row * 30}px`;
      fan.style.zIndex = String(10 - row);
      // Awesome voters dance; everyone else grooves along, or chills between songs.
      const mode = awesomes.has(id) ? 'dance' : c ? 'groove' : 'chill';
      const cat = catNode(userCat(id), { size: 'md', mode, seed: id, anchor: c ? c.startedAt : 0 });
      fan.append(cat, el('span', 'nametag', userName(id) + (id === me.id ? ' (you)' : '')));
      let bubble = null;
      if (snags.has(id)) bubble = ['Snag', 'bubble-snag'];
      else if (awesomes.has(id)) bubble = ['Awesome', 'bubble-awesome'];
      else if (lames.has(id)) bubble = ['Lame', 'bubble-lame'];
      if (bubble) fan.append(el('span', 'bubble ' + bubble[1], bubble[0]));
      crowd.append(fan);
    });

    // NPC cats fill the back of the floor. The more Awesomes a song gets, the
    // more of them dance; Lames calm them down.
    const hype = c ? Math.max(0.1, Math.min(0.85, 0.3 + 0.12 * c.awesomes.length - 0.1 * c.lames.length)) : 0;
    const shown = npcs.slice(0, Math.min(npcs.length, Math.floor(crowd.clientWidth / 34)));
    for (const [row, list] of [[2, shown.filter((n) => n.row === 2)], [3, shown.filter((n) => n.row === 3)]]) {
      list.forEach((n, k) => {
        const fan = el('div', 'fan npc npc-row' + row);
        fan.setAttribute('aria-hidden', 'true');
        // Rows interleave: each back-row cat stands in a gap of the row in front.
        fan.style.left = `${4 + (92 * (k + (row === 2 ? 0.25 : 0.75))) / list.length + n.jitter}%`;
        fan.style.bottom = `${row === 2 ? 62 : 86}px`;
        fan.style.zIndex = String(6 - row);
        const keen = c ? Dance.seedRand(n.id + c.startedAt)() : 1;
        const mode = !c ? 'chill' : keen < hype ? 'dance' : 'groove';
        fan.append(catNode(n.skin, { size: 'md', mode, seed: n.id, anchor: c ? c.startedAt : 0 }));
        crowd.append(fan);
      });
    }

    $('#online-count').textContent = `${room.listeners.length} here`;
    const inSeat = room.djs.includes(me.id);
    const djBtn = $('#btn-dj');
    djBtn.textContent = inSeat ? 'Step down' : 'Step up to DJ';
    djBtn.disabled = !inSeat && room.djs.length >= room.maxDjs;
    $('#btn-skip').hidden = !(c && c.djId === me.id);
  }

  function renderNow() {
    const c = room && room.current;
    $('#screen-empty').hidden = !!c;
    const mine = (list) => !!c && list.includes(me.id);
    const isDj = !!c && c.djId === me.id;
    $('#np-title').textContent = c ? c.song.title : 'Nothing playing';
    $('#np-sub').textContent = c ? `Played by ${userName(c.djId)}${c.song.channel ? ', from ' + c.song.channel : ''}` : 'Take a seat at the booth to start the music.';
    $('#np-total').textContent = c && c.duration ? fmt(c.duration) : '';
    $('#count-awesome').textContent = c ? c.awesomes.length : 0;
    $('#count-lame').textContent = c ? c.lames.length : 0;
    $('#count-snag').textContent = c ? c.snags.length : 0;
    for (const [id, on] of [['#btn-awesome', mine(c ? c.awesomes : [])], ['#btn-lame', mine(c ? c.lames : [])], ['#btn-snag', mine(c ? c.snags : [])]]) {
      $(id).setAttribute('aria-pressed', String(on));
    }
    $('#btn-awesome').disabled = !c || isDj;
    $('#btn-lame').disabled = !c || isDj;
    $('#btn-snag').disabled = !c || isDj;
    updateProgress();
  }

  function updateProgress() {
    const c = room && room.current;
    const pos = c ? Math.max(0, (serverNow() - c.startedAt) / 1000) : 0;
    $('#np-elapsed').textContent = c ? fmt(pos) : '0:00';
    $('#np-progress').style.width = c && c.duration ? `${Math.min(100, (pos / c.duration) * 100)}%` : '0%';
  }
  setInterval(updateProgress, 500);

  function stepUp() {
    socket.emit('dj:up', (res) => {
      if (res && res.error) {
        openTab('queue');
        setStatus(res.error, true);
      }
    });
  }
  $('#btn-dj').addEventListener('click', () => {
    if (room && room.djs.includes(me.id)) socket.emit('dj:down');
    else stepUp();
  });
  $('#btn-skip').addEventListener('click', () => socket.emit('skip'));
  $('#btn-awesome').addEventListener('click', () => {
    const on = $('#btn-awesome').getAttribute('aria-pressed') === 'true';
    socket.emit('vote', on ? 0 : 1);
  });
  $('#btn-lame').addEventListener('click', () => {
    const on = $('#btn-lame').getAttribute('aria-pressed') === 'true';
    socket.emit('vote', on ? 0 : -1);
  });
  $('#btn-snag').addEventListener('click', () => socket.emit('snag', () => {}));

  // ------------------------------------------------------------ YouTube player
  let player = null;
  let playerReady = false;
  let unlocked = false;
  let loadedKey = null;
  let reportedKey = null;
  let startTimer = null;
  let volume = store.get('nb_volume', 70);
  $('#volume').value = volume;

  function loadYouTube() {
    if (window.YT || document.getElementById('yt-api')) return;
    const s = document.createElement('script');
    s.id = 'yt-api';
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  }
  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('player', {
      width: '100%', height: '100%',
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          player.setVolume(volume);
          if (!unlocked || muted) player.mute();
          syncPlayer();
        },
        onStateChange: onPlayerState,
        onError: onPlayerError,
      },
    });
  };

  function currentKey() {
    const c = room && room.current;
    return c ? c.song.videoId + ':' + c.startedAt : null;
  }

  function syncPlayer() {
    if (!playerReady) return;
    const c = room && room.current;
    const key = currentKey();
    if (!c) {
      clearTimeout(startTimer);
      if (loadedKey) { player.stopVideo(); loadedKey = null; }
      return;
    }
    const pos = (serverNow() - c.startedAt) / 1000;
    if (key !== loadedKey) {
      clearTimeout(startTimer);
      loadedKey = key;
      if (pos < 0) {
        player.cueVideoById({ videoId: c.song.videoId, startSeconds: 0 });
        startTimer = setTimeout(syncPlayer, -pos * 1000);
      } else {
        player.loadVideoById({ videoId: c.song.videoId, startSeconds: pos });
      }
      return;
    }
    if (pos < 0) return;
    const state = player.getPlayerState();
    if (state === YT.PlayerState.CUED || state === YT.PlayerState.PAUSED || state === -1) {
      player.seekTo(pos, true);
      player.playVideo();
    } else if (state === YT.PlayerState.PLAYING) {
      const drift = player.getCurrentTime() - pos;
      if (Math.abs(drift) > 1 && (!c.duration || pos < c.duration - 1)) player.seekTo(pos, true);
    }
  }
  setInterval(syncPlayer, 1000);

  function onPlayerState(e) {
    const c = room && room.current;
    if (!c) return;
    // Nobody gets to pause the room: if anything pauses the player (a media key,
    // the OS media controls), jump straight back to where everyone else is.
    if (e.data === YT.PlayerState.PAUSED) syncPlayer();
    if (e.data === YT.PlayerState.PLAYING && reportedKey !== loadedKey) {
      reportedKey = loadedKey;
      const seconds = player.getDuration();
      if (seconds > 0) socket.emit('player:duration', { videoId: c.song.videoId, seconds });
      const data = player.getVideoData ? player.getVideoData() : null;
      if (data && data.title) socket.emit('player:title', { videoId: c.song.videoId, title: data.title });
    }
    if (e.data === YT.PlayerState.ENDED) socket.emit('player:ended', { videoId: c.song.videoId });
  }
  function onPlayerError(e) {
    const c = room && room.current;
    if (c && [100, 101, 150].includes(e.data)) socket.emit('player:blocked', { videoId: c.song.videoId });
  }

  $('#gate-btn').addEventListener('click', () => {
    unlocked = true;
    $('#gate').hidden = true;
    if (playerReady) {
      if (!muted) player.unMute();
      player.setVolume(volume);
      loadedKey = null;
      syncPlayer();
    }
  });
  $('#volume').addEventListener('input', (e) => {
    volume = +e.target.value;
    store.set('nb_volume', volume);
    if (playerReady) player.setVolume(volume);
  });

  // Mute only silences this browser; the song keeps playing in sync underneath.
  let muted = store.get('nb_muted', false);
  function renderMute() {
    $('#btn-mute').setAttribute('aria-pressed', String(muted));
    $('#btn-mute').textContent = muted ? 'Unmute' : 'Mute';
  }
  renderMute();
  $('#btn-mute').addEventListener('click', () => {
    muted = !muted;
    store.set('nb_muted', muted);
    renderMute();
    if (!playerReady) return;
    if (muted) player.mute();
    else if (unlocked) player.unMute();
  });

  // ------------------------------------------------------------ chat
  function mentionRegex() {
    const names = [...users.values()].map((u) => u.name).sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return names.length ? new RegExp(`@(${names.join('|')})`, 'gi') : null;
  }
  function addChat(m, live) {
    const log = $('#chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    let li;
    if (m.type === 'system') {
      li = el('li', 'msg-system', m.text);
    } else {
      li = el('li', 'msg');
      const body = el('div');
      const head = el('div');
      head.append(el('span', 'msg-name', m.name), el('span', 'msg-time', new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      const text = el('div', 'msg-text');
      const re = mentionRegex();
      let mentioned = false;
      let last = 0;
      if (re) {
        for (const match of m.text.matchAll(re)) {
          text.append(m.text.slice(last, match.index));
          text.append(el('span', 'mention', match[0]));
          if (match[1].toLowerCase() === me.name.toLowerCase()) mentioned = true;
          last = match.index + match[0].length;
        }
      }
      text.append(m.text.slice(last));
      body.append(head, text);
      li.append(catNode(m.cat, { size: 'xs' }), body);
      if (mentioned && m.userId !== me.id) {
        li.classList.add('mentioned');
        if (live && notifyOk(true)) notify(`${m.name} mentioned you`, m.text);
      }
    }
    log.append(li);
    while (log.children.length > 200) log.firstChild.remove();
    if (atBottom || !live) log.scrollTop = log.scrollHeight;
  }
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    if (input.value.trim()) socket.emit('chat', input.value);
    input.value = '';
  });

  // ------------------------------------------------------------ desktop alerts
  const alertsBox = $('#alerts');
  alertsBox.checked = store.get('nb_alerts', false) && 'Notification' in window && Notification.permission === 'granted';
  alertsBox.addEventListener('change', async () => {
    if (alertsBox.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') alertsBox.checked = false;
    }
    store.set('nb_alerts', alertsBox.checked);
  });
  function notifyOk(evenIfVisible) {
    return alertsBox.checked && 'Notification' in window && Notification.permission === 'granted' && (evenIfVisible ? document.hidden || !document.hasFocus() : document.hidden);
  }
  function notify(title, body) {
    try { new Notification(title, { body, icon: `cats/${me.cat}.png`, silent: false }); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ queue
  function songItem(s, actions, meta) {
    const li = el('li', 'song');
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = s.thumb || `https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg`;
    const info = el('div');
    info.append(el('div', 'song-title', s.title), el('div', 'song-meta', meta || [s.channel, s.duration ? fmt(s.duration) : ''].filter(Boolean).join(', ')));
    const act = el('div', 'song-actions');
    for (const [label, title, fn] of actions) {
      const b = el('button', 'icon-btn', label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      act.append(b);
    }
    li.append(img, info, act);
    return li;
  }

  let dragId = null;
  function renderQueue() {
    const list = $('#queue');
    list.replaceChildren();
    $('#queue-count').textContent = queue.length ? String(queue.length) : '';
    const total = queue.reduce((t, s) => t + (s.duration || 0), 0);
    const played = queue.filter((s) => s.played).length;
    const left = queue.filter((s) => !s.played && !s.blocked).length;
    $('#queue-summary').textContent = queue.length
      ? `${left} to play${played ? `, ${played} played` : ''}${total ? ', about ' + fmt(total) + ' in all' : ''}.`
      : '';
    $('#q-replay').hidden = !played;
    if (!queue.length) {
      list.append(el('li', 'empty', 'Your queue is empty. Paste a YouTube link above to add your first song.'));
      return;
    }
    // Selections survive re-renders, minus songs that are gone.
    for (const id of [...selected]) if (!queue.some((s) => s.id === id)) selected.delete(id);
    queue.forEach((s, i) => {
      const li = songItem(s, [
        ['Top', 'Move to top', () => socket.emit('queue:move', { id: s.id, to: 'top' })],
        ['Remove', 'Remove from queue', () => socket.emit('queue:remove', s.id)],
      ], s.blocked ? "Can't be embedded, will be skipped" : s.played ? ['Played', s.channel].filter(Boolean).join(' · ') : null);
      if (s.blocked) li.classList.add('blocked');
      else if (s.played) li.classList.add('played');
      li.classList.toggle('selected', selected.has(s.id));
      li.setAttribute('aria-selected', String(selected.has(s.id)));
      li.draggable = true;
      li.dataset.id = s.id;
      li.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); }); // no text selection on shift-click
      li.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectSong(s.id, e.shiftKey);
      });
      li.addEventListener('dragstart', (e) => { dragId = s.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      li.addEventListener('dragend', () => { dragId = null; li.classList.remove('dragging'); });
      li.addEventListener('dragover', (e) => { if (dragId && dragId !== s.id) { e.preventDefault(); li.classList.add('drop-before'); } });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop-before');
        // Dragging one of several selected songs moves the whole selection.
        if (selected.size > 1 && selected.has(dragId)) {
          if (!selected.has(s.id)) socket.emit('queue:moveMany', { ids: [...selected], before: s.id });
          return;
        }
        const from = queue.findIndex((x) => x.id === dragId);
        if (from === -1) return;
        const to = from < i ? i - 1 : i;
        socket.emit('queue:move', { id: dragId, to });
      });
      list.append(li);
    });
    renderSelection();
  }

  // ---- multi-select: click toggles a song, shift-click selects a range
  const selected = new Set();
  let anchorId = null;
  function selectSong(id, range) {
    const a = queue.findIndex((s) => s.id === anchorId);
    const b = queue.findIndex((s) => s.id === id);
    if (range && a !== -1 && b !== -1) {
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) selected.add(queue[k].id);
    } else {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchorId = id;
    }
    for (const li of $('#queue').children) {
      if (!li.dataset.id) continue;
      li.classList.toggle('selected', selected.has(li.dataset.id));
      li.setAttribute('aria-selected', String(selected.has(li.dataset.id)));
    }
    renderSelection();
  }
  function renderSelection() {
    $('#q-selection').hidden = !selected.size;
    $('#q-sel-count').textContent = `${selected.size} selected`;
  }
  function clearSelection() {
    selected.clear();
    anchorId = null;
    renderQueue();
  }
  // Ids in queue order, so moved songs keep their order.
  const selectedIds = () => queue.filter((s) => selected.has(s.id)).map((s) => s.id);
  $('#q-sel-top').addEventListener('click', () => { socket.emit('queue:moveMany', { ids: selectedIds(), to: 'top' }); clearSelection(); });
  $('#q-sel-bottom').addEventListener('click', () => { socket.emit('queue:moveMany', { ids: selectedIds(), to: 'bottom' }); clearSelection(); });
  $('#q-sel-remove').addEventListener('click', () => {
    if (selected.size > 1 && !confirm(`Remove ${selected.size} songs from your queue?`)) return;
    socket.emit('queue:removeMany', selectedIds());
    clearSelection();
  });
  $('#q-sel-all').addEventListener('click', () => { for (const s of queue) selected.add(s.id); renderQueue(); });
  $('#q-sel-clear').addEventListener('click', clearSelection);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected.size && !$('#queue').closest('.panel').hidden) clearSelection();
  });

  function setStatus(text, isError) {
    const s = $('#add-status');
    s.textContent = text;
    s.classList.toggle('error', !!isError);
  }

  function addResult(res) {
    if (!res || res.error) return setStatus(res ? res.error : 'Could not add that.', true);
    const parts = [];
    if (res.added) parts.push(`Added ${res.added} song${res.added === 1 ? '' : 's'}.`);
    if (res.skipped) parts.push(`${res.skipped} already in your queue.`);
    if (res.blocked) parts.push(`${res.blocked} left out because the owner blocks playing them outside YouTube.`);
    setStatus(parts.join(' ') || 'Nothing new to add.', !res.added);
  }

  const playlistIdOf = (url) => (/[?&]list=([A-Za-z0-9_-]{10,64})/.exec(url) || [])[1];
  const hasVideoId = (url) => /[?&]v=|youtu\.be\/|\/shorts\//.test(url);

  // The top box adds single songs. A bare playlist link is handed to the Playlists
  // drawer to import; a song inside a playlist asks which one you meant.
  function importFromTop(url) {
    $('#add-input').value = '';
    setStatus('');
    $('#library').open = true;
    $('#import-input').value = url;
    importPlaylist(url);
  }
  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#add-input').value.trim();
    if (!url) return;
    if (playlistIdOf(url) && !hasVideoId(url)) return importFromTop(url);
    if (playlistIdOf(url)) {
      setStatus('This song is part of a playlist. ');
      const song = el('button', 'link-btn', 'Add just this song');
      const list = el('button', 'link-btn', 'Import the whole playlist');
      song.type = list.type = 'button';
      song.addEventListener('click', () => addSong(url));
      list.addEventListener('click', () => importFromTop(url));
      $('#add-status').append(song, list);
      return;
    }
    addSong(url);
  });
  function addSong(url) {
    setStatus('Adding...');
    socket.emit('queue:add', { url, mode: 'video' }, (res) => {
      addResult(res);
      if (res && !res.error) $('#add-input').value = '';
    });
  }

  function readPlaylist(listId) {
    return new Promise((resolve, reject) => {
      if (!window.YT || !YT.Player) return reject(new Error('The YouTube player is still loading. Try again in a moment.'));
      const host = el('div', 'playlist-reader');
      const slot = el('div');
      host.append(slot);
      document.body.append(host);
      let reader = null;
      let timer = null;
      const finish = (fn, value) => {
        clearInterval(timer);
        try { reader.destroy(); } catch { /* ignore */ }
        host.remove();
        fn(value);
      };
      reader = new YT.Player(slot, {
        width: 320, height: 180,
        playerVars: { controls: 0, mute: 1 },
        events: {
          onReady: () => {
            reader.cuePlaylist({ listType: 'playlist', list: listId });
            const started = Date.now();
            timer = setInterval(() => {
              const ids = reader.getPlaylist && reader.getPlaylist();
              if (ids && ids.length) finish(resolve, ids);
              else if (Date.now() - started > 15000) finish(reject, new Error("Couldn't open that playlist. Make sure it's public or unlisted."));
            }, 300);
          },
          onError: () => finish(reject, new Error("Couldn't open that playlist. Make sure it's public or unlisted.")),
        },
      });
    });
  }

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    if (!q) return;
    setStatus('Searching...');
    socket.emit('search', q, (res) => {
      const list = $('#search-results');
      list.replaceChildren();
      if (!res || res.error) { list.hidden = true; return setStatus(res ? res.error : 'Search failed.', true); }
      setStatus(res.results.length ? '' : 'No results.');
      list.hidden = !res.results.length;
      for (const s of res.results) {
        list.append(songItem(s, [['Add', 'Add to my queue', () => socket.emit('queue:add', { song: { videoId: s.videoId } }, addResult)]]));
      }
      const close = el('li');
      const b = el('button', 'link-btn', 'Hide results');
      b.type = 'button';
      b.addEventListener('click', () => { list.hidden = true; list.replaceChildren(); });
      close.append(b);
      list.append(close);
    });
  });

  $('#q-shuffle').addEventListener('click', () => socket.emit('queue:shuffle'));
  function renderShuffle(on) {
    $('#q-shuffle-play').setAttribute('aria-pressed', String(on));
    $('#q-shuffle-play').textContent = on ? 'Shuffle play: on' : 'Shuffle play: off';
  }
  $('#q-shuffle-play').addEventListener('click', () => {
    const on = $('#q-shuffle-play').getAttribute('aria-pressed') !== 'true';
    socket.emit('queue:shufflePlay', on, (res) => renderShuffle(!!(res && res.shuffle)));
  });
  $('#q-replay').addEventListener('click', () => socket.emit('queue:replayAll'));
  $('#q-clear').addEventListener('click', () => {
    if (queue.length && confirm(`Remove all ${queue.length} songs from your queue?`)) socket.emit('queue:clear');
  });

  // ------------------------------------------------------------ playlists drawer
  // "My queue" sits on top; saved and imported playlists below it load into the queue.
  let loadedFrom = null; // name of the playlist last loaded into the queue, this session
  function setImportStatus(text, isError) {
    const s = $('#import-status');
    s.textContent = text;
    s.classList.toggle('error', !!isError);
  }

  function playlistRow({ name, meta, current, actions }) {
    const li = el('li', 'pl-row' + (current ? ' current' : ''));
    const info = el('div');
    info.append(el('div', 'pl-name', name), el('div', 'pl-meta', meta));
    const act = el('div', 'pl-actions');
    for (const [label, title, fn, cls] of actions) {
      const b = el('button', cls || 'link-btn', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', fn);
      act.append(b);
    }
    li.append(info, act);
    return li;
  }

  function renderPlaylists() {
    if (!me) return;
    const list = $('#playlists');
    list.replaceChildren();
    $('#pl-count').textContent = playlists.length ? String(playlists.length) : '';
    const total = queue.reduce((t, s) => t + (s.duration || 0), 0);
    const qMeta = [`${queue.length} song${queue.length === 1 ? '' : 's'}`, total ? fmt(total) : '', loadedFrom ? `from "${loadedFrom}"` : ''].filter(Boolean).join(' · ');
    list.append(playlistRow({
      name: 'My queue', meta: qMeta + ' · playing now', current: true,
      actions: queue.length ? [['Save as playlist', 'Save your current queue as a playlist', saveQueue]] : [],
    }));
    // Yours first, then everyone else's, each alphabetical.
    const sorted = [...playlists].sort((a, b) => (b.ownerId === me.id) - (a.ownerId === me.id) || a.name.localeCompare(b.name));
    if (!sorted.length) list.append(el('li', 'empty', 'No saved playlists yet. Import one from YouTube above.'));
    for (const p of sorted) {
      const mine = p.ownerId === me.id;
      const meta = [mine ? 'yours' : 'by ' + userName(p.ownerId), `${p.count} song${p.count === 1 ? '' : 's'}`, p.duration ? fmt(p.duration) : ''].filter(Boolean).join(' · ');
      const actions = [
        ['Load', 'Replace your queue with this playlist', () => loadPlaylist(p, 'replace'), 'btn'],
        ['Add', "Add this playlist's songs to the end of your queue", () => loadPlaylist(p, 'append')],
      ];
      actions.push(['Delete', 'Remove this playlist for everyone', () => deletePlaylist(p)]);
      list.append(playlistRow({ name: p.name, meta, actions }));
    }
  }

  function loadPlaylist(p, mode) {
    if (mode === 'replace' && queue.length && !confirm(`Replace the ${queue.length} songs in your queue with "${p.name}"?`)) return;
    socket.emit('playlist:load', { id: p.id, mode }, (res) => {
      if (res && res.error) return setImportStatus(res.error, true);
      if (mode === 'replace') {
        loadedFrom = p.name;
        setImportStatus(`Loaded "${p.name}" into your queue (${res.added} songs).`);
      } else {
        setImportStatus(res.added ? `Added ${res.added} songs from "${p.name}".` : 'Those songs are already in your queue.', !res.added);
      }
      renderPlaylists();
    });
  }

  function deletePlaylist(p) {
    const whose = p.ownerId === me.id ? '' : ` It was saved by ${userName(p.ownerId)} and will be gone for everyone.`;
    if (!confirm(`Delete the playlist "${p.name}"?${whose} Your queue stays as it is.`)) return;
    socket.emit('playlist:delete', p.id, (res) => {
      if (res && res.error) setImportStatus(res.error, true);
      else setImportStatus(`Deleted "${p.name}".`);
    });
  }

  function saveQueue() {
    if (!queue.length) return setImportStatus('Your queue is empty, so there is nothing to save.', true);
    const name = prompt('Name this playlist. Using a name you already saved updates that playlist.', loadedFrom || '');
    if (name == null || !name.trim()) return;
    socket.emit('playlist:save', { name }, (res) => {
      if (res && res.error) return setImportStatus(res.error, true);
      loadedFrom = res.name;
      setImportStatus(`Saved "${res.name}" with ${res.count} songs.`);
      renderPlaylists();
    });
  }

  // With an API key the server reads the playlist; without one, the browser's
  // YouTube player reads the video ids and the server looks up each song.
  function importPlaylist(url) {
    const listId = playlistIdOf(url);
    if (!listId) return setImportStatus("That doesn't look like a YouTube playlist link.", true);
    setImportStatus('Importing playlist... this can take a few seconds.');
    const send = (ids) => socket.emit('playlist:import', { playlistId: listId, ids }, (res) => {
      if (!res || res.error) return setImportStatus(res ? res.error : 'Could not import that playlist.', true);
      $('#import-input').value = '';
      // Without an API key YouTube's player only hands over the first 200 songs.
      const capped = !hasApiKey && ids && ids.length >= 200
        ? ' YouTube only shares the first 200 songs of a playlist unless the room has a YouTube API key (see the README).' : '';
      setImportStatus(`Imported "${res.name}" with ${res.count} songs${res.blocked ? ` (${res.blocked} left out because they can't play outside YouTube)` : ''}. Press Load to play from it.${capped}`);
    });
    if (hasApiKey) send(undefined);
    else readPlaylist(listId).then(send, (err) => setImportStatus(err.message, true));
  }
  $('#import-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#import-input').value.trim();
    if (url) importPlaylist(url);
  });

  // ------------------------------------------------------------ history & board
  function renderHistory() {
    const list = $('#history');
    list.replaceChildren();
    if (!history.length) { list.append(el('li', 'empty', 'Songs show up here after they play.')); return; }
    for (const h of [...history].reverse()) {
      const when = new Date(h.playedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      const tally = `${h.awesomes} awesome${h.awesomes === 1 ? '' : 's'}${h.lames ? `, ${h.lames} lame` : ''}`;
      list.append(songItem(h, [['Add', 'Add to my queue', () => socket.emit('queue:add', { song: { videoId: h.videoId } }, (res) => {
        openTab('queue');
        addResult(res);
      })]], `${h.djName}, ${when}. ${tally}`));
    }
  }

  function renderBoard() {
    const list = $('#board');
    list.replaceChildren();
    const online = new Set(room ? room.listeners : []);
    const ranked = [...users.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    ranked.forEach((u, i) => {
      const li = el('li');
      const name = el('span', '', u.name);
      const dot = el('span', 'dot' + (online.has(u.id) ? ' on' : ''));
      dot.title = online.has(u.id) ? 'In the room' : 'Away';
      name.append(dot);
      const cat = catNode(u.cat, { size: 'xs' });
      cat.style.setProperty('--s', '0.45');
      li.append(el('span', 'rank', String(i + 1)), cat, name, el('span', 'pts', String(u.points)));
      list.append(li);
    });
  }

  // ------------------------------------------------------------ me
  function renderMe() {
    if (!me) return;
    $('#me-name').textContent = me.name;
    setCat($('#me-cat'), me.cat);
  }
  $('#me-btn').addEventListener('click', () => {
    catGrid($('#me-cats'), me.cat, (id) => {
      socket.emit('profile', { cat: id }, () => {});
      store.set('nb_cat', id);
    });
    $('#me-dialog').showModal();
  });
  $('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  });

  // ------------------------------------------------------------ invite link
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  let inviteCode = '';
  function setInviteBase(base) {
    const ok = /^https?:\/\/[^\s/]+$/.test(base);
    $('#invite-link').value = ok ? `${base}/?invite=${inviteCode}` : '';
    $('#invite-copy').disabled = !ok;
    $('#invite-help').textContent = ok
      ? 'Send this link to your friends. It lets them straight in without the password, so only share it with people you want in the room.'
      : "The room isn't online for friends yet. Double-click share.bat, wait until it connects, then press Invite friends again. Or paste the .trycloudflare.com address from the share.bat window here:";
    $('#invite-url-row').hidden = ok;
  }
  $('#invite-btn').addEventListener('click', async () => {
    $('#invite-status').textContent = '';
    $('#invite-link').value = '';
    $('#invite-help').textContent = 'Getting your link...';
    $('#invite-url-row').hidden = true;
    $('#invite-dialog').showModal();
    try {
      const res = await fetch('/api/invite', { credentials: 'same-origin' });
      const data = await res.json();
      inviteCode = data.code;
      // A friend opening this from the public address can share that same address.
      setInviteBase(data.publicUrl || (isLocalHost ? '' : location.origin));
    } catch {
      $('#invite-help').textContent = "Couldn't get the invite link. Is the room still running?";
    }
  });
  $('#invite-use').addEventListener('click', () => {
    const raw = $('#invite-public').value.trim().replace(/\/+$/, '');
    setInviteBase(/^https?:\/\//.test(raw) ? raw : 'https://' + raw);
  });
  $('#invite-copy').addEventListener('click', async () => {
    const link = $('#invite-link').value;
    try {
      await navigator.clipboard.writeText(link);
      $('#invite-status').textContent = 'Copied! Paste it to your friends.';
    } catch {
      $('#invite-link').select();
      $('#invite-status').textContent = 'Press Ctrl+C (or long-press and Copy) to copy the link.';
    }
  });

  // ------------------------------------------------------------ tabs
  function openTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
    if (name === 'chat') { const log = $('#chat-log'); log.scrollTop = log.scrollHeight; }
  }
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => openTab(t.dataset.tab));

  boot().catch((e) => {
    document.body.textContent = 'Could not reach the server. Is it running?';
    console.error(e);
  });
})();
