# Dancer clips

The 3D dancer (`public/dancer.js`) animates a figure with motion clips and
blends between them. Without any clip files it falls back to a built-in
silhouette with rough procedural moves. Real motion capture goes in
`public/dancer/` (gitignored: the files are big and Mixamo's terms cover
using them in your own project, not re-publishing them).

## Getting clips from Mixamo

[Mixamo](https://www.mixamo.com) (free with an Adobe ID) has a large library
of motion-captured dances and gestures that all share one skeleton, which is
what lets any clip blend into any other.

1. Pick a character (Y Bot or X Bot are the plain mannequins).
2. Download the character once **with skin**, as **FBX Binary**, 30 fps, no
   keyframe reduction. Save it as `public/dancer/rig.fbx`. Any animation is
   fine for this download; it is only used for the mesh and skeleton.
3. For each move, download the animation **without skin** (FBX Binary, 30 fps)
   and save it as `public/dancer/<move>.fbx`. Leave the trim and the
   character-arm-space sliders alone; "in place" should be ticked where the
   option exists, so the dancer stays on their spot.

Moves worth grabbing (search Mixamo by these words; names vary a little):
dance loops such as Hip Hop Dancing, House Dancing, Wave Hip Hop Dance,
Snake Hip Hop Dance, Twist Dance, Samba Dancing, Salsa Dancing, Swing
Dancing, Robot Hip Hop Dance, Breakdance 1990, Silly Dancing; and reactions
such as Cheering, Clapping, Jump, Angry (for booing).

## manifest.json

`public/dancer/manifest.json` names the rig and the clips. `beats` is how many
beats one loop of the clip covers: play it in Mixamo and count along (most
dance loops are 8 or 16). If unsure put 8; the dancer will just run at the
wrong multiple of the tempo, which is easy to spot and fix.

```json
{
  "rig": "rig.fbx",
  "once": ["jump"],
  "clips": {
    "groove": { "file": "hip-hop-dancing.fbx", "beats": 16 },
    "bounce": { "file": "house-dancing.fbx", "beats": 8 },
    "twist":  { "file": "twist-dance.fbx", "beats": 8 },
    "cheer":  { "file": "cheering.fbx", "beats": 4 },
    "clap":   { "file": "clapping.fbx", "beats": 4 },
    "jump":   { "file": "jump.fbx", "beats": 2 },
    "boo":    { "file": "angry.fbx", "beats": 8 }
  }
}
```

Clip names the dancer knows: `idle`, `groove`, `bounce`, `roof`, `twist`,
`step` (moves), and `cheer`, `clap`, `jump`, `boo` (reactions). Clips listed
under `once` play through once instead of looping. glTF (`.glb`) files work
too, with the same layout.
