/* God's Noisey BoyZ dance director.
 *
 * The sprite atlases hold every clip from three views (front, side, back); this
 * decides, moment to moment, which clip each cat plays, which way it faces and
 * when it spins, cheers or settles. Choices come from a seeded random sequence
 * anchored to the song's start time, so every friend sees the same dancing
 * without any extra network traffic.
 *
 * A cat element opts in with data attributes (set by Dance.attach):
 *   data-cat     skin id (sprite sheet)
 *   data-mode    dance | groove | chill | still
 *   data-seed    who this is (user id); picks their personal sequence
 *   data-anchor  server time the sequence starts from (the song's start), or 0
 *   data-face    "stage" for crowd cats seen from behind (they face the DJ)
 */
(() => {
  'use strict';

  let M = null;           // manifest from cats.json
  let SIGNATURE = {};     // skin id -> signature move
  let MOVES = [];         // clip ids of kind "move"
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
  const loopMs = (clip) => (M.clips[clip].count / M.clips[clip].fps) * 1000;

  // ---- choreography: each mode is a generator of segments
  //   { clip, view: front|side|back, flip, spin, dur }
  const SPIN_MS = 640; // front -> side -> back -> other side -> front
  function nextSegment(mode, rand, prev, skin) {
    const r = rand();
    if (mode === 'dance') {
      if (prev && prev.kind !== 'interlude' && r < 0.12) {
        const clip = rand() < 0.5 ? 'clap' : 'cheer';
        return { clip, view: 'front', flip: false, spin: false, dur: loopMs(clip) * (1 + Math.floor(rand() * 2)), kind: 'interlude' };
      }
      const sig = SIGNATURE[skin];
      let clip;
      if (!prev && sig && rand() < 0.6) clip = sig;
      else {
        // Weighted pick, signature move three times as likely, never the same move twice in a row.
        const pool = [];
        for (const m of MOVES) if (!prev || m !== prev.clip) pool.push(...Array(m === sig ? 3 : 1).fill(m));
        clip = pool[Math.floor(rand() * pool.length)];
      }
      const f = rand();
      const view = f < 0.55 ? 'front' : f < 0.75 ? 'side' : f < 0.86 ? 'back' : 'front';
      return { clip, view, flip: rand() < 0.5, spin: f >= 0.86, dur: loopMs(clip) * (2 + Math.floor(rand() * 3)), kind: 'move' };
    }
    if (mode === 'groove') {
      if (r < 0.15) return { clip: 'clap', view: 'front', flip: false, spin: false, dur: loopMs('clap') * 2, kind: 'interlude' };
      const side = rand() < 0.2;
      return { clip: 'bob', view: side ? 'side' : 'front', flip: rand() < 0.5, spin: false, dur: loopMs('bob') * (3 + Math.floor(rand() * 4)), kind: 'rest' };
    }
    // chill: mostly idle facing out, now and then looking around or bobbing along
    if (r < 0.12) return { clip: 'bob', view: 'front', flip: false, spin: false, dur: loopMs('bob') * 2, kind: 'rest' };
    const look = rand() < 0.18;
    return { clip: 'idle', view: look ? 'side' : 'front', flip: rand() < 0.5, spin: false, dur: loopMs('idle') * (look ? 1 : 2 + Math.floor(rand() * 3)), kind: 'rest' };
  }

  const WINDOW = 10 * 60e3; // sequences with no song to anchor them restart every 10 minutes
  function segmentAt(mode, seed, skin, anchor, now) {
    const base = anchor || Math.floor(now / WINDOW) * WINDOW;
    const key = `${mode}|${seed}|${skin}|${base}`;
    let tl = timelines.get(key);
    if (!tl) {
      if (timelines.size > 400) timelines.clear();
      tl = { rand: mulberry32(hashStr(key)), segs: [], end: 0 };
      timelines.set(key, tl);
    }
    const t = Math.max(0, now - base);
    while (tl.end <= t) {
      const prev = tl.segs[tl.segs.length - 1];
      const s = nextSegment(mode, tl.rand, prev, skin);
      // Tween in: ease out of the previous clip to the ready stance, turn there
      // if the facing changes, and ease into this clip. Skipped when nothing changes.
      const same = prev && prev.clip === s.clip && prev.view === s.view && prev.flip === s.flip;
      s.pre = !same && prev && M.clips[prev.clip].out ? prev : null;
      const frames = same || !M.clips[s.clip].in ? 0 : (s.pre ? M.clips[s.pre.clip].out.count : 0) + M.clips[s.clip].in.count;
      s.tweenMs = (frames * 1000) / (M.tweenFps || 12);
      s.dur += s.tweenMs;
      s.start = tl.end;
      tl.end += s.dur;
      tl.segs.push(s);
    }
    // Most lookups land in the newest segment; search backwards.
    for (let i = tl.segs.length - 1; i >= 0; i--) {
      if (tl.segs[i].start <= t) return { seg: tl.segs[i], dt: t - tl.segs[i].start };
    }
    return { seg: tl.segs[0], dt: t };
  }

  function facing(seg, dt) {
    if (!seg.spin || dt >= SPIN_MS) return { view: seg.view, flip: seg.flip };
    const step = Math.floor((dt / SPIN_MS) * 4);
    return [{ view: 'side', flip: false }, { view: 'back', flip: false }, { view: 'side', flip: true }, { view: 'front', flip: false }][step];
  }

  // ---- drawing
  function show(n, clip, frame, view, flip) {
    const c = M.clips[clip];
    showIdx(n, c.start + (frame % c.count), view, flip);
  }
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

  function place(n, now) {
    const skin = n.dataset.cat;
    const mode = n.dataset.mode || 'still';
    const seed = n.dataset.seed || skin;
    if (mode === 'still') return show(n, 'idle', 0, 'front', false);

    const re = reactions.get(seed);
    if (re && now >= re.start && now < re.until) {
      const c = M.clips[re.clip];
      return show(n, re.clip, Math.floor(((now - re.start) * c.fps) / 1000), 'front', false);
    }
    const { seg, dt } = segmentAt(mode, seed, skin, +n.dataset.anchor || 0, now);
    if (dt < seg.tweenMs) {
      let i = Math.floor((dt * (M.tweenFps || 12)) / 1000);
      if (seg.pre) {
        const out = M.clips[seg.pre.clip].out;
        if (i < out.count) return showIdx(n, out.start + i, seg.pre.view, seg.pre.flip);
        i -= out.count;
      }
      const tin = M.clips[seg.clip].in;
      return showIdx(n, tin.start + Math.min(i, tin.count - 1), seg.view, seg.flip && !seg.spin);
    }
    const t = dt - seg.tweenMs;
    const c = M.clips[seg.clip];
    const { view, flip } = facing(seg, t);
    show(n, seg.clip, Math.floor((t * c.fps) / 1000), view, flip);
  }

  const Dance = {
    init(manifest) {
      M = manifest;
      MOVES = Object.keys(M.clips).filter((k) => M.clips[k].kind === 'move');
      SIGNATURE = Object.fromEntries(M.cats.map((c) => [c.id, c.signature]));
      const root = document.documentElement.style;
      root.setProperty('--frame-w', M.frameWidth + 'px');
      root.setProperty('--frame-h', M.frameHeight + 'px');
      root.setProperty('--cols', M.cols);
      root.setProperty('--rows', M.rows);
    },
    attach(n, { skin, mode = 'still', seed, anchor = 0, face }) {
      if (face) n.dataset.face = face;
      n.dataset.cat = skin;
      n.dataset.mode = mode;
      n.dataset.seed = seed || skin;
      n.dataset.anchor = anchor || 0;
      if (M) place(n, Dance.now());
    },
    // A short reaction (cheer, jump, clap) for one seed, optionally after a delay.
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
