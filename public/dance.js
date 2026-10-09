/* God's Noisey BoyZ dance director.
 *
 * The sprite atlases hold every clip from three views (front, side, back); this
 * decides, moment to moment, which clip each avatar plays, which way it faces
 * and when it spins, cheers or settles. Choices come from a seeded random
 * sequence anchored to the song's start, so every friend sees the same dancing
 * without any extra network traffic.
 *
 * When the song's tempo is known (looked up, or tapped by someone in the room)
 * everything locks to the beat: each move loop is one bar, moves change on
 * 2- and 4-bar phrases, the whole crowd hits the same move every 8th bar, and
 * a wave ripples across the floor every 16 bars. Without a tempo the same
 * choreography runs on its own clock.
 *
 * An avatar element opts in with data attributes (set by Dance.attach):
 *   data-cat     skin id (sprite sheet)
 *   data-mode    dance | dj | groove | chill | sulk | still
 *   data-seed    who this is (user id); picks their personal sequence
 *   data-anchor  time the sequence starts from (the song's start), or 0
 *   data-bpm     the song's tempo, if known
 *   data-offset  ms into the song where a beat lands, if known (tapped)
 *   data-face    "stage" for crowd avatars seen from behind (they face the DJ)
 *   data-x       0..1 across the floor, for the crowd wave
 *
 * Dance.now is the song clock: server time adjusted by how far this player's
 * video is from the room's timeline, so dancers match the music you hear.
 */
(() => {
  'use strict';

  let M = null;           // manifest from cats.json
  let SIGNATURE = {};     // skin id -> signature move
  let MOVES = [];         // clip ids of kind "move"
  let DJ_MOVES = [];      // clip ids of kind "dj"
  const reactions = new Map(); // seed -> { clip, start, until }
  const timelines = new Map(); // cache key -> { rand, segs, end }

  // ---- seeded randomness
  function hashStr(str) {
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const mod = (a, b) => ((a % b) + b) % b;
  const tweenFps = () => M.tweenFps || 12;

  // ---- tempo: one move loop = one bar of 4 beats, halved or doubled so a
  // bar always lasts 1.2-2.7 s (slow songs go double time, fast ones half time)
  function tempoOf(n) {
    const bpm = +n.dataset.bpm;
    if (!(bpm > 0)) return null;
    let bar = (4 * 60000) / bpm;
    while (bar < 1200) bar *= 2;
    while (bar > 2700) bar /= 2;
    const anchor = +n.dataset.anchor || 0;
    const beat0 = anchor + (n.dataset.offset !== '' && n.dataset.offset != null ? +n.dataset.offset : 0);
    // Bars counted from the last downbeat at or before the song's start.
    const base = beat0 - Math.ceil((beat0 - anchor) / bar) * bar;
    return { bpm, bar, beat: bar / 4, base };
  }

  // How long one loop of a clip lasts.
  function loopMs(clip, T) {
    const c = M.clips[clip];
    if (!T || c.kind === 'rest' && clip === 'idle') return (c.count / c.fps) * 1000;
    return c.count >= 16 ? T.bar : T.bar / 2; // 8-frame clips loop twice a bar
  }

  // ---- choreography: each mode is a generator of segments
  //   { clip, view: front|side|back, flip, spin, n (loops), kind }
  const SPIN_MS = 640; // front -> side -> back -> other side -> front
  function pickMove(rand, prev, skin, pool, sigWeight) {
    const sig = SIGNATURE[skin];
    const bag = [];
    for (const m of pool) if (!prev || m !== prev.clip) bag.push(...Array(m === sig ? sigWeight : 1).fill(m));
    return bag[Math.floor(rand() * bag.length)];
  }
  function nextSegment(mode, rand, prev, skin, T) {
    const r = rand();
    const halfBars = (k) => (T ? 2 * k : k); // 8-frame clips: keep phrases whole bars
    if (mode === 'dance') {
      if (prev && prev.kind !== 'interlude' && r < 0.12) {
        return { clip: rand() < 0.5 ? 'clap' : 'cheer', view: 'front', flip: false, spin: false, n: halfBars(1), kind: 'interlude' };
      }
      const sig = SIGNATURE[skin];
      const clip = !prev && sig && rand() < 0.6 ? sig : pickMove(rand, prev, skin, MOVES, 3);
      const f = rand();
      const view = f < 0.55 ? 'front' : f < 0.75 ? 'side' : f < 0.86 ? 'back' : 'front';
      return { clip, view, flip: rand() < 0.5, spin: f >= 0.86, n: T ? (rand() < 0.5 ? 2 : 4) : 2 + Math.floor(rand() * 3), kind: 'move' };
    }
    if (mode === 'dj') { // the booth: scratching, fist pumps, hands up, and the odd dance move
      const pool = [...DJ_MOVES, ...DJ_MOVES, ...MOVES];
      const clip = pool.length ? pickMove(rand, prev, skin, pool, 1) : 'bob';
      return { clip, view: rand() < 0.85 ? 'front' : 'side', flip: rand() < 0.5, spin: false, n: T ? (rand() < 0.5 ? 2 : 4) : 2 + Math.floor(rand() * 2), kind: 'move' };
    }
    if (mode === 'groove') {
      if (r < 0.15) return { clip: 'clap', view: 'front', flip: false, spin: false, n: halfBars(1), kind: 'interlude' };
      const side = rand() < 0.2;
      return { clip: 'bob', view: side ? 'side' : 'front', flip: rand() < 0.5, spin: false, n: halfBars(2 + Math.floor(rand() * 3)), kind: 'rest' };
    }
    if (mode === 'sulk') { // booed: arms down, back to the stage
      return { clip: 'idle', view: 'back', flip: false, spin: false, n: 4, kind: 'rest' };
    }
    // chill: mostly idle facing out, now and then looking around or bobbing along
    if (r < 0.12) return { clip: 'bob', view: 'front', flip: false, spin: false, n: 2, kind: 'rest' };
    const look = rand() < 0.18;
    return { clip: 'idle', view: look ? 'side' : 'front', flip: rand() < 0.5, spin: false, n: look ? 1 : 2 + Math.floor(rand() * 3), kind: 'rest' };
  }

  const WINDOW = 10 * 60e3; // sequences with no song to anchor them restart every 10 minutes
  function timelineAt(mode, seed, skin, anchor, T, now) {
    const synced = T && mode !== 'chill' && mode !== 'sulk';
    const base = synced ? T.base : anchor || Math.floor(now / WINDOW) * WINDOW;
    const key = `${mode}|${seed}|${skin}|${base}|${synced ? T.bar.toFixed(1) : ''}`;
    let tl = timelines.get(key);
    if (!tl) {
      if (timelines.size > 600) timelines.clear();
      tl = { rand: mulberry32(hashStr(key)), segs: [], end: 0, base, T: synced ? T : null };
      timelines.set(key, tl);
    }
    const t = Math.max(0, now - base);
    while (tl.end <= t) {
      const prev = tl.segs[tl.segs.length - 1];
      const s = nextSegment(mode, tl.rand, prev, skin, tl.T);
      // Tween: ease out of the previous clip to the ready stance, turn there
      // if the facing changes, and ease into this one. Skipped when nothing changes.
      const same = prev && prev.clip === s.clip && prev.view === s.view && prev.flip === s.flip;
      s.pre = !same && prev && M.clips[prev.clip].out ? prev : null;
      const frames = same || !M.clips[s.clip].in ? 0 : (s.pre ? M.clips[s.pre.clip].out.count : 0) + M.clips[s.clip].in.count;
      const loops = s.n * loopMs(s.clip, tl.T);
      if (tl.T) {
        s.tweenMs = frames ? tl.T.beat : 0; // on the beat: the tween takes the phrase's first beat
        s.dur = loops;
      } else {
        s.tweenMs = (frames * 1000) / tweenFps();
        s.dur = loops + s.tweenMs;
      }
      s.tweenFrames = frames;
      s.start = tl.end;
      tl.end += s.dur;
      tl.segs.push(s);
    }
    for (let i = tl.segs.length - 1; i >= 0; i--) {
      if (tl.segs[i].start <= t) return { tl, seg: tl.segs[i], dt: t - tl.segs[i].start, t };
    }
    return { tl, seg: tl.segs[0], dt: t, t };
  }

  function facing(seg, dt) {
    if (!seg.spin || dt >= SPIN_MS) return { view: seg.view, flip: seg.flip };
    const step = Math.floor((dt / SPIN_MS) * 4);
    return [{ view: 'side', flip: false }, { view: 'back', flip: false }, { view: 'side', flip: true }, { view: 'front', flip: false }][step];
  }

  // ---- drawing
  // A crowd faces the stage, so "facing out" is the back view and turning to
  // look at you is the front view.
  const TOWARD_STAGE = { front: 'back', back: 'front', side: 'side' };
  function showIdx(n, idx, view, flip) {
    if (n.dataset.face === 'stage') view = TOWARD_STAGE[view];
    const col = idx % M.cols;
    const row = M.views[view] + Math.floor(idx / M.cols);
    n.style.backgroundPosition = `${(col / (M.cols - 1)) * 100}% ${(row / (M.rows - 1)) * 100}%`;
    // Only the profile is mirrored (facing left); a mirrored front would swap accessories' sides.
    const tf = flip && view === 'side' ? 'scaleX(-1)' : '';
    if (n.style.transform !== tf) n.style.transform = tf;
  }
  function show(n, clip, frame, view, flip) {
    const c = M.clips[clip];
    showIdx(n, c.start + mod(frame, c.count), view, flip);
  }
  // Frame of a clip: locked to the bar when there's a tempo, else counted from `from`.
  function frameOf(clip, T, now, from, base) {
    const c = M.clips[clip];
    if (T && clip !== 'idle') {
      const L = loopMs(clip, T);
      return Math.floor((mod(now - base, L) / L) * c.count);
    }
    return Math.floor(((now - from) * c.fps) / 1000);
  }

  // Reactions and emotes ease in from the ready stance and back out to it.
  function placeReaction(n, re, now, T, base) {
    const c = M.clips[re.clip];
    const fps = tweenFps();
    const inMs = c.in ? (c.in.count * 1000) / fps : 0;
    const outMs = c.out ? (c.out.count * 1000) / fps : 0;
    const e = now - re.start;
    if (e < inMs) return showIdx(n, c.in.start + Math.floor((e * fps) / 1000), 'front', false);
    const left = re.until - now;
    if (left < outMs) return showIdx(n, c.out.start + Math.min(c.out.count - 1, Math.floor(((outMs - left) * fps) / 1000)), 'front', false);
    return show(n, re.clip, frameOf(re.clip, T, now, re.start + inMs, base), 'front', false);
  }

  function place(n, now) {
    const skin = n.dataset.cat;
    const mode = n.dataset.mode || 'still';
    const seed = n.dataset.seed || skin;
    if (mode === 'still') return show(n, 'idle', 0, 'front', false);
    const T = tempoOf(n);

    const re = reactions.get(seed);
    if (re && now >= re.start && now < re.until) return placeReaction(n, re, now, T, T ? T.base : 0);

    const anchor = +n.dataset.anchor || 0;
    const { tl, seg, dt, t } = timelineAt(mode, seed, skin, anchor, T, now);
    const songOn = anchor && (mode === 'dance' || mode === 'groove');

    // Crowd-wide moments while a song plays: everyone hits the same move on
    // every 8th bar, and a wave ripples across the floor every 16 bars.
    if (songOn) {
      const bar = T ? T.bar : 1600;
      const base = T ? T.base : anchor;
      const k = Math.floor((now - base) / bar);
      const into = now - base - k * bar;
      const x = n.dataset.x;
      if (x !== undefined && mod(k, 16) === 3) {
        const at = +x * bar * 0.75;
        if (into >= at && into < at + bar / 4) {
          const c = M.clips.jump;
          return show(n, 'jump', Math.floor(((into - at) / (bar / 4)) * c.count), 'front', false);
        }
      }
      if (k > 0 && mod(k, 8) === 7 && MOVES.length) {
        const drop = MOVES[hashStr(`drop|${base}|${k}`) % MOVES.length];
        return show(n, drop, Math.floor((into / bar) * M.clips[drop].count), 'front', false);
      }
    }

    if (dt < seg.tweenMs) {
      let i = Math.floor((dt / seg.tweenMs) * seg.tweenFrames);
      if (seg.pre) {
        const out = M.clips[seg.pre.clip].out;
        if (i < out.count) return showIdx(n, out.start + i, seg.pre.view, seg.pre.flip);
        i -= out.count;
      }
      const tin = M.clips[seg.clip].in;
      return showIdx(n, tin.start + Math.min(i, tin.count - 1), seg.view, seg.flip && !seg.spin);
    }
    const sinceTween = dt - seg.tweenMs;
    const { view, flip } = facing(seg, sinceTween);
    show(n, seg.clip, frameOf(seg.clip, tl.T, now, tl.base + seg.start + seg.tweenMs, tl.base), view, flip);
  }

  const Dance = {
    init(manifest) {
      M = manifest;
      MOVES = Object.keys(M.clips).filter((k) => M.clips[k].kind === 'move');
      DJ_MOVES = Object.keys(M.clips).filter((k) => M.clips[k].kind === 'dj');
      SIGNATURE = Object.fromEntries(M.cats.map((c) => [c.id, c.signature]));
      const root = document.documentElement.style;
      root.setProperty('--frame-w', M.frameWidth + 'px');
      root.setProperty('--frame-h', M.frameHeight + 'px');
      root.setProperty('--cols', M.cols);
      root.setProperty('--rows', M.rows);
    },
    attach(n, { skin, mode = 'still', seed, anchor = 0, face, bpm, offset, x }) {
      if (face) n.dataset.face = face;
      n.dataset.cat = skin;
      n.dataset.mode = mode;
      n.dataset.seed = seed || skin;
      n.dataset.anchor = anchor || 0;
      n.dataset.bpm = bpm || '';
      n.dataset.offset = offset ?? '';
      if (x !== undefined) n.dataset.x = x;
      if (M) place(n, Dance.now());
    },
    // A short reaction or emote for one seed, optionally after a delay.
    react(seed, clip, ms, delay = 0) {
      if (!M || !M.clips[clip]) return;
      const start = Dance.now() + delay;
      reactions.set(seed, { clip, start, until: start + ms });
    },
    seedRand: (str) => mulberry32(hashStr(str)),
    now: () => Date.now(),
    tick() {
      if (!M || document.hidden) return;
      const now = Dance.now();
      for (const n of document.querySelectorAll('.cat[data-cat]')) place(n, now);
    },
  };
  setInterval(() => Dance.tick(), 40);
  window.Dance = Dance;
})();
