/* God's Noisey BoyZ: the 3D dancer.

   One figure on the floor under the booth, drawn with three.js. Every move is
   an AnimationClip on a named joint hierarchy and the mixer cross-fades
   between them, so any move can flow into any other at any moment. It runs on
   the song clock (app.js sets Dancer.now), and each clip is retimed so its
   beats land on the song's beats, phase-aligned, so the dancing stays in step
   with what everyone hears.

   Until motion-capture clips arrive the figure is a plain silhouette with
   procedural placeholder moves (see POSES). Drop a rig and clips into
   public/dancer/ with a manifest.json to animate it with real motion capture
   instead: see tools/dancer/README.md. */
import * as THREE from 'three';

const REF_BEAT = 0.5; // placeholder clips are authored at 120 BPM: one beat is 0.5 s
const FADE = 0.35;    // seconds to blend from one move into the next
// Which moves each mood draws from. A move repeated in a list is just more likely.
const MOVES = {
  dance: ['bounce', 'roof', 'twist', 'step', 'groove'],
  groove: ['groove', 'step', 'groove'],
  chill: ['idle'],
  sulk: ['boo'],
};
const ALIAS = { wave: 'cheer', disco: 'twist', robot: 'bounce' }; // emotes without a placeholder clip yet

const Dancer = Object.assign(window.Dancer || {}, { setSong, setMode, react, show, ready: false });
window.Dancer = Dancer;

/// ------------------------------------------------------------ the silhouette
// A figure of capsules hung on named joints. Limbs hang along their joint's
// -Y axis in the rest pose (arms by the sides, legs straight), so a joint's
// rotation about X swings the limb forward (negative) and back, and about Z
// swings it out to the side (negative for the left side).
const SKIN = new THREE.MeshStandardMaterial({ color: 0x1b1430, roughness: 0.8, metalness: 0.1 });
const JOINTS = ['hips', 'spine', 'neck', 'armL', 'foreL', 'armR', 'foreR', 'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR'];
const HIP_Y = 0.95;
const SOCKET = { x: 0.09, y: -0.02 }; // where each leg hangs from the hips
const THIGH = 0.45, SHIN = 0.45;
const ANKLE_Y = 0.03; // ankle height with the sole on the floor
const STANCE = 0.12;  // how far out from centre each foot stands

function joint(name, parent, x, y, z) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}
// A capsule hanging from (or standing on, if up) its joint.
function limb(parent, r, len, up = false) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 12), SKIN);
  m.position.y = up ? len / 2 : -len / 2;
  m.castShadow = true;
  parent.add(m);
  return m;
}
function buildSilhouette() {
  const root = new THREE.Group();
  root.name = 'dancer';
  const hips = joint('hips', root, 0, HIP_Y, 0);
  const pelvis = limb(hips, 0.13, 0.3, true);
  pelvis.rotation.z = Math.PI / 2; // lying across the hips
  pelvis.position.set(0, 0.01, 0);
  const spine = joint('spine', hips, 0, 0.04, 0);
  limb(spine, 0.135, 0.52, true);
  const neck = joint('neck', spine, 0, 0.5, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 14), SKIN);
  head.position.y = 0.17;
  head.castShadow = true;
  neck.add(head);
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const arm = joint('arm' + side, spine, s * 0.2, 0.45, 0);
    limb(arm, 0.05, 0.3);
    const fore = joint('fore' + side, arm, 0, -0.3, 0);
    limb(fore, 0.046, 0.32); // forearm and hand
    const leg = joint('leg' + side, hips, s * SOCKET.x, SOCKET.y, 0);
    limb(leg, 0.07, THIGH);
    const shin = joint('shin' + side, leg, 0, -THIGH, 0);
    limb(shin, 0.055, SHIN);
    const foot = joint('foot' + side, shin, 0, -SHIN, 0); // the ankle
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), SKIN);
    sole.position.set(0, 0, 0.06);
    sole.castShadow = true;
    foot.add(sole);
  }
  return root;
}

// ------------------------------------------------------------ legs
// The legs are never posed by hand. A pose says where the feet are (on the
// floor unless it moves one) and where the hips are, and the knees are solved
// to connect the two, so the body can sway, bounce, lean and twist on top of
// planted feet instead of the legs swinging under it like a pendulum.
const Y_UP = new THREE.Vector3(0, 1, 0);
// The orientation of a limb pointing along dir, its front (local +Z) toward fwd.
function limbQuat(dir, fwd) {
  const y = dir.clone().negate();
  const z = fwd.clone().addScaledVector(y, -fwd.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
// Rotations for one leg that put its ankle at target (a point in the room)
// given where the hips are: the knee bends forward and a little out, and the
// foot sits flat, turned by yaw degrees. Writes leg, shin and foot into out.
function solveLeg(side, hipPos, hipQ, target, yaw, out) {
  const s = side === 'L' ? -1 : 1;
  const socket = new THREE.Vector3(s * SOCKET.x, SOCKET.y, 0).applyQuaternion(hipQ).add(hipPos);
  const d = new THREE.Vector3().subVectors(target, socket);
  const reach = THREE.MathUtils.clamp(d.length(), 0.1, THIGH + SHIN - 0.003); // out of reach: the foot comes up a touch
  d.normalize();
  const pole = new THREE.Vector3(s * 0.3, 0, 1).normalize(); // which way the knee points
  // Law of cosines: how far the thigh swings off the hip-to-ankle line toward the knee's side.
  const bend = Math.acos(THREE.MathUtils.clamp((THIGH * THIGH + reach * reach - SHIN * SHIN) / (2 * THIGH * reach), -1, 1));
  const axis = new THREE.Vector3().crossVectors(d, pole).normalize();
  const thighDir = d.clone().applyAxisAngle(axis, bend);
  const knee = socket.clone().addScaledVector(thighDir, THIGH);
  const shinDir = socket.clone().addScaledVector(d, reach).sub(knee).normalize();
  const qThigh = limbQuat(thighDir, pole), qShin = limbQuat(shinDir, pole);
  const qFoot = new THREE.Quaternion().setFromAxisAngle(Y_UP, THREE.MathUtils.degToRad(yaw));
  out['leg' + side] = hipQ.clone().invert().multiply(qThigh);
  out['shin' + side] = qThigh.clone().invert().multiply(qShin);
  out['foot' + side] = qShin.clone().invert().multiply(qFoot);
}

// ------------------------------------------------------------ placeholder moves
// Each pose function takes b, the position in beats through the clip, and
// returns joint rotations in degrees [x, y, z] for the body and arms, an
// offset of the hips (x, y, z), and optionally where the ankles are (ankleL,
// ankleR, points in the room; on the floor in a natural stance by default)
// and how far the toes turn (toesL, toesR). They're periodic in the clip's
// length, so every loop is seamless.
const S = (b, per = 1, ph = 0) => Math.sin(2 * Math.PI * (b / per + ph));
const C = (b, per = 1, ph = 0) => Math.cos(2 * Math.PI * (b / per + ph));
const dip = (b) => (1 + C(b)) / 2; // a bounce that bottoms out on every beat
// Hips lowered to bend the knees by k: 0 straight, 1 an easy bend, 2 a crouch.
const crouch = (k) => ({ y: -0.075 * k });
// An ankle for side s: out from its stance, up off the floor, forward.
const ankle = (s, out = 0, up = 0, fwd = 0) => [s * (STANCE + out), ANKLE_Y + up, fwd];

const POSES = {
  // Standing around between songs: breathing and shifting weight.
  idle: { beats: 4, pose: (b) => ({
    ...crouch(0.08 + 0.04 * C(b, 2)),
    x: 0.03 * S(b, 4), hips: [0, 4 * S(b, 4), 2.5 * S(b, 4)],
    spine: [2 + 1.5 * C(b, 2), -3 * S(b, 4), -2 * S(b, 4)], neck: [3 * C(b, 4, 0.25), 8 * S(b, 4, 0.1), 0],
    armL: [4 * S(b, 4), 0, -6], foreL: [-10 - 3 * C(b, 2), 0, 0], armR: [-4 * S(b, 4), 0, 6], foreR: [-10 - 3 * C(b, 2, 0.5), 0, 0],
  }) },
  // Nodding along: a knee bounce on every beat, weight rocking side to side every two.
  groove: { beats: 4, pose: (b) => { const d = dip(b), sw = S(b, 2); return {
    ...crouch(0.4 + 0.5 * d), x: 0.04 * sw,
    hips: [0, 6 * sw, -3 * sw], spine: [4 + 3 * d, -6 * sw, 5 * sw], neck: [10 * d - 4, 5 * sw, 0],
    armL: [12 * sw, 0, -10], foreL: [-30 - 10 * d, 0, 0], armR: [-12 * sw, 0, 10], foreR: [-30 - 10 * d, 0, 0],
  }; } },
  // Big bounce with fists pumping.
  bounce: { beats: 2, pose: (b) => { const d = dip(b), sw = S(b, 2), pump = C(b); return {
    ...crouch(0.3 + 1.0 * d),
    hips: [0, 8 * sw, 0], spine: [8 + 4 * d, -8 * sw, 0], neck: [12 * d - 6, 0, 0],
    armL: [-40 - 25 * pump, 0, -20], foreL: [-100, 0, 20], armR: [-40 + 25 * pump, 0, 20], foreR: [-100, 0, -20],
  }; } },
  // Raise the roof: both hands overhead, pushing up on the beat.
  roof: { beats: 4, pose: (b) => { const d = dip(b), push = (1 - C(b)) / 2, sw = S(b, 2); return {
    ...crouch(0.3 + 0.5 * d), x: 0.03 * sw,
    hips: [0, 5 * sw, 0], spine: [-4, 0, 3 * sw], neck: [-12, 0, 0],
    armL: [-20, 0, -160 + 8 * sw], foreL: [-55 * push, 0, 0], armR: [-20, 0, 160 + 8 * sw], foreR: [-55 * push, 0, 0],
  }; } },
  // The twist: hips one way, shoulders the other, knees pumping double time,
  // feet pivoting on the spot.
  twist: { beats: 4, pose: (b) => { const t = S(b, 2), d = dip(b * 2); return {
    ...crouch(0.4 + 0.45 * d),
    hips: [0, 40 * t, 0], spine: [6, -30 * t, 0], neck: [4, -15 * t, 0], toesL: -6 + 20 * t, toesR: 6 + 20 * t,
    armL: [-10 + 15 * t, 0, -30], foreL: [-95, 0, 30], armR: [-10 - 15 * t, 0, 30], foreR: [-95, 0, -30],
  }; } },
  // Step-touch: weight onto the left foot for two beats while the right taps
  // in beside it on each beat, then the other way, arms swinging across.
  step: { beats: 4, pose: (b) => {
    const lean = S(b, 4), d = dip(b), sw = S(b, 2), lift = Math.abs(S(b, 2)); // lift is down on every beat
    const onL = Math.max(0, lean), onR = Math.max(0, -lean); // how much weight is on that foot
    return {
      ...crouch(0.3 + 0.35 * d), x: -0.1 * lean,
      hips: [0, -8 * lean, -6 * lean], spine: [4, 10 * lean, 8 * lean], neck: [4, -6 * lean, -5 * lean],
      ankleR: ankle(1, -0.1 * onL, 0.08 * onL * lift, 0.03 * onL), ankleL: ankle(-1, -0.1 * onR, 0.08 * onR * lift, 0.03 * onR),
      armL: [-25 - 20 * sw, 0, -15], foreL: [-60, 0, 10], armR: [-25 + 20 * sw, 0, 15], foreR: [-60, 0, -10],
    };
  } },
  // Reactions: arms up and waving, clapping, a jump (plays once), and booing.
  cheer: { beats: 2, pose: (b) => { const w = S(b), d = dip(b); return {
    ...crouch(0.15 + 0.3 * d),
    hips: [0, 0, 0], spine: [-6, 0, 4 * w], neck: [-15, 0, 0],
    armL: [-165, 0, -30 + 15 * w], foreL: [-20, 0, 15 * w], armR: [-165, 0, 30 + 15 * w], foreR: [-20, 0, 15 * w],
  }; } },
  clap: { beats: 2, pose: (b) => { const c = dip(b), d = dip(b); return {
    ...crouch(0.2 + 0.25 * d),
    hips: [0, 0, 0], spine: [6, 0, 0], neck: [8 * d, 0, 0],
    armL: [-45, 0, -25 + 28 * c], foreL: [-95, 0, 25 * c], armR: [-45, 0, 25 - 28 * c], foreR: [-95, 0, -25 * c],
  }; } },
  jump: { beats: 2, once: true, pose: (b) => {
    let k, air = 0;
    if (b < 0.6) k = 0.2 + 1.5 * (b / 0.6);                              // sink
    else if (b < 1.4) {                                                   // push off and fly, legs tucked a little
      air = Math.sin(Math.PI * (b - 0.6) / 0.8);
      const e = Math.min(1, (b - 0.6) / 0.15);
      k = 1.7 * (1 - e) + 0.6 * air * e;
    } else k = 0.2 + 1.5 * Math.sin(Math.PI * (b - 1.4) / 0.6);          // land and absorb
    const h = 0.45 * air;
    return {
      y: crouch(k).y + h, ankleL: ankle(-1, 0, h + 0.12 * air, -0.05 * air), ankleR: ankle(1, 0, h + 0.12 * air, -0.05 * air),
      hips: [0, 0, 0], spine: [8 * (1 - air) - 4 * air, 0, 0], neck: [-6 - 10 * air, 0, 0],
      armL: [-20 * (1 - air) + 20 * air, 0, -20 - 140 * air], foreL: [-30, 0, 0], armR: [-20 * (1 - air) + 20 * air, 0, 20 + 140 * air], foreR: [-30, 0, 0],
    };
  } },
  boo: { beats: 4, pose: (b) => ({
    ...crouch(0.2), x: 0.04,
    hips: [-4, 0, 3], spine: [-8, 0, -2], neck: [6, 18 * S(b), 0],
    armL: [-60, 0, 20], foreL: [-120, 0, 55], armR: [-60, 0, -20], foreR: [-120, 0, -55],
  }) },
};

// Bake a pose function into a clip: 30 samples a second at the reference tempo.
function bakeClip(name, { beats, pose }, fps = 30) {
  const n = Math.round(beats * REF_BEAT * fps);
  const times = [], pos = [], rot = {};
  for (const j of JOINTS) rot[j] = [];
  const e = new THREE.Euler(), rad = THREE.MathUtils.degToRad;
  const hipPos = new THREE.Vector3(), target = new THREE.Vector3();
  for (let i = 0; i <= n; i++) { // the last sample repeats the first so loops are seamless
    const p = pose(((i % n) / n) * beats);
    times.push(i / fps);
    hipPos.set(p.x || 0, HIP_Y + (p.y || 0), p.z || 0);
    pos.push(hipPos.x, hipPos.y, hipPos.z);
    const q = {};
    for (const j of JOINTS) {
      const r = p[j] || [0, 0, 0];
      e.set(rad(r[0]), rad(r[1]), rad(r[2]));
      q[j] = new THREE.Quaternion().setFromEuler(e);
    }
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? -1 : 1;
      target.fromArray(p['ankle' + side] || ankle(s));
      solveLeg(side, hipPos, q.hips, target, p['toes' + side] ?? s * 6, q);
    }
    for (const j of JOINTS) rot[j].push(q[j].x, q[j].y, q[j].z, q[j].w);
  }
  const tracks = [new THREE.VectorKeyframeTrack('hips.position', times, pos)];
  for (const j of JOINTS) tracks.push(new THREE.QuaternionKeyframeTrack(j + '.quaternion', times, rot[j]));
  return new THREE.AnimationClip(name, -1, tracks);
}

// ------------------------------------------------------------ real clips
// public/dancer/manifest.json names a rig and clips (FBX straight from
// Mixamo, or glTF). Untested until the first clips land; see tools/dancer.
async function loadRig(man) {
  const ext = (f) => f.split('.').pop().toLowerCase();
  const load = async (file) => {
    if (ext(file) === 'fbx') {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      return new FBXLoader().loadAsync('dancer/' + file);
    }
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const g = await new GLTFLoader().loadAsync('dancer/' + file);
    g.scene.animations = g.animations;
    return g.scene;
  };
  const root = await load(man.rig);
  if (ext(man.rig) === 'fbx') root.scale.setScalar(man.scale || 0.01); // Mixamo works in centimetres
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  const clips = {}, beats = {}, once = new Set(man.once || ['jump']);
  for (const [name, c] of Object.entries(man.clips)) {
    const src = typeof c === 'string' ? { file: c } : c;
    const o = await load(src.file);
    const clip = o.animations && o.animations[0];
    if (!clip) continue;
    clip.name = name;
    clips[name] = clip;
    beats[name] = src.beats || 4; // how many beats one loop of the clip covers
  }
  return { root, clips, beats, once };
}

// ------------------------------------------------------------ scene
let renderer, scene, camera, mixer, root;
const actions = {}, beatsOf = {}, onceOf = new Set();
let song = null;   // { key, beatMs, beat0 }
let mode = 'chill';
let current = null; // { name, action }
let reaction = null; // { name, until }
let lastT = 0;
let visible = true;

async function init() {
  const canvas = document.getElementById('floor-canvas');
  if (!canvas) return;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 1.35, 4.4);
  camera.lookAt(0, 0.92, 0);

  // Stage lighting: a warm spot from the front, neon rims from behind so the
  // silhouette has an edge, and a dim fill so nothing goes fully black.
  scene.add(new THREE.HemisphereLight(0x8a7bb8, 0x120e1d, 0.5));
  const spot = new THREE.SpotLight(0xffd9a0, 30, 14, 0.45, 0.7, 1.4);
  spot.position.set(0.8, 4.2, 2.6);
  spot.target.position.set(0, 0.9, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0004;
  scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight(0x5de0ff, 3);
  rim.position.set(-2, 2.5, -3);
  const rim2 = new THREE.DirectionalLight(0xff5fb8, 2);
  rim2.position.set(2.5, 2, -2.5);
  scene.add(rim, rim2);
  // The floor only catches the shadow: the page shows through everywhere else.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.ShadowMaterial({ opacity: 0.5 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  let rig = null;
  try {
    const res = await fetch('dancer/manifest.json', { cache: 'no-cache' });
    if (res.ok) rig = await loadRig(await res.json());
  } catch (err) {
    console.warn('Dancer: could not load the rig, using the silhouette', err);
  }
  let clips;
  if (rig) {
    ({ root, clips } = rig);
    Object.assign(beatsOf, rig.beats);
    for (const n of rig.once) onceOf.add(n);
  } else {
    root = buildSilhouette();
    clips = {};
    for (const [name, def] of Object.entries(POSES)) {
      clips[name] = bakeClip(name, def);
      beatsOf[name] = def.beats;
      if (def.once) onceOf.add(name);
    }
  }
  scene.add(root);
  mixer = new THREE.AnimationMixer(root);
  for (const [name, clip] of Object.entries(clips)) {
    const a = mixer.clipAction(clip);
    if (onceOf.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    actions[name] = a;
  }

  const fit = () => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(fit).observe(canvas);
  fit();
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);

  Dancer.ready = true;
  lastT = now();
  requestAnimationFrame(tick);
}

const now = () => (Dancer.now ? Dancer.now() : Date.now());
const mod = (a, b) => ((a % b) + b) % b;
// Where the song is, in beats (fractional; negative before the first beat).
const beatAt = (t) => (song ? (t - song.beat0) / song.beatMs : t / (REF_BEAT * 1000));
// Playback speed that puts one of the clip's beats on one of the song's.
function speedOf(name) {
  const clipBeat = actions[name].getClip().duration / beatsOf[name];
  return song ? (clipBeat * 1000) / song.beatMs : clipBeat / REF_BEAT;
}

// ---- the song and mood (set by app.js)
function setSong(s) {
  if (!s) { song = null; return; }
  // One move loop is one bar of 4 beats, halved or doubled so a bar always
  // lasts 1.2-2.7 s (the same rule as the sprite dancers and the emote timing).
  let bar = s.bpm > 0 ? (4 * 60000) / s.bpm : 2000;
  while (bar < 1200) bar *= 2;
  while (bar > 2700) bar /= 2;
  song = { key: s.key, beatMs: bar / 4, beat0: s.anchor + (s.offset || 0) };
  if (current) current.action.timeScale = speedOf(current.name);
}
function setMode(m) { mode = MOVES[m] ? m : 'chill'; }
// A one-off reaction (cheer, jump, clap, boo...) for ms, then back to dancing.
function react(clip, ms, delay = 0) {
  const name = ALIAS[clip] || clip;
  if (!actions[name]) return;
  if (delay > 0) { setTimeout(() => react(clip, ms), delay); return; }
  const t = now();
  const length = onceOf.has(name) ? (actions[name].getClip().duration / speedOf(name)) * 1000 : ms;
  reaction = { name, until: t + length };
}

// Preview one move on loop (Dancer.show('twist') in the console); show() to stop.
function show(clip) {
  const name = ALIAS[clip] || clip;
  reaction = actions[name] ? { name, until: Infinity } : null;
}
// Advance by s seconds and draw, for checking poses from the console.
Dancer.step = (s) => { const t = now(); const name = wanted(t); if (name && (!current || current.name !== name)) play(name, t); mixer.update(s); renderer.render(scene, camera); };
Dancer.state = () => ({
  current: current && current.name, mixerTime: mixer && mixer.time, song, mode,
  actions: Object.entries(actions).filter(([, a]) => a.isRunning() || a.getEffectiveWeight() > 0)
    .map(([n, a]) => `${n} w=${a.getEffectiveWeight().toFixed(2)} t=${a.time.toFixed(2)} x${a.timeScale.toFixed(2)}`),
});

// ---- choreography: a seeded plan per song and mood, so every client agrees
function hashStr(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seedRand(seed) {
  let a = hashStr(seed);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const plans = new Map();
function planFor(key, m) {
  const id = key + '|' + m;
  if (plans.has(id)) return plans.get(id);
  const rand = seedRand(id);
  const pool = MOVES[m].filter((n) => actions[n]);
  const segs = [];
  let start = 0, last = null;
  while (start < 6000 && pool.length) { // ~40 minutes of beats, more than any song
    let move;
    do move = pool[Math.floor(rand() * pool.length)]; while (pool.length > 1 && move === last);
    const beats = (m === 'dance' ? 8 : 16) * (rand() < 0.5 ? 1 : 2); // 2-4 bars dancing, 4-8 grooving
    segs.push({ move, start, beats });
    start += beats;
    last = move;
  }
  plans.set(id, segs);
  return segs;
}
function wanted(t) {
  if (reaction && t < reaction.until) return reaction.name;
  reaction = null;
  if (!song) return actions.idle ? 'idle' : null;
  const segs = planFor(song.key, mode);
  if (!segs.length) return null;
  const beat = Math.max(0, beatAt(t));
  let seg = segs[0];
  for (const s of segs) { if (s.start > beat) break; seg = s; }
  return seg.move;
}

// Start a move now, blended from whatever is playing, in step with the song.
function play(name, t) {
  const next = actions[name];
  next.reset();
  next.timeScale = speedOf(name);
  if (!onceOf.has(name)) next.time = mod(beatAt(t), beatsOf[name]) * (next.getClip().duration / beatsOf[name]);
  next.play();
  if (current && current.action !== next) current.action.crossFadeTo(next, FADE, false);
  current = { name, action: next };
}

function tick() {
  requestAnimationFrame(tick);
  if (document.hidden || !visible) { lastT = now(); return; }
  const t = now();
  // Frames can be slow (a background tab, a throttled pane): the mixer still
  // covers the whole gap so moves run at song speed and fades finish. The
  // song clock can nudge backwards a little; never run the mixer backwards.
  const dt = Math.min(2, Math.max(0, (t - lastT) / 1000));
  lastT = t;
  const name = wanted(t);
  if (name && (!current || current.name !== name)) play(name, t);
  mixer.update(dt);
  renderer.render(scene, camera);
}

init();
