/* God's Noisey BoyZ: the dance floor.

   A crowd of figures in front of the booth, drawn with three.js. The one at
   the front is you; the rest are the crowd. Every move is an AnimationClip
   baked from a pose function on a named joint hierarchy, and each figure has
   its own mixer cross-fading between moves, so any move can flow into any
   other at any moment. Everything runs on the song clock (app.js sets
   Dancer.now) and every clip is retimed so its beats land on the song's
   beats, phase-aligned, so the whole floor stays in step with what everyone
   hears. Each figure picks its own moves (seeded, so the same song gets the
   same choreography on every screen) and lags the beat by a few milliseconds
   of its own, so the crowd moves together without moving in lockstep.

   The legs are never posed by hand: a pose says where the hips and the feet
   are, and the knees are solved to connect them, so the feet stay planted. */
import * as THREE from 'three';

const REF_BEAT = 0.5; // clips are authored at 120 BPM: one beat is 0.5 s
const FADE = 0.35;    // seconds to blend from one move into the next
// Which moves each mood draws from. A move repeated in a list is just more likely.
const MOVES = {
  dance: ['bounce', 'roof', 'twist', 'step', 'pump', 'shuffle', 'kick', 'point', 'wave', 'sway', 'rock', 'disco'],
  groove: ['groove', 'sway', 'bob', 'step', 'rock', 'bob', 'groove'],
  chill: ['idle', 'look', 'phone', 'tap', 'stretch', 'idle'],
  sulk: ['boo', 'crossed', 'slump'],
};
const SEG = { dance: 8, groove: 16, chill: 16, sulk: 16 }; // beats a figure keeps a move for (or twice that)
// Where the crowd stands, in rows behind you (you're at the origin), and the
// shades the figures come in.
const ROWS = [
  { z: -1.1, xs: [-2.85, -1.9, -0.95, 0.95, 1.9, 2.85] },
  { z: -2.0, xs: [-3.35, -2.4, -1.45, -0.5, 0.5, 1.45, 2.4, 3.35] },
  { z: -2.9, xs: [-3.8, -2.85, -1.9, -0.95, 0, 0.95, 1.9, 2.85, 3.8] },
];
const TINTS = [0x1b1430, 0x161a33, 0x241530, 0x121d2c, 0x201a2e];
const ME_TINT = { color: 0x4b3590, emissive: 0x160b2e }; // you stand out from the crowd

const Dancer = Object.assign(window.Dancer || {}, { setSong, setMode, setRoom, react, show, ready: false });
window.Dancer = Dancer;

// ------------------------------------------------------------ the silhouette
// A figure of capsules hung on named joints. Limbs hang along their joint's
// -Y axis in the rest pose (arms by the sides, legs straight), so a joint's
// rotation about X swings the limb forward (negative) and back, and about Z
// swings it out to the side (negative for the left side).
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
function limb(parent, mat, r, len, up = false) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 12), mat);
  m.position.y = up ? len / 2 : -len / 2;
  m.castShadow = true;
  parent.add(m);
  return m;
}
function buildSilhouette(mat) {
  const root = new THREE.Group();
  const hips = joint('hips', root, 0, HIP_Y, 0);
  const pelvis = limb(hips, mat, 0.13, 0.3, true);
  pelvis.rotation.z = Math.PI / 2; // lying across the hips
  pelvis.position.set(0, 0.01, 0);
  const spine = joint('spine', hips, 0, 0.04, 0);
  limb(spine, mat, 0.135, 0.52, true);
  const neck = joint('neck', spine, 0, 0.5, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 14), mat);
  head.position.y = 0.17;
  head.castShadow = true;
  neck.add(head);
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const arm = joint('arm' + side, spine, s * 0.2, 0.45, 0);
    limb(arm, mat, 0.05, 0.3);
    const fore = joint('fore' + side, arm, 0, -0.3, 0);
    limb(fore, mat, 0.046, 0.32); // forearm and hand
    const leg = joint('leg' + side, hips, s * SOCKET.x, SOCKET.y, 0);
    limb(leg, mat, 0.07, THIGH);
    const shin = joint('shin' + side, leg, 0, -THIGH, 0);
    limb(shin, mat, 0.055, SHIN);
    const foot = joint('foot' + side, shin, 0, -SHIN, 0); // the ankle
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), mat);
    sole.position.set(0, 0, 0.06);
    sole.castShadow = true;
    foot.add(sole);
  }
  return root;
}

// ------------------------------------------------------------ legs
// A pose says where the feet are (on the floor unless it moves one) and where
// the hips are, and the knees are solved to connect the two, so the body can
// sway, bounce, lean and twist on top of planted feet instead of the legs
// swinging under it like a pendulum.
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

// ------------------------------------------------------------ the moves
// Each pose function takes b, the position in beats through the clip, and
// returns joint rotations in degrees [x, y, z] for the body and arms, an
// offset of the hips (x, y, z), and optionally where the ankles are (ankleL,
// ankleR, points in the room; on the floor in a natural stance by default)
// and how far the toes turn (toesL, toesR). They're periodic in the clip's
// length, so every loop is seamless. All of them stay on the spot, so they
// work in a crowd.
const S = (b, per = 1, ph = 0) => Math.sin(2 * Math.PI * (b / per + ph));
const C = (b, per = 1, ph = 0) => Math.cos(2 * Math.PI * (b / per + ph));
const dip = (b) => (1 + C(b)) / 2;        // 1 on every beat, 0 between
const half = (b, per) => Math.max(0, S(b, per)); // the first half of a cycle, as a hump
const lerp = (a, b, k) => a + (b - a) * k;
const lerpA = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
const ease = (k) => 1 - (1 - k) * (1 - k);
// Hips lowered to bend the knees by k: 0 straight, 1 an easy bend, 2 a crouch.
const crouch = (k) => ({ y: -0.075 * k });
// An ankle for side s: out from its stance, up off the floor, forward.
const ankle = (s, out = 0, up = 0, fwd = 0) => [s * (STANCE + out), ANKLE_Y + up, fwd];
// Arms hanging loose at the sides, swinging forward by sw degrees (left one first).
const loose = (sw = 0, bend = 15) => ({ armL: [sw, 0, -8], foreL: [-bend, 0, 0], armR: [-sw, 0, 8], foreR: [-bend, 0, 0] });

// The robot's key poses: it snaps from one to the next on each beat.
const ROBOT = [
  { armL: [-90, 0, 0], foreL: [0, 0, -90], armR: [-90, 0, 0], foreR: [-90, 0, 0], neck: [0, 25, 0], spine: [0, 0, 0] },
  { armL: [-90, 0, 0], foreL: [-90, 0, 0], armR: [-90, 0, 0], foreR: [0, 0, 90], neck: [0, -25, 0], spine: [0, 0, 0] },
  { armL: [0, 0, -90], foreL: [-90, 0, 0], armR: [-90, 0, 0], foreR: [-90, 0, 0], neck: [15, 0, 0], spine: [0, 12, 0] },
  { armL: [-90, 0, 0], foreL: [-90, 0, 0], armR: [0, 0, 90], foreR: [-90, 0, 0], neck: [-10, 0, 0], spine: [0, -12, 0] },
];

const POSES = {
  // ---- idling between songs
  // Standing around: breathing and shifting weight.
  idle: { beats: 4, pose: (b) => ({
    ...crouch(0.08 + 0.04 * C(b, 2)),
    x: 0.03 * S(b, 4), hips: [0, 4 * S(b, 4), 2.5 * S(b, 4)],
    spine: [2 + 1.5 * C(b, 2), -3 * S(b, 4), -2 * S(b, 4)], neck: [3 * C(b, 4, 0.25), 8 * S(b, 4, 0.1), 0],
    armL: [4 * S(b, 4), 0, -6], foreL: [-10 - 3 * C(b, 2), 0, 0], armR: [-4 * S(b, 4), 0, 6], foreR: [-10 - 3 * C(b, 2, 0.5), 0, 0],
  }) },
  // Looking around the room, one hand on a hip.
  look: { beats: 8, pose: (b) => ({
    ...crouch(0.12 + 0.03 * C(b, 4)), x: 0.04 * S(b, 8, 0.25),
    hips: [0, 6 * S(b, 8, 0.25), 3 * S(b, 8, 0.25)], spine: [3, 8 * S(b, 8), -3 * S(b, 8, 0.25)],
    neck: [4 * C(b, 8, 0.3) - 2, 32 * S(b, 8) + 8 * S(b, 3), 0],
    armL: [3 * S(b, 4), 0, -6], foreL: [-12, 0, 0], armR: [0, 0, 28], foreR: [-45, 0, -75],
  }) },
  // Head down, thumbing a phone held in front of the chest.
  phone: { beats: 8, pose: (b) => ({
    ...crouch(0.15), x: 0.03 * S(b, 8),
    hips: [0, 0, 2 * S(b, 8)], spine: [9, 0, -2 * S(b, 8)], neck: [26 + 2 * S(b, 4), 4 * S(b, 8), 0],
    armL: [-28, 0, -8], foreL: [-105, 0, 32], armR: [-30, 0, 8], foreR: [-108 - 3 * S(b, 1.5), 0, -30],
  }) },
  // Arms folded, nodding and tapping a toe.
  tap: { beats: 4, pose: (b) => { const d = dip(b); return {
    ...crouch(0.15), x: -0.04, hips: [0, 0, -3],
    spine: [4, 0, 3], neck: [5 * d, 0, 0], ankleR: ankle(1, 0.02, 0.035 * Math.abs(S(b, 2)), 0.04),
    armL: [-40, 0, 15], foreL: [-100, 0, 60], armR: [-40, 0, -15], foreR: [-100, 0, -60],
  }; } },
  // A long stretch: both arms up and over, then down again.
  stretch: { beats: 8, pose: (b) => { const a = (1 - C(b, 8)) / 2; return {
    ...crouch(0.1 + 0.05 * a),
    hips: [0, 0, 0], spine: [2 - 8 * a, 0, 3 * S(b, 8)], neck: [-18 * a, 0, 0],
    armL: [-172 * a, 0, -8 - 12 * a], foreL: [-12 + 4 * a, 0, 0], armR: [-172 * a, 0, 8 + 12 * a], foreR: [-12 + 4 * a, 0, 0],
  }; } },

  // ---- grooving along
  // Nodding along: a knee bounce on every beat, weight rocking side to side every two.
  groove: { beats: 4, pose: (b) => { const d = dip(b), sw = S(b, 2); return {
    ...crouch(0.4 + 0.5 * d), x: 0.04 * sw,
    hips: [0, 6 * sw, -3 * sw], spine: [4 + 3 * d, -6 * sw, 5 * sw], neck: [10 * d - 4, 5 * sw, 0],
    armL: [12 * sw, 0, -10], foreL: [-30 - 10 * d, 0, 0], armR: [-12 * sw, 0, 10], foreR: [-30 - 10 * d, 0, 0],
  }; } },
  // The small one: a head bob and a shoulder dip on the beat, arms hanging.
  bob: { beats: 4, pose: (b) => { const d = dip(b); return {
    ...crouch(0.3 + 0.15 * d), x: 0.015 * S(b, 4),
    hips: [0, 3 * S(b, 4), 0], spine: [3 + 2 * d, -3 * S(b, 4), 2 * S(b, 2)], neck: [9 * d - 3, 4 * S(b, 4), 0],
    ...loose(5 * S(b, 2), 20),
  }; } },
  // Swaying: weight rolling from foot to foot every two beats, arms loose.
  sway: { beats: 4, pose: (b) => { const lean = S(b, 4), d = dip(b); return {
    ...crouch(0.45 + 0.3 * d), x: -0.08 * lean,
    hips: [0, -6 * lean, -7 * lean], spine: [3 + 2 * d, 8 * lean, 9 * lean], neck: [6 * d - 2, -8 * lean, -6 * lean],
    armL: [6 * S(b, 2), 0, -14 - 10 * lean], foreL: [-25, 0, 0], armR: [-6 * S(b, 2), 0, 14 - 10 * lean], foreR: [-25, 0, 0],
  }; } },
  // Rocking front to back, one foot forward, elbows pumping low.
  rock: { beats: 4, pose: (b) => { const f = S(b, 4), d = dip(b); return {
    ...crouch(0.45 + 0.3 * d), z: 0.1 * f, x: -0.03 * f,
    hips: [3 * f, -6, 0], spine: [5 + 6 * f, 4, 0], neck: [6 * d - 4 - 4 * f, -4, 0],
    ankleL: ankle(-1, 0, 0, 0.15), ankleR: ankle(1, 0.02, 0, -0.1), toesL: -10, toesR: 16,
    armL: [-22 - 14 * C(b), 0, -12], foreL: [-85, 0, 10], armR: [-22 + 14 * C(b), 0, 12], foreR: [-85, 0, -10],
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

  // ---- dancing
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
  // One fist in the air, pulled down hard on every beat.
  pump: { beats: 2, pose: (b) => { const d = dip(b), up = 1 - d; return {
    ...crouch(0.5 + 0.4 * d), x: 0.02 * S(b, 2),
    hips: [0, -10, 0], spine: [6 - 4 * up, -6, -4], neck: [8 * d - 6, 4, 0],
    armL: [0, 0, -10], foreL: [-25, 0, 0], armR: [-95 - 70 * up, 0, 22], foreR: [-80 + 70 * up, 0, -5],
  }; } },
  // The running man, on the spot: knees driving up on alternate beats, arms pumping.
  shuffle: { beats: 2, pose: (b) => { const l = half(b, 2), r = half(b - 1, 2); return {
    ...crouch(0.6 + 0.25 * Math.abs(S(b, 2))),
    hips: [0, 0, -5 * (l - r)], spine: [10, 0, 2 * (l - r)], neck: [-4, 0, 0],
    ankleL: ankle(-1, 0, 0.24 * l, 0.1 * l), ankleR: ankle(1, 0, 0.24 * r, 0.1 * r),
    armL: [-10 - 45 * r + 15 * l, 0, -10], foreL: [-75, 0, 5], armR: [-10 - 45 * l + 15 * r, 0, 10], foreR: [-75, 0, -5],
  }; } },
  // Kicks: a toe flicked out in front, left then right, weight on the other foot.
  kick: { beats: 4, pose: (b) => { const l = half(b, 4), r = half(b - 2, 4), d = dip(b); return {
    ...crouch(0.35 + 0.25 * d), x: 0.07 * (l - r),
    hips: [0, -8 * (l - r), -5 * (l - r)], spine: [4, 8 * (l - r), 5 * (l - r)], neck: [4 * d, 0, 0],
    ankleL: ankle(-1, 0.02 * l, 0.09 * l, 0.3 * l), ankleR: ankle(1, 0.02 * r, 0.09 * r, 0.3 * r),
    armL: [-20 - 30 * S(b, 4), 0, -15], foreL: [-65, 0, 10], armR: [-20 + 30 * S(b, 4), 0, 15], foreR: [-65, 0, -10],
  }; } },
  // Pointing up at the booth, one arm then the other, bouncing on the beat.
  point: { beats: 4, pose: (b) => { const pr = (1 + C(b, 4)) / 2, pl = 1 - pr, d = dip(b); return {
    ...crouch(0.45 + 0.4 * d), x: 0.03 * (pr - pl),
    hips: [0, 8 * (pr - pl), 0], spine: [-4, -8 * (pr - pl), 4 * (pr - pl)], neck: [-12 + 5 * d, 10 * (pr - pl), 0],
    armL: [-30 - 130 * pl, 0, -15 - 10 * pl], foreL: [-30 * pr - 8, 0, 0], armR: [-30 - 130 * pr, 0, 15 + 10 * pr], foreR: [-30 * pl - 8, 0, 0],
  }; } },
  // Hands up, swaying side to side overhead.
  wave: { beats: 4, pose: (b) => { const sw = S(b, 4), d = dip(b); return {
    ...crouch(0.4 + 0.2 * d), x: 0.05 * sw,
    hips: [0, 0, -4 * sw], spine: [-6, 0, 7 * sw], neck: [-12, 0, -4 * sw],
    armL: [-150, 0, -22 + 20 * sw], foreL: [-15, 0, 6 * sw], armR: [-150, 0, 22 + 20 * sw], foreR: [-15, 0, 6 * sw],
  }; } },
  // Disco: the point, up to one corner and down to the other, hip out.
  disco: { beats: 2, pose: (b) => { const ph = C(b, 2), up = (1 + ph) / 2, d = dip(b); return {
    ...crouch(0.5 + 0.2 * d), x: -0.06 * ph,
    hips: [0, -15 * ph, 4 * ph], spine: [4, 10 * ph, -9 * ph], neck: [-6 * up, 22 * ph, 0],
    armL: [0, 0, -25], foreL: [-40, 0, 70], armR: [-40 + 10 * up, 0, -25 + 165 * up], foreR: [-8, 0, 0],
  }; } },
  // The robot: stiff, snapping from pose to pose on each beat.
  robot: { beats: 4, pose: (b) => {
    const i = Math.floor(b) % 4, k = ease(Math.min(1, (b % 1) / 0.25)), from = ROBOT[(i + 3) % 4], to = ROBOT[i];
    const out = { ...crouch(0.5), hips: [0, 0, 0] };
    for (const j of ['armL', 'foreL', 'armR', 'foreR', 'neck', 'spine']) out[j] = lerpA(from[j], to[j], k);
    return out;
  } },

  // ---- reactions: cheering, clapping, a jump (plays once), and sulking
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
  // Thumbs down and a head shake.
  boo: { beats: 4, pose: (b) => ({
    ...crouch(0.2), x: 0.04,
    hips: [-4, 0, 3], spine: [-8, 0, -2], neck: [6, 18 * S(b), 0],
    armL: [-60, 0, 20], foreL: [-120, 0, 55], armR: [-60, 0, -20], foreR: [-120, 0, -55],
  }) },
  // Arms folded, hip out, shaking the head slowly.
  crossed: { beats: 4, pose: (b) => ({
    ...crouch(0.15), x: 0.05,
    hips: [0, 0, 6], spine: [-5, 0, -4], neck: [4, 14 * S(b, 2), 0],
    armL: [-40, 0, 15], foreL: [-100, 0, 60], armR: [-40, 0, -15], foreR: [-100, 0, -60],
  }) },
  // Slumped: head down, shoulders forward, arms hanging.
  slump: { beats: 8, pose: (b) => ({
    ...crouch(0.3 + 0.03 * C(b, 4)), x: 0.02 * S(b, 8),
    hips: [0, 0, 0], spine: [15, 0, 2 * S(b, 8)], neck: [22, 6 * S(b, 8), 0],
    armL: [-8, 0, -6], foreL: [-8, 0, 0], armR: [-8, 0, 6], foreR: [-8, 0, 0],
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

// ------------------------------------------------------------ scene
let renderer, scene, camera;
const clips = {}, beatsOf = {}, onceOf = new Set();
const dancers = []; // [0] is you, the rest are the crowd
let me = null, crowd = [];
let song = null;     // { key, beatMs, beat0 }
let shares = { dance: 0.25, sulk: 0 }; // how much of the crowd is dancing or sulking
let lastT = 0;
let visible = true;

// A figure on the floor with its own mixer, moves and timing.
function makeDancer(idx, x, z, rand) {
  const mat = new THREE.MeshStandardMaterial({ ...(idx ? { color: TINTS[idx % TINTS.length] } : ME_TINT), roughness: 0.8, metalness: 0.1 });
  const root = buildSilhouette(mat);
  root.position.set(x, 0, z);
  root.rotation.y = idx ? THREE.MathUtils.degToRad(rand() * 30 - 15) : 0;
  root.scale.setScalar(idx ? 0.88 + rand() * 0.14 : 1);
  scene.add(root);
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const [name, clip] of Object.entries(clips)) {
    const a = mixer.clipAction(clip);
    if (onceOf.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    actions[name] = a;
  }
  // The crowd lags the beat by a few ms each, so they move together, not in lockstep.
  return { idx, root, mixer, actions, mode: 'chill', current: null, reaction: null, lag: idx ? 20 + rand() * 140 : 0 };
}

function init() {
  const canvas = document.getElementById('floor-canvas');
  if (!canvas) return;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 1.7, 5.4);
  camera.lookAt(0, 0.8, -1);

  // Stage lighting: a warm spot from the front, neon rims from behind so the
  // silhouettes have an edge, and a dim fill so nothing goes fully black.
  scene.add(new THREE.HemisphereLight(0x8a7bb8, 0x120e1d, 0.5));
  const spot = new THREE.SpotLight(0xffd9a0, 40, 16, 0.75, 0.7, 1.4);
  spot.position.set(0.6, 5, 3.2);
  spot.target.position.set(0, 0.9, -1);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0004;
  scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight(0x5de0ff, 3);
  rim.position.set(-2, 2.5, -3);
  const rim2 = new THREE.DirectionalLight(0xff5fb8, 2);
  rim2.position.set(2.5, 2, -2.5);
  scene.add(rim, rim2);
  // The floor only catches the shadows: the page shows through everywhere else.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(7, 48), new THREE.ShadowMaterial({ opacity: 0.45 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  for (const [name, def] of Object.entries(POSES)) {
    clips[name] = bakeClip(name, def);
    beatsOf[name] = def.beats;
    if (def.once) onceOf.add(name);
  }
  const rand = seedRand('crowd');
  dancers.push(makeDancer(0, 0, 0, rand));
  for (const row of ROWS) for (const x of row.xs) {
    dancers.push(makeDancer(dancers.length, x + (rand() - 0.5) * 0.2, row.z + (rand() - 0.5) * 0.25, rand));
  }
  me = dancers[0];
  crowd = dancers.slice(1);

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
  const clipBeat = clips[name].duration / beatsOf[name];
  return song ? (clipBeat * 1000) / song.beatMs : clipBeat / REF_BEAT;
}

// ---- the song, your mood and the room's (set by app.js)
function setSong(s) {
  if (!s) { song = null; moodCrowd(); return; }
  // One move loop is one bar of 4 beats, halved or doubled so a bar always
  // lasts 1.2-2.7 s (the same rule as the sprite dancers and the emote timing).
  let bar = s.bpm > 0 ? (4 * 60000) / s.bpm : 2000;
  while (bar < 1200) bar *= 2;
  while (bar > 2700) bar /= 2;
  song = { key: s.key, beatMs: bar / 4, beat0: s.anchor + (s.offset || 0) };
  for (const d of dancers) if (d.current) d.current.action.timeScale = speedOf(d.current.name);
  moodCrowd();
}
function setMode(m) { if (me) me.mode = MOVES[m] ? m : 'chill'; }
// How the room is voting: the more Awesomes, the more of the crowd dances;
// Lames put some of them in a sulk.
function setRoom({ people = 0, awesome = 0, lame = 0 } = {}) {
  const n = Math.max(1, people);
  shares = { dance: 0.25 + 0.75 * (awesome / n), sulk: 0.75 * (lame / n) };
  moodCrowd();
}
// Each crowd member's keenness is rolled fresh for every song.
function moodCrowd() {
  for (const d of crowd) {
    if (!song) { d.mode = 'chill'; continue; }
    const keen = seedRand(d.idx + '|' + song.key)();
    d.mode = keen < shares.dance ? 'dance' : keen > 1 - shares.sulk ? 'sulk' : 'groove';
  }
}
// A one-off reaction (cheer, jump, clap, boo...) for ms, then back to dancing.
// who: 'me' (yours), 'crowd' (someone else's: some of the crowd join in,
// staggered) or 'all'.
function react(clip, ms, delay = 0, who = 'me') {
  if (!clips[clip]) return;
  if (who !== 'crowd' && me) schedule(me, clip, ms, delay);
  if (who !== 'me') for (const d of crowd) if (Math.random() < 0.4) schedule(d, clip, ms, delay + Math.random() * 500);
}
function schedule(d, name, ms, delay) {
  if (delay > 0) { setTimeout(() => schedule(d, name, ms, 0), delay); return; }
  const length = onceOf.has(name) ? (clips[name].duration / speedOf(name)) * 1000 : ms;
  d.reaction = { name, until: now() + length };
}

// Preview one move on loop (Dancer.show('twist') in the console; add true for
// the whole floor); show() to stop.
function show(clip, everyone = false) {
  for (const d of everyone ? dancers : [me]) d.reaction = clips[clip] ? { name: clip, until: Infinity } : null;
}
// Advance by s seconds and draw, for checking poses from the console.
Dancer.step = (s) => { update(now(), s); renderer.render(scene, camera); };
Dancer.state = () => ({
  song, me: me.mode, crowd: crowd.map((d) => `${d.mode}:${d.current ? d.current.name : '-'}`).join(' '),
  actions: Object.entries(me.actions).filter(([, a]) => a.isRunning() && a.getEffectiveWeight() > 0)
    .map(([n, a]) => `${n} w=${a.getEffectiveWeight().toFixed(2)} t=${a.time.toFixed(2)} x${a.timeScale.toFixed(2)}`),
});
Dancer.moves = () => Object.keys(clips);
Dancer.debug = () => ({ camera, dancers }); // for poking at the scene from the console

// ---- choreography: a seeded plan per figure, song and mood, so every client agrees
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
function planFor(idx, key, m) {
  const id = idx + '|' + key + '|' + m;
  if (plans.has(id)) return plans.get(id);
  const rand = seedRand(id);
  const pool = MOVES[m];
  const segs = [];
  let start = 0, last = null;
  while (start < 4000) { // over 30 minutes of beats; the plan wraps after that
    let move;
    do move = pool[Math.floor(rand() * pool.length)]; while (move === last);
    const beats = SEG[m] * (rand() < 0.5 ? 1 : 2);
    segs.push({ move, start, beats });
    start += beats;
    last = move;
  }
  const plan = { segs, total: start };
  plans.set(id, plan);
  return plan;
}
function wanted(d, t) {
  if (d.reaction && t < d.reaction.until) return d.reaction.name;
  d.reaction = null;
  const { segs, total } = planFor(d.idx, song ? song.key : 'none', song ? d.mode : 'chill');
  const beat = mod(beatAt(t), total);
  let seg = segs[0];
  for (const s of segs) { if (s.start > beat) break; seg = s; }
  return seg.move;
}

// Start a move now, blended from whatever is playing, in step with the song.
function play(d, name, t) {
  const next = d.actions[name];
  next.reset();
  next.timeScale = speedOf(name);
  if (!onceOf.has(name)) next.time = mod(beatAt(t), beatsOf[name]) * (clips[name].duration / beatsOf[name]);
  next.play();
  if (d.current && d.current.action !== next) d.current.action.crossFadeTo(next, FADE, false);
  d.current = { name, action: next };
}

function update(t, dt) {
  for (const d of dancers) {
    const td = t - d.lag;
    const name = wanted(d, td);
    if (!d.current || d.current.name !== name) play(d, name, td);
    d.mixer.update(dt);
  }
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
  update(t, dt);
  renderer.render(scene, camera);
}

init();
