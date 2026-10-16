/* God's Noisey BoyZ: the dance floor.

   A crowd of figures in front of the booth, drawn with three.js. The one at
   the front is you; the rest are the crowd. Every move is an AnimationClip
   baked from a pose function on a named joint hierarchy, and each figure has
   its own mixer cross-fading between moves, so any move can flow into any
   other at any moment. Everything runs on the song clock (app.js sets
   Dancer.now) and every clip is retimed so its beats land on the song's
   beats, phase-aligned, so the whole floor stays in step with what everyone
   hears. Each figure picks its own moves (seeded, so the same song gets the
   same choreography on every screen), and each has its own timing (a little
   ahead or behind, some on the off-beat), its own energy (how big it moves)
   and its own handedness (half the crowd dances every move mirrored), so the
   crowd moves together without moving in lockstep.

   The legs are never posed by hand: a pose says where the hips and the feet
   are, and the knees are solved to connect them, so the feet stay planted.
   Drawing is instanced: each body part is one draw call for the whole crowd,
   so the floor costs about the same with sixty figures as with one. */
import * as THREE from 'three';

const REF_BEAT = 0.5; // clips are authored at 120 BPM: one beat is 0.5 s
// Seconds to blend from one move into the next: half a beat, within reason.
// A planned move starts blending in that long before its downbeat, so it has
// arrived by the time the bar turns over, the way a dancer anticipates.
const fadeFor = () => THREE.MathUtils.clamp((song ? song.beatMs : REF_BEAT * 1000) / 2000, 0.2, 0.45);
const CROWD = 64;     // how many figures stand around you
// The camera sits just over the crowd's heads; you're in focus, and the rows
// in front of and behind you soften with distance.
const DOF = { focus: 5.6, aperture: 0.012, maxblur: 0.02, on: true };
// Figures right under the camera: out of frame until they raise their hands.
const FORE = [[-0.95, 4.2], [-0.3, 4.45], [0.4, 4.3], [1.0, 4.5]];
// Rows between you and the camera, leaving a lane so you stay in view.
const FRONT = [[-0.9, 1], [0.9, 1], [-1.8, 1], [1.8, 1], [-2.7, 1], [2.7, 1], [-1.15, 2], [1.15, 2], [-2.1, 2], [2.1, 2], [-1.5, 3], [1.5, 3]];
// Which moves each mood draws from. A move repeated in a list is just more likely.
const MOVES = {
  dance: ['bounce', 'roof', 'twist', 'step', 'pump', 'shuffle', 'kick', 'point', 'wave', 'sway', 'rock', 'disco', 'robot', 'turn', 'spin', 'turn'],
  groove: ['groove', 'sway', 'bob', 'step', 'rock', 'bob', 'groove', 'swing'],
  chill: ['idle', 'look', 'phone', 'tap', 'stretch', 'idle'],
  sulk: ['boo', 'crossed', 'slump'],
};
const SEG = { dance: 8, groove: 16, chill: 16, sulk: 16 }; // beats a figure keeps a move for (or twice that)
const TINTS = [0x1b1430, 0x161a33, 0x241530, 0x121d2c, 0x201a2e]; // shades the crowd comes in
const ME_TINT = 0x5a40b0; // you stand out from the crowd
// Where the other people in the room stand: around you, between the crowd's
// rows, in the order they arrive. More people than spots and the crowd stands
// in for the rest.
const USER_SPOTS = [[-1, 0.15], [1, 0.15], [-2, 0.1], [2, 0.1], [-0.55, -0.6], [0.55, -0.6], [-1.5, -0.55], [1.5, -0.55], [-2.5, -0.5], [2.5, -0.5], [-3, 0.2], [3, 0.2]];

const Dancer = Object.assign(window.Dancer || {}, { setSong, setMode, setRoom, setUsers, react, show, ready: false });
window.Dancer = Dancer;

// ------------------------------------------------------------ the silhouette
// A figure of capsules hung on named joints. Limbs hang along their joint's
// -Y axis in the rest pose (arms by the sides, legs straight), so a joint's
// rotation about X swings the limb forward (negative) and back, and about Z
// swings it out to the side (negative for the left side). Each figure has its
// own skeleton of plain Object3Ds; the parts themselves are drawn once for
// the whole crowd (see PARTS).
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
function buildSkeleton() {
  const root = new THREE.Group();
  const hips = joint('hips', root, 0, HIP_Y, 0);
  const spine = joint('spine', hips, 0, 0.04, 0);
  joint('neck', spine, 0, 0.5, 0);
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const arm = joint('arm' + side, spine, s * 0.2, 0.45, 0);
    joint('fore' + side, arm, 0, -0.3, 0);
    const leg = joint('leg' + side, hips, s * SOCKET.x, SOCKET.y, 0);
    const shin = joint('shin' + side, leg, 0, -THIGH, 0);
    joint('foot' + side, shin, 0, -SHIN, 0); // the ankle
  }
  return root;
}
// The body parts: a geometry, the joint it hangs on, and where it sits on it.
const cap = (r, len) => new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 12);
const PARTS = [
  { joint: 'hips', geo: cap(0.13, 0.3), at: [0, 0.01, 0], roll: 90 }, // the pelvis, lying across the hips
  { joint: 'spine', geo: cap(0.135, 0.52), at: [0, 0.26, 0] },
  { joint: 'neck', geo: new THREE.SphereGeometry(0.115, 20, 14), at: [0, 0.17, 0] },
];
for (const side of ['L', 'R']) {
  PARTS.push(
    { joint: 'arm' + side, geo: cap(0.05, 0.3), at: [0, -0.15, 0] },
    { joint: 'fore' + side, geo: cap(0.046, 0.32), at: [0, -0.16, 0] }, // forearm and hand
    { joint: 'leg' + side, geo: cap(0.07, THIGH), at: [0, -THIGH / 2, 0] },
    { joint: 'shin' + side, geo: cap(0.055, SHIN), at: [0, -SHIN / 2, 0] },
    { joint: 'foot' + side, geo: new THREE.BoxGeometry(0.1, 0.06, 0.24), at: [0, 0, 0.06] },
  );
}
for (const p of PARTS) {
  p.local = new THREE.Matrix4().compose(new THREE.Vector3(...p.at), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(p.roll || 0))), new THREE.Vector3(1, 1, 1));
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
// given where the hips are: the knee bends forward (the way the body faces,
// facing) and a little out, and the foot sits flat, turned by yaw degrees.
// Writes leg, shin and foot into out.
function solveLeg(side, hipPos, hipQ, target, yaw, facing, out) {
  const s = side === 'L' ? -1 : 1;
  const socket = new THREE.Vector3(s * SOCKET.x, SOCKET.y, 0).applyQuaternion(hipQ).add(hipPos);
  const d = new THREE.Vector3().subVectors(target, socket);
  const reach = THREE.MathUtils.clamp(d.length(), 0.1, THIGH + SHIN - 0.003); // out of reach: the foot comes up a touch
  d.normalize();
  const pole = new THREE.Vector3(s * 0.3, 0, 1).normalize().applyQuaternion(facing); // which way the knee points
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
// ankleR, points on the floor in a natural stance by default), how far the
// toes turn (toesL, toesR) and which way the whole figure faces (turn, in
// degrees; everything else in the pose is then relative to that facing).
// They're periodic in the clip's length, so every loop is seamless. All of
// them stay on the spot, so they work in a crowd.
const S = (b, per = 1, ph = 0) => Math.sin(2 * Math.PI * (b / per + ph));
const C = (b, per = 1, ph = 0) => Math.cos(2 * Math.PI * (b / per + ph));
const dip = (b) => (1 + C(b)) / 2;        // 1 on every beat, 0 between
const half = (b, per) => Math.max(0, S(b, per)); // the first half of a cycle, as a hump
const lerp = (a, b, k) => a + (b - a) * k;
const lerpA = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
const ease = (k) => 1 - (1 - k) * (1 - k);
const smooth = (k) => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k));
const mod = (a, b) => ((a % b) + b) % b;
const rad = THREE.MathUtils.degToRad;
// Hips lowered to bend the knees by k: 0 straight, 1 an easy bend, 2 a crouch.
const crouch = (k) => ({ y: -0.075 * k });
// An ankle for side s: out from its stance, up off the floor, forward.
const ankle = (s, out = 0, up = 0, fwd = 0) => [s * (STANCE + out), ANKLE_Y + up, fwd];
// Arms hanging loose at the sides, swinging forward by sw degrees (left one first).
const loose = (sw = 0, bend = 15) => ({ armL: [sw, 0, -8], foreL: [-bend, 0, 0], armR: [-sw, 0, 8], foreR: [-bend, 0, 0] });
// A yaw curve over one loop of `beats`, carried on round `turns` full turns
// per loop so it can be read a little before or after the loop.
const yawLoop = (fn, beats, turns = 0) => (b) => fn(mod(b, beats)) + 360 * turns * Math.floor(b / beats);
// A foot that only moves while it's in the air. It lifts for half a beat at
// each beat in `lifts`, landing turned to where the body's yaw has got to,
// and stays put in the room until its next lift. Returns the ankle and toes
// relative to the body, which is facing yaw(b).
function footAt(s, b, yaw, lifts, beats) {
  let prev = -Infinity;
  for (const l of lifts) if (l <= b && l > prev) prev = l;
  if (prev === -Infinity) prev = Math.max(...lifts) - beats; // still planted from the previous loop
  const k = Math.min(1, (b - prev) / 0.5);
  const planted = lerp(yaw(prev), yaw(prev + 0.5), ease(k)); // where the foot points, in the room
  const up = k < 1 ? 0.07 * Math.sin(Math.PI * k) : 0;
  const rel = rad(planted - yaw(b));
  return { ankle: [s * STANCE * Math.cos(rel), ANKLE_Y + up, -s * STANCE * Math.sin(rel)], toes: s * 6 + planted - yaw(b) };
}
// A point in the room, as the body sees it when facing yaw degrees.
const inBody = (x, z, yaw) => { const r = rad(yaw); return [x * Math.cos(r) - z * Math.sin(r), x * Math.sin(r) + z * Math.cos(r)]; };

// The robot's key poses: it snaps from one to the next on each beat, facing
// one way for four beats then the other, bending oddly at the waist.
const ROBOT = [
  { armL: [-90, 0, 0], foreL: [0, 0, -90], armR: [-90, 0, 0], foreR: [-90, 0, 0], neck: [0, 25, 0], spine: [10, 0, -20] },
  { armL: [-90, 0, 0], foreL: [-90, 0, 0], armR: [-90, 0, 0], foreR: [0, 0, 90], neck: [0, -25, 0], spine: [-5, 0, 20] },
  { armL: [0, 0, -90], foreL: [-90, 0, 0], armR: [-90, 0, 0], foreR: [-90, 0, 0], neck: [15, 0, 0], spine: [25, 15, 0] },
  { armL: [-90, 0, 0], foreL: [-90, 0, 0], armR: [0, 0, 90], foreR: [-90, 0, 0], neck: [-10, 0, 0], spine: [0, -15, 25] },
  { armL: [-90, 0, 0], foreL: [-90, 0, 0], armR: [-90, 0, 0], foreR: [-90, 0, 0], neck: [0, 0, 20], spine: [32, 0, 0] },
  { armL: [-90, 0, 0], foreL: [0, 0, -90], armR: [0, 0, 90], foreR: [-90, 0, 0], neck: [0, 0, -20], spine: [-10, 20, -22] },
  { armL: [-45, 0, -60], foreL: [-120, 0, 0], armR: [-45, 0, 60], foreR: [-120, 0, 0], neck: [20, 0, 0], spine: [20, 0, 15] },
  { armL: [-90, 0, 0], foreL: [-90, 0, 0], armR: [-90, 0, 0], foreR: [0, 0, 90], neck: [-15, 0, 0], spine: [-5, -20, -25] },
];
const ROBOT_FACE = (i) => (mod(i, 8) < 3 ? 70 : mod(i, 8) < 6 ? -70 : 0); // one side, the other, then front so the loop and the next move start square
// The turn: a half turn in four stepping beats, four beats grooving with your
// back to the booth, a half turn on round, four beats facing front again.
const TURN_YAW = yawLoop((b) => (b < 4 ? 45 * b : b < 8 ? 180 : b < 12 ? 180 + 45 * (b - 8) : 360), 16, 1);
const SWING_YAW = yawLoop((b) => 35 * S(b, 8), 8);

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
  // Swinging round to face one side then the other, feet shuffling after.
  swing: { beats: 8, pose: (b) => {
    const d = dip(b), sw = S(b, 2), yaw = SWING_YAW(b);
    const L = footAt(-1, b, SWING_YAW, [0, 2, 4, 6], 8), R = footAt(1, b, SWING_YAW, [1, 3, 5, 7], 8);
    return {
      ...crouch(0.4 + 0.35 * d), turn: yaw,
      hips: [0, 5 * sw, 0], spine: [4 + 2 * d, 8 * S(b, 8), 3 * sw], neck: [8 * d - 3, -10 * S(b, 8), 0],
      ankleL: L.ankle, ankleR: R.ankle, toesL: L.toes, toesR: R.toes,
      armL: [8 * sw, 0, -12], foreL: [-35 - 10 * d, 0, 0], armR: [-8 * sw, 0, 12], foreR: [-35 - 10 * d, 0, 0],
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
  // The robot: stiff, snapping from pose to pose on each beat, turned side-on
  // and bending oddly at the waist; it hops round to face the other side
  // halfway through.
  robot: { beats: 8, pose: (b) => {
    const i = Math.floor(b) % 8, k = ease(Math.min(1, (b % 1) / 0.25)), from = ROBOT[(i + 7) % 8], to = ROBOT[i];
    const out = { ...crouch(0.5), hips: [0, 0, 0], turn: lerp(ROBOT_FACE(i - 1), ROBOT_FACE(i), k) };
    for (const j of ['armL', 'foreL', 'armR', 'foreR', 'neck', 'spine']) out[j] = lerpA(from[j], to[j], k);
    if (ROBOT_FACE(i) !== ROBOT_FACE(i - 1) && k < 1) { // the hop round
      const hop = 0.05 * Math.sin(Math.PI * k);
      out.ankleL = ankle(-1, 0, hop); out.ankleR = ankle(1, 0, hop); out.y -= 0.02 * Math.sin(Math.PI * k);
    }
    return out;
  } },
  // Turning round: half a turn in four stepping beats, four beats grooving with
  // your back to the booth, then on round to the front and four beats there.
  turn: { beats: 16, pose: (b) => {
    const d = dip(b), sw = S(b, 2);
    const L = footAt(-1, b, TURN_YAW, [1, 3, 5, 9, 11, 13], 16), R = footAt(1, b, TURN_YAW, [0, 2, 4, 8, 10, 12], 16);
    return {
      ...crouch(0.4 + 0.4 * d), turn: TURN_YAW(b),
      hips: [0, 6 * sw, 0], spine: [4 + 3 * d, -6 * sw, 4 * sw], neck: [8 * d - 3, 4 * sw, 0],
      ankleL: L.ankle, ankleR: R.ankle, toesL: L.toes, toesR: R.toes,
      armL: [-20 - 25 * sw, 0, -14], foreL: [-70, 0, 8], armR: [-20 + 25 * sw, 0, 14], foreR: [-70, 0, -8],
    };
  } },
  // A spin: wind up with the arms out, whip round once on the left foot with
  // the right tucked up, land and settle.
  spin: { beats: 4, pose: (b) => {
    let yaw, arms, air = 0;
    if (b < 1) { yaw = -25 * ease(b); arms = ease(b); }
    else if (b < 2.5) { const k = (b - 1) / 1.5; yaw = -25 + 385 * smooth(k); arms = 1; air = Math.sin(Math.PI * k); }
    else { yaw = 360; arms = 1 - ease((b - 2.5) / 1.5); }
    const [hx, hz] = inBody(-0.08 * air, 0, yaw);          // the hips move over the left foot
    const [fx, fz] = inBody(-STANCE, 0, yaw);              // which stays put in the room
    return {
      ...crouch(0.35 + 0.3 * air), x: hx, z: hz, turn: yaw,
      hips: [0, 0, 0], spine: [2, 0, -3 * air], neck: [-4, 0, 0],
      ankleL: [fx, ANKLE_Y, fz], ankleR: ankle(1, -0.02 * air, 0.2 * air, -0.06 * air), toesR: 6 - 10 * air,
      armL: [0, 0, -10 - 75 * arms], foreL: [-15, 0, 0], armR: [0, 0, 10 + 75 * arms], foreR: [-15, 0, 0],
    };
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
  // Standing easy. Not a move: the crowd's lower-energy figures blend toward
  // it a little, which makes everything they do smaller.
  rest: { beats: 1, still: true, pose: () => ({ ...crouch(0.3), hips: [0, 0, 0], spine: [3, 0, 0], neck: [2, 0, 0], ...loose(0, 15) }) },
};
// The same pose for the other hand: left and right swap, and everything that
// turns about the vertical or the front-to-back axis turns the other way.
function mirrored(p) {
  const flip = (r) => r && [r[0], -r[1], -r[2]];
  const m = { ...p, x: -(p.x || 0), turn: -(p.turn || 0) };
  for (const j of ['hips', 'spine', 'neck']) if (p[j]) m[j] = flip(p[j]);
  for (const j of ['arm', 'fore']) { m[j + 'L'] = flip(p[j + 'R']); m[j + 'R'] = flip(p[j + 'L']); }
  m.ankleL = p.ankleR && [-p.ankleR[0], p.ankleR[1], p.ankleR[2]];
  m.ankleR = p.ankleL && [-p.ankleL[0], p.ankleL[1], p.ankleL[2]];
  m.toesL = p.toesR == null ? undefined : -p.toesR;
  m.toesR = p.toesL == null ? undefined : -p.toesL;
  return m;
}

// Bake a pose function into a clip: 30 samples a second at the reference tempo.
function bakeClip(name, { beats, pose }, mirror = false, fps = 30) {
  const n = Math.round(beats * REF_BEAT * fps);
  const times = [], pos = [], rot = {};
  for (const j of JOINTS) rot[j] = [];
  const e = new THREE.Euler();
  const hipPos = new THREE.Vector3(), target = new THREE.Vector3(), facing = new THREE.Quaternion();
  for (let i = 0; i <= n; i++) { // the last sample repeats the first so loops are seamless
    let p = pose(((i % n) / n) * beats);
    if (mirror) p = mirrored(p);
    times.push(i / fps);
    facing.setFromAxisAngle(Y_UP, rad(p.turn || 0));
    hipPos.set(p.x || 0, HIP_Y + (p.y || 0), p.z || 0).applyQuaternion(facing);
    pos.push(hipPos.x, hipPos.y, hipPos.z);
    const q = {};
    for (const j of JOINTS) {
      const r = p[j] || [0, 0, 0];
      e.set(rad(r[0]), rad(r[1]), rad(r[2]));
      q[j] = new THREE.Quaternion().setFromEuler(e);
    }
    q.hips.premultiply(facing);
    for (const side of ['L', 'R']) {
      const s = side === 'L' ? -1 : 1;
      target.fromArray(p['ankle' + side] || ankle(s)).applyQuaternion(facing);
      solveLeg(side, hipPos, q.hips, target, (p['toes' + side] ?? s * 6) + (p.turn || 0), facing, q);
    }
    for (const j of JOINTS) rot[j].push(q[j].x, q[j].y, q[j].z, q[j].w);
  }
  const tracks = [new THREE.VectorKeyframeTrack('hips.position', times, pos)];
  for (const j of JOINTS) tracks.push(new THREE.QuaternionKeyframeTrack(j + '.quaternion', times, rot[j]));
  return new THREE.AnimationClip(name, -1, tracks);
}

// ------------------------------------------------------------ scene
let renderer, scene, camera;
const clips = {}, clipsM = {}, beatsOf = {}, onceOf = new Set(); // clipsM: the same moves, mirrored
const dancers = []; // [0] is you, then figures for the other people in the room, then the crowd
let me = null, pool = [], crowd = [];
let song = null;     // { key, beatMs, beat0 }
let shares = { dance: 0.25, sulk: 0 }; // how much of the crowd is dancing or sulking
let lastT = 0;
let visible = true;

// A figure on the floor with its own skeleton, mixer, moves and timing.
// kind: 'me', 'user' (one of the people in the room; sits idle and unseen
// until someone arrives to fill it) or 'crowd'.
function makeDancer(idx, x, z, rand, kind) {
  const root = buildSkeleton();
  root.position.set(x, 0, z);
  const isCrowd = kind === 'crowd';
  root.rotation.y = isCrowd ? rad(rand() * 30 - 15) : 0;
  root.scale.setScalar(isCrowd ? 0.88 + rand() * 0.14 : 1);
  const joints = {};
  for (const j of JOINTS) joints[j] = root.getObjectByName(j);
  const mixer = new THREE.AnimationMixer(root);
  // What makes one crowd figure move differently from the next: the crowd is
  // split between the two hands, each figure is a little early or late (a few
  // on the off-beat or a whole beat out), and some move smaller than others.
  // People's own figures dance full size, square on the beat.
  const mirror = isCrowd ? rand() < 0.5 : false;
  const roll = isCrowd ? rand() : 0;
  const shift = !isCrowd ? 0 : roll < 0.6 ? (rand() - 0.5) * 0.25 : roll < 0.85 ? 0.5 + (rand() - 0.5) * 0.2 : 1 + (rand() - 0.5) * 0.2;
  const energy = isCrowd ? 0.6 + rand() * 0.4 : 1;
  const actions = {};
  for (const [name, clip] of Object.entries(mirror ? clipsM : clips)) {
    const a = mixer.clipAction(clip);
    if (onceOf.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    actions[name] = a;
  }
  // The mixer averages running actions by weight, so a standing-easy action
  // left running at a fixed weight scales every move toward it.
  if (energy < 1) { actions.rest.setEffectiveWeight(1 / energy - 1); actions.rest.play(); }
  return { idx, kind, root, joints, mixer, actions, mode: 'chill', current: null, reaction: null, shift, energy, mirror, active: kind !== 'user' };
}
// Where the crowd stands: the few under the camera, the rows in front of
// you, then rows behind you, each as wide as the floor is in view at that
// depth, filled from the middle out.
function crowdSpots(count) {
  const spots = [...FORE, ...FRONT].map(([x, z]) => ({ x, z }));
  for (let r = 0; spots.length < count && r < 12; r++) {
    const z = -1.1 - 0.85 * r, w = 0.72 * (5.4 - z); // half the width in view at that depth
    const n = Math.floor((2 * w) / 0.9) + 1, x0 = -((n - 1) * 0.9) / 2 + (r % 2 ? 0.45 : 0);
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(x0 + i * 0.9);
    xs.sort((a, b) => Math.abs(a) - Math.abs(b));
    for (const x of xs) {
      if (spots.length >= count) break;
      if (r === 0 && Math.abs(x) < 0.7) continue; // leave you room at the front
      spots.push({ x, z });
    }
  }
  return spots;
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
  camera.position.set(0, 2.4, 5.4);
  camera.lookAt(0, 0.9, -1.5);

  // Stage lighting: a warm spot from the front, neon rims from behind so the
  // silhouettes have an edge, and a dim fill so nothing goes fully black.
  scene.add(new THREE.HemisphereLight(0x8a7bb8, 0x120e1d, 0.5));
  const spot = new THREE.SpotLight(0xffd9a0, 40, 18, 0.8, 0.7, 1.4);
  spot.position.set(0.6, 5, 3.2);
  spot.target.position.set(0, 0.9, -1.5);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0004;
  scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight(0x5de0ff, 3);
  rim.position.set(-2, 2.5, -3);
  const rim2 = new THREE.DirectionalLight(0xff5fb8, 2);
  rim2.position.set(2.5, 2, -2.5);
  const fill = new THREE.DirectionalLight(0x7a6ab8, 0.7); // from the camera, so the near figures aren't pure black
  fill.position.set(0, 3, 6);
  scene.add(rim, rim2, fill);
  // The floor only catches the shadows: the page shows through everywhere else.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.ShadowMaterial({ opacity: 0.45 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  for (const [name, def] of Object.entries(POSES)) {
    clips[name] = bakeClip(name, def);
    clipsM[name] = bakeClip(name, def, true);
    beatsOf[name] = def.beats;
    if (def.once) onceOf.add(name);
  }
  const rand = seedRand('crowd');
  dancers.push(makeDancer(0, 0, 0, rand, 'me'));
  for (const [x, z] of USER_SPOTS) dancers.push(makeDancer(dancers.length, x, z, rand, 'user'));
  for (const { x, z } of crowdSpots(CROWD)) dancers.push(makeDancer(dancers.length, x + (rand() - 0.5) * 0.2, z + (rand() - 0.5) * 0.25, rand, 'crowd'));
  me = dancers[0];
  pool = dancers.filter((d) => d.kind === 'user');
  crowd = dancers.filter((d) => d.kind === 'crowd');
  // One instanced mesh per body part draws that part for every figure.
  const skin = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.1 });
  const tint = new THREE.Color();
  for (const p of PARTS) {
    p.mesh = new THREE.InstancedMesh(p.geo, skin, dancers.length);
    p.mesh.castShadow = true;
    p.mesh.frustumCulled = false; // instances are spread over the floor; the geometry's own bounds mean nothing
    for (const d of dancers) p.mesh.setColorAt(d.idx, tint.setHex(d.kind === 'me' ? ME_TINT : TINTS[d.idx % TINTS.length]));
    scene.add(p.mesh);
  }

  setupDof();
  const fit = () => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const px = renderer.getDrawingBufferSize(new THREE.Vector2());
    dof.color.setSize(px.x, px.y);
    dof.depth.setSize(px.x, px.y);
    dof.mat.uniforms.aspect.value = w / h;
  };
  new ResizeObserver(fit).observe(canvas);
  fit();
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);

  Dancer.ready = true;
  lastT = now();
  requestAnimationFrame(tick);
}

const now = () => (Dancer.now ? Dancer.now() : Date.now());
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
// who: a user id (their figure does it, and some of the crowd join in,
// staggered), 'me' (yours alone), 'crowd' (just the crowd) or 'all'.
function react(clip, ms, delay = 0, who = 'me') {
  if (!clips[clip]) return;
  const fig = who === 'me' || who === 'all' ? me : who === 'crowd' ? null : users.get(who);
  if (fig) schedule(fig, clip, ms, delay);
  if (who === 'all' || (who !== 'me' && fig !== me)) for (const d of crowd) if (Math.random() < 0.4) schedule(d, clip, ms, delay + Math.random() * 500);
}
function schedule(d, name, ms, delay) {
  if (delay > 0) { setTimeout(() => schedule(d, name, ms, 0), delay); return; }
  const length = onceOf.has(name) ? (clips[name].duration / speedOf(name)) * 1000 : ms;
  d.reaction = { name, until: now() + length };
}

// Preview one move on loop (Dancer.show('twist') in the console; add true for
// the whole floor); show() to stop.
function show(clip, everyone = false) {
  for (const d of everyone || !clip ? dancers : [me]) d.reaction = clips[clip] ? { name: clip, until: Infinity } : null;
}
// Advance by s seconds and draw, for checking poses from the console.
Dancer.step = (s) => { update(now(), s); draw(); };
Dancer.state = () => {
  const moods = {};
  for (const d of crowd) moods[d.mode] = (moods[d.mode] || 0) + 1;
  return {
    song, me: me.mode, crowd: moods, figures: dancers.length,
    users: [...users].map(([id, d]) => `${d.name || id}:${d.mode}:${d.current ? d.current.name : '-'}`),
    actions: Object.entries(me.actions).filter(([, a]) => a.isRunning() && a.getEffectiveWeight() > 0)
      .map(([n, a]) => `${n} w=${a.getEffectiveWeight().toFixed(2)} t=${a.time.toFixed(2)} x${a.timeScale.toFixed(2)}`),
  };
};
Dancer.moves = () => Object.keys(clips);
Dancer.debug = () => ({ camera, dancers, renderer, users }); // for poking at the scene from the console

// ---- the people in the room (set by app.js)
// Each person gets a figure of their own near yours, in their own colour and
// with their name over it, that dances to their mood and does their emotes.
const users = new Map(); // user id -> figure
const tags = new THREE.Scene(); // the name tags, drawn over everything
function setUsers(list) {
  const seen = new Set();
  for (const u of list) {
    seen.add(u.id);
    let d = users.get(u.id);
    if (!d) {
      d = u.me ? me : pool.find((p) => !p.active);
      if (!d) continue; // more people than spots: the crowd stands in for them
      users.set(u.id, d);
      d.active = true;
      tint(d, u.me ? new THREE.Color(ME_TINT) : colorFor(u.id));
    }
    if (d.name !== u.name) label(d, u.name);
    d.mode = MOVES[u.mode] ? u.mode : 'chill';
  }
  for (const [id, d] of users) {
    if (seen.has(id)) continue;
    users.delete(id);
    if (d === me) continue;
    d.active = false;
    d.current = null;
    d.reaction = null;
    d.mixer.stopAllAction();
    label(d, null);
  }
}
function tint(d, color) {
  for (const p of PARTS) { p.mesh.setColorAt(d.idx, color); p.mesh.instanceColor.needsUpdate = true; }
}
// A colour of their own from their id: a mid-bright hue, so they read against
// the dark crowd without outshining you.
function colorFor(id) {
  return new THREE.Color().setHSL((hashStr(id) % 360) / 360, 0.6, 0.42);
}
function label(d, name) {
  if (d.tag) { tags.remove(d.tag); d.tag.material.map.dispose(); d.tag.material.dispose(); d.tag = null; }
  d.name = name;
  if (!name) return;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(10, 6, 24, 0.85)';
  g.strokeText(name, 128, 32, 240);
  g.fillStyle = '#fff';
  g.fillText(name, 128, 32, 240);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  d.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, toneMapped: false }));
  d.tag.scale.set(0.8, 0.2, 1);
  tags.add(d.tag);
}

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
    // Whole loops of the move, so a turn or a spin ends where it started.
    let beats = SEG[m] * (rand() < 0.5 ? 1 : 2);
    beats = Math.ceil(beats / beatsOf[move]) * beatsOf[move];
    segs.push({ move, start, beats });
    start += beats;
    last = move;
  }
  const plan = { segs, total: start };
  plans.set(id, plan);
  return plan;
}
// What a figure should be doing at time t: its reaction if one is running,
// otherwise the planned move, looked up a fade ahead so the blend into the
// next move finishes on that move's first downbeat. Returns the move and the
// beat its segment starts on (so it plays from its own beginning), or no
// start for a reaction, which just joins the beat wherever it is.
function wanted(d, t) {
  if (d.reaction && t < d.reaction.until) return { name: d.reaction.name };
  d.reaction = null;
  const { segs, total } = planFor(d.idx, song ? song.key : 'none', song ? d.mode : 'chill');
  const beat = mod(beatAt(t + fadeFor() * 1000), total);
  let seg = segs[0];
  for (const s of segs) { if (s.start > beat) break; seg = s; }
  return { name: seg.move, start: seg.start + Math.floor(beatAt(t + fadeFor() * 1000) / total) * total };
}

// Start a move now, blended from whatever is playing, in step with the song.
function play(d, { name, start }, t) {
  const next = d.actions[name];
  next.reset();
  next.timeScale = speedOf(name);
  const beats = beatsOf[name];
  if (!onceOf.has(name)) next.time = mod(beatAt(t) - (start || 0), beats) * (clips[name].duration / beats);
  next.play();
  if (d.current && d.current.action !== next) d.current.action.crossFadeTo(next, fadeFor(), false);
  d.current = { name, action: next };
}

function update(t, dt) {
  const beatMs = song ? song.beatMs : REF_BEAT * 1000;
  for (const d of dancers) {
    if (!d.active) continue;
    const td = t - d.shift * beatMs; // this figure's own idea of where the beat is
    const w = wanted(d, td);
    if (!d.current || d.current.name !== w.name) play(d, w, td);
    d.mixer.update(dt);
  }
}
// ------------------------------------------------------------ depth of field
// The scene is drawn to a texture along with its depth, then put on the
// canvas by a pass that blurs each pixel by how far it is from the focus
// distance (a ring of 41 taps, wider the further out of focus). Tone mapping
// and the sRGB conversion happen in that pass, and the page shows through
// wherever nothing was drawn.
let dof = null;
function setupDof() {
  const taps = [[0, 0]];
  for (const [r, n] of [[0.4, 8], [0.7, 16], [1, 16]]) for (let i = 0; i < n; i++) taps.push([r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, cameraNear: { value: camera.near }, cameraFar: { value: camera.far },
      focus: { value: DOF.focus }, aperture: { value: DOF.aperture }, maxblur: { value: DOF.maxblur }, aspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      #include <common>
      #include <packing>
      uniform sampler2D tColor, tDepth;
      uniform float cameraNear, cameraFar, focus, aperture, maxblur, aspect;
      varying vec2 vUv;
      void main() {
        float depth = unpackRGBAToDepth(texture2D(tDepth, vUv));
        float dist = -perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
        float coc = depth > 0.9999 ? 0.0 : clamp(abs(dist - focus) / dist * aperture, 0.0, maxblur);
        vec2 r = vec2(coc / aspect, coc);
        vec4 acc = vec4(0.0);
        vec4 s;
        ${taps.map(([x, y]) => `s = texture2D(tColor, vUv + vec2(${x.toFixed(4)}, ${y.toFixed(4)}) * r); acc += vec4(s.rgb * s.a, s.a);`).join('\n        ')}
        gl_FragColor = vec4(acc.a > 0.0 ? acc.rgb / acc.a : vec3(0.0), acc.a / ${taps.length}.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a; // the canvas wants premultiplied alpha
      }`,
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  const color = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
  const depth = new THREE.WebGLRenderTarget(1, 1);
  mat.uniforms.tColor.value = color.texture;
  mat.uniforms.tDepth.value = depth.texture;
  const quad = new THREE.Scene();
  quad.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  dof = { color, depth, mat, quad, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), depthMat: new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }) };
  renderer.shadowMap.autoUpdate = false; // once per frame, in the colour pass, not again in the depth pass
}
Dancer.dof = (on = !DOF.on) => { DOF.on = on; };

// Put every figure's parts where its joints are, then render.
const partM = new THREE.Matrix4(), GONE = new THREE.Matrix4().makeScale(0, 0, 0);
function draw() {
  for (const d of dancers) {
    if (!d.active) continue;
    d.root.updateMatrixWorld(true);
    if (d.tag) d.tag.position.setFromMatrixPosition(d.joints.neck.matrixWorld).y += 0.45;
  }
  for (const p of PARTS) {
    for (const d of dancers) p.mesh.setMatrixAt(d.idx, d.active ? partM.multiplyMatrices(d.joints[p.joint].matrixWorld, p.local) : GONE);
    p.mesh.instanceMatrix.needsUpdate = true;
  }
  renderer.shadowMap.needsUpdate = true;
  if (DOF.on) {
    renderer.setRenderTarget(dof.color);
    renderer.render(scene, camera);
    scene.overrideMaterial = dof.depthMat;
    renderer.setRenderTarget(dof.depth);
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    renderer.setRenderTarget(null);
    renderer.render(dof.quad, dof.cam);
  } else {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
  renderer.autoClear = false; // the name tags go on top, sharp, after the blur
  renderer.render(tags, camera);
  renderer.autoClear = true;
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
  draw();
}

init();
