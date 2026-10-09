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
  let lastSongKey; // undefined until the first room update, so joining never fires an alert
  const serverNow = () => Date.now() + clockOffset;
  const userName = (id) => (users.get(id) || {}).name || 'Someone';
  const userCat = (id) => (users.get(id) || {}).cat || (CATS[0] && CATS[0].id);

  // ------------------------------------------------------------ cat sprites
  // Sheet layout: frames 0-3 dance, 4-5 idle (see cats/cats.json).
  function catNode(catId, { size = 'md', anim = 'idle', seed = 0 } = {}) {
    const n = el('span', 'cat cat-' + size);
    setCat(n, catId, anim, seed);
    return n;
  }
  function setCat(n, catId, anim = 'idle', seed = 0) {
    n.style.backgroundImage = `url(cats/${catId}.png)`;
    n.dataset.cat = catId;
    n.dataset.anim = anim;
    n.dataset.seed = seed;
    n.setAttribute('role', 'img');
    const cat = CATS.find((c) => c.id === catId);
    n.setAttribute('aria-label', cat ? cat.name : 'cat');
  }
  let SPRITES = { frames: 24, animations: { dance: { start: 0, count: 16, fps: 12 }, idle: { start: 16, count: 8, fps: 5 } } };
  function tickCats() {
    const t = performance.now() / 1000;
    const last = SPRITES.frames - 1;
    for (const n of document.querySelectorAll('.cat[data-cat]')) {
      const a = SPRITES.animations[n.dataset.anim === 'dance' ? 'dance' : 'idle'];
      const seed = +n.dataset.seed || 0;
      const f = a.start + (Math.floor(t * a.fps + seed) % a.count);
      n.style.backgroundPosition = `${(f / last) * 100}% 0`;
    }
  }
  setInterval(tickCats, 40);

  function catGrid(container, selected, onPick) {
    container.replaceChildren();
    for (const c of CATS) {
      const b = el('button', 'cat-option');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === selected));
      b.title = c.dance ? `${c.blurb}. Signature move: ${c.dance}.` : c.blurb;
      b.append(catNode(c.id, { size: 'sm', anim: c.id === selected ? 'dance' : 'idle', seed: hash(c.id) % 7 }), el('span', '', c.name));
      b.addEventListener('click', () => {
        for (const o of container.children) {
          const on = o === b;
          o.setAttribute('aria-checked', String(on));
          o.querySelector('.cat').dataset.anim = on ? 'dance' : 'idle';
        }
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
    if (info.sprites) {
      SPRITES = info.sprites;
      const root = document.documentElement.style;
      root.setProperty('--frame-w', SPRITES.frameWidth + 'px');
      root.setProperty('--frame-h', SPRITES.frameHeight + 'px');
      root.setProperty('--frames', SPRITES.frames);
    }
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
    const form = $('#door-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      $('#door-error').textContent = '';
      const body = { password: $('#door-password').value, name: $('#door-name').value, cat: picked };
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { $('#door-error').textContent = data.error || 'Could not get in.'; return; }
      store.set('nb_name', body.name);
      store.set('nb_cat', picked);
      $('#door-password').value = '';
      enterRoom(data.user);
    };
    (store.get('nb_name', '') ? $('#door-password') : $('#door-name')).focus();
  }

  function enterRoom(user) {
    me = user;
    $('#door').hidden = true;
    $('#room').hidden = false;
    $('#gate').hidden = false;
    $('#gate-btn').focus();
    $('#search-form').hidden = !hasApiKey;
    $('#add-input').placeholder = hasApiKey ? 'Paste a YouTube link or playlist link' : 'Paste a YouTube link';
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
    });
    socket.on('queue', (q) => { queue = q; renderQueue(); renderStage(); });
    socket.on('history', (h) => { history = h; renderHistory(); });
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

  function setRoom(r) {
    const prevKey = lastSongKey;
    room = r;
    const c = r.current;
    lastSongKey = c ? c.song.videoId + ':' + c.startedAt : null;
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
          catNode(userCat(djId), { size: 'dj', anim: playing ? 'dance' : 'idle', seed: hash(djId) % 9 }),
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
      const cat = catNode(userCat(id), { size: 'md', anim: awesomes.has(id) ? 'dance' : 'idle', seed: h % 11 });
      fan.append(cat, el('span', 'nametag', userName(id) + (id === me.id ? ' (you)' : '')));
      let bubble = null;
      if (snags.has(id)) bubble = ['Snag', 'bubble-snag'];
      else if (awesomes.has(id)) bubble = ['Awesome', 'bubble-awesome'];
      else if (lames.has(id)) bubble = ['Lame', 'bubble-lame'];
      if (bubble) fan.append(el('span', 'bubble ' + bubble[1], bubble[0]));
      crowd.append(fan);
    });

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
          if (!unlocked) player.mute();
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
      if (Math.abs(drift) > 2.5 && (!c.duration || pos < c.duration - 1)) player.seekTo(pos, true);
    }
  }
  setInterval(syncPlayer, 2000);

  function onPlayerState(e) {
    const c = room && room.current;
    if (!c) return;
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
      player.unMute();
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
    $('#queue-summary').textContent = queue.length ? `${queue.length} song${queue.length === 1 ? '' : 's'}${total ? ', about ' + fmt(total) : ''}. Drag to reorder.` : '';
    if (!queue.length) {
      list.append(el('li', 'empty', 'Your queue is empty. Paste a YouTube link above to add your first song.'));
      return;
    }
    queue.forEach((s, i) => {
      const li = songItem(s, [
        ['Top', 'Move to top', () => socket.emit('queue:move', { id: s.id, to: 'top' })],
        ['Remove', 'Remove from queue', () => socket.emit('queue:remove', s.id)],
      ], s.blocked ? "Can't be embedded, will be skipped" : null);
      if (s.blocked) li.classList.add('blocked');
      li.draggable = true;
      li.dataset.id = s.id;
      li.addEventListener('dragstart', (e) => { dragId = s.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      li.addEventListener('dragend', () => { dragId = null; li.classList.remove('dragging'); });
      li.addEventListener('dragover', (e) => { if (dragId && dragId !== s.id) { e.preventDefault(); li.classList.add('drop-before'); } });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop-before');
        const from = queue.findIndex((x) => x.id === dragId);
        if (from === -1) return;
        const to = from < i ? i - 1 : i;
        socket.emit('queue:move', { id: dragId, to });
      });
      list.append(li);
    });
  }

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

  let pendingUrl = null;
  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#add-input').value.trim();
    if (!url) return;
    const hasList = /[?&]list=/.test(url);
    const hasVideo = /[?&]v=|youtu\.be\/|\/shorts\//.test(url);
    if (hasList && hasVideo && hasApiKey) {
      pendingUrl = url;
      $('#add-choice').hidden = false;
      return;
    }
    submitAdd(url, 'auto');
  });
  for (const b of document.querySelectorAll('#add-choice button')) {
    b.addEventListener('click', () => {
      $('#add-choice').hidden = true;
      if (pendingUrl) submitAdd(pendingUrl, b.dataset.mode);
      pendingUrl = null;
    });
  }
  function submitAdd(url, mode) {
    setStatus(mode === 'playlist' || (/[?&]list=/.test(url) && !/[?&]v=/.test(url)) ? 'Importing playlist...' : 'Adding...');
    socket.emit('queue:add', { url, mode }, (res) => {
      addResult(res);
      if (res && !res.error) $('#add-input').value = '';
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
  $('#q-clear').addEventListener('click', () => {
    if (queue.length && confirm(`Remove all ${queue.length} songs from your queue?`)) socket.emit('queue:clear');
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
