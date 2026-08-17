# Horizon Ride

A lightweight, Android-first, 3D off-road dirt-bike game.

**Current status: Chapter 5B — Vegetation & ecosystem.** The world has grown
from 32 km2 to 40 km2 (8,000 x 5,000 m, 160 streamed sectors) with five
distinct regions: Rider's Meadow in the center (spawn, lake, cabins),
the Glacier Wall in the north (five 820-1,290 m peaks), the Volcanic
Highlands in the east (basalt, ember glints, Mount Ember caldera), Red
Canyon in the west (a carved sandstone trench with strata banding) and
the Coastal Cliffs in the south (black-sand beaches falling to a real
ocean at sea level 42 m). The road network is 26 named handcrafted
spline roads — 8 mountain passes (incl. the Eagle Pass Road and its
authored serpentine approach), 6 scenic roads (Horizon Loop, Coastal
Road, Red Canyon Road, Caldera Road, Glacier Route, Meadow Loop) and 12
hidden trails — every one connecting meaningful places, none ending
randomly. 15 landmarks (lookouts, cabins, stone arches, prayer-flag
hills, caves, rest areas) are all verified reachable on the bike by CI.
Since Chapter 6 the land between those places is rolling 45-120 m
country — valleys, ridges, benches and basins — instead of a high plain.
The map has no invisible walls: the north is blocked by glacier faces,
the south by the ocean, the east by volcanic cliffs and the west by
canyon walls. Bike physics, the original FollowCamera and the streaming
architecture (SectorWorld / ChunkGrid / ObjectPool) are untouched.

**Chapter 5 (this revision)** is a smoothness-and-depth pass over that
world — no new landforms, no re-authored roads, no touched physics,
camera, controls, UI, save data or graphics presets:

- *Terrain sampling is 2.6x cheaper* (measured, and bit-identical: the
  road corridor mask got a spatial index instead of a 56-segment scan,
  the corridor/mountain fields are memoized inside a sample, and the
  nearest-point helper no longer allocates an object per call — it was
  the engine's biggest garbage source and therefore its GC hitches).
- *Terrain tiles build in row slices under a frame budget.* A tile is
  1,225 samples; building one per frame was the drop players felt while
  riding. The builder now stops when its slice of the frame is spent and
  resumes next frame, so the worst frame is bounded on any device.
- *Vegetation and props are amortized too*: plant cells generate
  candidate-by-candidate under their own budget and wait a few frames
  behind the terrain fill (they share the same 125 m grid), and prop
  seating heights are cached instead of re-sampled on every crossing.
- *Painted relief*: terrain vertices now carry curvature-based ambient
  occlusion and warm-sun / cool-sky directional paint, and the far
  backdrop is shaded identically so the LOD handover no longer steps in
  tone. Cloud shadows and a colour push run in the shared palette.
- *Roads read hand-made*: three-scale organic bed edges, dusty and damp
  stretches, and grass creeping back over quiet shoulders.
- *A fuller world*: a clustered ground-detail scatter (stones, scree,
  spires — existing instanced models, zero extra draw calls) fills the
  space between landmarks.

**Chapter 6 (this revision)** rebuilds TERRAIN GENERATION only — physics,
camera, controls, UI, save data, streaming and the Chapter 5 performance
work are untouched. The old field was a 115-325 m fBM plain with mountain
skirts spilling right across the map: only 9% of the world sat in the
0-120 m band, the mean elevation was 489 m, and an interior transect
crossed zero ridge crests — flat plains between giant isolated hills.

The new field is built the way water builds a landscape:

1. **Drainage** — a gentle tilt from the interior down to the south shore.
2. **Relief regions** — ~2.4 km patches of hill country and flat-pan
   basins, so the world has open plains *and* busy ground.
3. **Ridges** — contrast-stretched ridged noise lays crest *lines* (not
   blobs), domain-warped so they meander: a scenic crest every ~500 m.
4. **Erosion valleys** — a dendritic network of main valleys with
   tributaries that only exist inside them, deepening downstream.
5. **Benches** — short escarpment steps on the hill flanks: cliffs to
   ride along, never vertical walls.
6. **Road corridors** — every main route carries a shallow vale of its
   own, so roads run *along* valley floors, and pass roads switchback up
   the border massifs.

Measured against the brief (audited over 64,521 samples on a 25 m grid):

| target | before | after |
| --- | --- | --- |
| terrain in the 0-120 m band | 9.1% | **77.8%** (98.6% of non-massif land) |
| mean elevation | 489 m | **179 m** |
| max elevation | 2,183 m | **2,231 m** (Kanjiro Peak) |
| scenic ridge spacing | no crests found | **680 m median** |
| rolling-country slope | 9.5% over 37 deg | **p50 4.8, p95 20.3, 0.47% over 37 deg** |
| steepest open-country ground | 89.6 deg | **57 deg** (a coastal cliff, not a wall) |
| named landforms | 0 | **4 ridge systems, 3 basins, 2 plateaus, 2 lakes** |
| viewpoints | 14 computed | **14 (6 authored major + 8 computed)** |

The last 22% sits in the border ranges themselves — on an 8 x 5 km map a
mountain ring around three edges is about a fifth of the area, which is
why the second row matters: essentially *all* rideable land is now in the
0-120 m band. Massif flanks and the Red Canyon walls stay steep on
purpose; nothing in the open country does.

Border mountains stay at the map edges (a confinement mask forbids inland
massifs), the 14 named peaks and the 2,239 m Kanjiro summit remain, and
all 26 roads still meet their grade limits (mains 9.2 deg, passes 8.6
deg).

**Chapter 5A** puts named structure on that eroded grain — again terrain
generation only. The noise layer gives the world its texture; this layer
gives it landmarks you navigate by:

- **4 ridge systems** (Sentinel, Larkspur, Ember, Vanguard) — polyline
  spines whose crest undulates into named high points with saddles
  between them, so they read as ranges, never as isolated domes.
- **3 large basins** (Sundown, Kestrel, Willow) — wide flat-floored bowls
  that open the country up between the ridges.
- **2 plateaus** (Anvil, Copper Table) — flat tables on a ~28 degree rim:
  gentle cliffs you ride along looking for the ramp.
- **2 crystal lakes** (Mirror Lake in Sundown Basin, Azure Tarn under the
  Glacier Wall) — LEVELLED lakes: the pan is blended flat and the shore
  ring pinned above the waterline, so the water never stands proud of a
  downhill bank. Both are clear of every road apron; they get their own
  paler water material (one extra material, one draw call each).
- **6 major viewpoints** on the new landforms, merged into the
  road-computed viewpoint list so the prop system furnishes them exactly
  like the rest.

Every feature is a smooth analytic blob (quartic falloff / smoothstep
rims) and corridor-aware, so none of them can add a wall or bend a road
past its grade limit.

**Chapter 5B** populates that terrain with a living ecosystem — vegetation
and environmental detail only; terrain, roads, physics, camera, UI,
streaming and the save system are untouched.

**24 instanced models, five families, two shared materials**

| family | models |
| --- | --- |
| trees (5) | pine, fir, oak, birch, dead tree |
| bushes (4) | small shrub, round bush, mountain bush, dry bush |
| grasses (6) | meadow grass, tall grass, sedge, tussock, reed, alpine grass |
| wildflowers (3) | yellow, purple, white |
| ground | fern patches, clover patches |
| detail | fallen log, mossy log, tree stump, moss rock (+ 4 rock-cluster arrangements in the prop layer) |

**Ecosystems, not scatter.** Every 125 m cell lays 2-4 *stands*, each with
a dense core and a thinning edge (radius `r * u^0.9`, not the uniform
`r * sqrt(u)`), and one stand in three carries a clearing — an empty
middle that reads as a glade. Nothing is grid-aligned, rotation is
random and scale is 0.85-1.25. A stand also picks its own wildflower
colour, its own third sward species and its own kind of forest debris,
so a wood shows logs *or* stumps *or* mossy boulders rather than all
four at once.

Zones follow the brief: the spawn valley is open meadow (groomed core
clear, sward from 130 m, light trees past 260 m), the rolling hills are
mixed broadleaf woods with bushes and stone, the mountain slopes above
150 m are dense pine and fir with little sward and more rock, the ridge
crests stay sparse and every viewpoint keeps a 46 m clear bowl. Roads
keep a clear corridor — 11 m for anything with a trunk, 6 m for sward —
and nothing is planted within 26 m of a cabin, cave, bridge or arch.
Lake shores carry reeds, sedge and the occasional birch.

**Optimisation.** GPU instancing (one InstancedMesh per model, no
individual tree meshes), two shared materials, fixed-capacity instance
pools inside the existing chunk streaming, tree impostors past 250 m and
ground cover culled to the inner ~190 m ring. Instance transforms are
written straight into the instance buffer (sixteen float stores instead
of a Vector3/Euler/Quaternion/Matrix4 chain per plant) and the far ring
walks only each cell's tree prefix. Colour variation is per-INSTANCE
(`instanceColor`), so a whole meadow of one mesh comes out in a hundred
shades without a second material or draw call. Measured streaming cost
over a 90 s ride: 855 ms total, p95 0.2 ms, p99 3.1 ms per frame.

**Chapter 5C — vegetation rebuild.** Placement was rebuilt around three
ideas. **27 forest patches** of 180-350 m across, each with a lobed
(never circular) outline from three angular harmonics, a dense core, a
natural edge and an interior clearing in one patch out of three, laid on
a jittered grid plus eight patches ringing the spawn. **One ecosystem
rule set** read top to bottom — spawn valley: open meadow with scattered
oak and birch; rolling hills: mixed woods; mountain slopes above 150 m:
dense pine and fir; ridge crests: sparse; basins: bushes and flowers;
lake shores: sedge, grass and the odd birch; dunes: bunch grass — with a
6 m clear riding corridor on every road. And a **spawn grove** placed
explicitly in polar coordinates: two golden-angle spirals around the
spawn point (21-77 m and 60-140 m), jittered, filtered by the same road,
water and slope rules, with a riding lane kept open along the spawn
heading. A cell budget can only populate a region on average; the spiral
is what makes a specific 120 m circle look the same in all eight
directions.

The species set was consolidated at the same time — per-instance tints
carry the colour variety, so three wildflower meshes became one, six
grasses became four and two logs became one. Five fewer InstancedMeshes
brought draw calls at the spawn from 99 to **96**.

**Chapter 5D — mature forest rebuild.** The trees were too small to be
woodland. A "pine" topped out at 6.7 m and an "oak" at 4.4 m, so a rider
looked *over* the forest instead of into it — which is what made it read
as decoration no matter how many trunks were placed.

**Scale is now a first-class property.** Every tree geometry is
normalised to exactly one unit tall (`normH`), so an instance's uniform
scale IS its height in metres, and placement draws that height from a
species range: pine 12-18 m, fir 10-16 m, oak 8-14 m, birch 7-12 m, dead
snag 6-10 m. One line at the end of the ecosystem rules applies it, so
every path that can produce a tree gets a mature one. Two consequences
had to be handled: trunk collision radii became radius **per metre of
height** (tuned so the absolute figures land where they were — pine
~0.45 m, oak ~0.6 m — and the bike's feel through timber is unchanged),
and the ground-sink is a flat 0.12 m for trees instead of 6% of scale,
which at 15 m would have buried the bole.

The silhouettes were rebuilt to match the new size. A pine carries a
clear bole for its lower third and five narrowing cone tiers above it; a
fir is tighter, bluer and tiered further down; an oak forks into two
limbs under a four-lobe crown wider than the tree is tall; a birch holds
an airy crown on a slim pale trunk. Impostors were re-normalised to the
same unit height, so a distant tree is scaled by the same number its
near-ring twin would use and the two rings agree at the LOD boundary.

**Patches: 39, from 212 m to 399 m across**, in three groups — the eight
spawn-ring patches, a jittered 6x4 open-country grid, and (new) up to
twelve **roadside stands** seeded off the road vertex list itself, 70-150
m to one side with a radius that reaches back over the carriageway. Also
new: trees may stand on a built road's graded apron. `info.trail` merges
the apron (which fades out as far as 190 m) with the hidden 2.5 m
shortcut trails, and rejecting every candidate touched by either is what
kept the woods 40 m back from every route. Near a registered road the
exact 7 m corridor test is now the only gate — it is the real safety
guarantee — while away from one the tight gate stays so the shortcuts are
never grown over.

Density measured within 250 m of the rider: 153 at the spawn meadow, 141
in the pine belt, 116 on the forest road, 104 on the hillside, 141 at the
ridge — inside the brief's 120-180 band, with bush undergrowth, ferns,
fallen logs and rock in the same radius. The spawn valley's forced tree
floor came *down* (it was written for 4 m trees and put 239 trunks inside
250 m, closing in the meadow the brief wants left open), and the spawn
grove was thinned and set back to 34-154 m so the trees ring the bowl
rather than crowd it.

Draw calls at the five view points run 87-94 against a budget of 100.
Nothing was added to the mesh count: 19 near species plus 5 impostors,
two shared materials, all instanced. Sward and ferns were dropped from
the shadow-caster set, and empty species are skipped outright — measured,
that second one is draw-call neutral, because three.js already early-outs
on an instance count of zero.

**Hotfix — vegetation integration.** Three chapters of placement work
kept landing on a world that still read as thin, so this pass audited the
delivery path instead of the generator. The wiring was sound:
`SectorWorld` constructs `Vegetation`, `vegetation.update(x, z)` runs
exactly once per rendered frame (measured 21 calls / 21 renders), and all
24 InstancedMeshes are in `scene.children`, visible and
`frustumCulled = false`. The defect was downstream of all of that.

Every species has a fixed instance buffer, and a plant that arrives after
the buffer is full is silently dropped. The rebuild walked the window
`for dz = -R..R { for dx = -R..R }` — starting at the *far north-west
corner*, 400+ m out, and reaching the player's own cell halfway through.
So the buffer was spent on trees near the horizon and the trunks in front
of the rider were the ones discarded. Measured at the spawn: 349 oaks
existed inside the near window, the 160-instance buffer filled at a
median distance of **227 m** (max 436 m), and 30 of the 57 oaks within
120 m never reached the GPU. The foreground was being deleted to pay for
the background.

Two changes. Cells are now visited **nearest-first** (near ring before
impostor ring, closest cell first within each band; the order is computed
once per radius and cached), so a full buffer keeps the *closest* plants
— the only ones the player can see. And the oak and birch buffers, the
two species the spawn valley is actually made of, were sized to the stand
they have to hold (160 -> 320, 200 -> 300); instances are vertex work,
not draw calls. Oaks written within 120 m went 27 -> 44 of the 44 that
survive density thinning, and the near window carries 481 trees where it
carried 361. Draw calls are unchanged at 96.

The brief's test instrument ships with it: `?forcepines=50` (or
`world.vegetation.debugForcePines(50, 100)`) replaces the pine buffer
with exactly 50 trunks on a golden-angle spiral around the rider, ramped
linearly from 12 m to 100 m and re-applied after every window rebuild.
It bypasses the ecosystem rules, the thinning and the cell cache, so it
isolates instance buffer -> mesh count -> scene -> framebuffer: if those
50 do not appear, the fault is integration; if they do, the fault is
placement. They appear — 50 instances, nearest 12.9 m, 15 inside a 68 deg
frustum, no console errors. Off in normal play.

 The spawn stood *on* the 4-way
junction, so however well the meadow was populated the first frame was a
wide dirt road filling the bottom third. The spawn moved 44 m into the
meadow grass at (4026, 2464): the South Arm is 26 m to the west (a dirt
road in view, not underfoot), the ground is flat (0.3 deg), the cabin and
lake lie beyond it, and forest patches ring the horizon. Validated the
way the brief asked — by eye, in eight compass screenshots rather than
by counting instances: N, NE, E, SE, S, SW, W and NW all show trees,
with wildflower drifts, grass, bushes, rock clusters and a fallen log in
the near field. Nothing with a trunk is planted within 13 m of the spawn
point, so the player never starts inside a tree. No terrain, road or
vegetation-generation change.

**Hotfix 5B.2 — vegetation render fix.** The world measured full but
looked empty, so the vegetation system was instrumented rather than
re-tuned. `world.vegetation.debugReport()` now returns exactly what the
GPU is being fed (instances per family, active cells, render radii,
nearest tree, scene attachment) and `debugSetCulling(false)` drops the
culling and thinning rules for A/B comparison. The audit cleared the
usual suspects — 29/29 instanced meshes attached and visible, no
instance-capacity clipping, and the spawn exclusion mask removing zero
trees — and found three real defects:

1. **Quality thinning was applied to trees.** A phone preset (25%)
   deleted three out of four *trees*, not just grass — the silhouette of
   the world went with the filler. Ground cover now takes the full cut
   and woody plants keep at least 80%: the tree line is ~212-272
   instances at *every* tier instead of collapsing to ~70.
2. **The impostor ring collapsed into the near ring** at the low tiers
   (requested radius 2 cells == the full-detail radius), so those presets
   drew *no* distant trees at all and the horizon was bare. The far ring
   is now always at least one cell beyond the near ring.
3. **Stale grow-in animations wrote into reassigned instance slots.**
   Slots are reallocated on every window rebuild, so an in-flight
   grow-in could stamp its own plant's transform over whatever now owned
   that slot — a tree visibly jumping or shrinking away. Entries are now
   versioned against the rebuild.

Render distances: full models to **250 m**, impostors to 375-500 m,
ground cover to 125 m. Six patches now ring Rider's Meadow with their
lobes reaching over the spawn point, so the player starts *inside* a
forest patch: **44 trees rendered within 120 m and 130 within 250 m even
on the potato preset**, with trees in all eight compass sectors.

**Hotfix 5B.1 — spawn and forest patches.** Two rounds of audit fixed a
world that measured full but looked empty. First: 18% of rideable ground
was more than 150 m from a tree (5% beyond 300 m, worst hole 848 m) — now
**0% is beyond 300 m** and 0.7% beyond 150 m (p95 89 m). Second: the
spawn itself. The scattered-tree model was replaced by **28 forest
patches** of 140-250 m radius, each with a lobed (never circular)
boundary from three angular harmonics, a dense core, a natural edge and
an interior clearing in one patch out of three, laid on a jittered grid
so nothing is aligned. Four of them ring Rider's Meadow, and the spawn
bowl carries a guaranteed budget of groves and ground detail: **59 trees,
28 bushes and ~64 flowers/grass clumps within 120 m of the spawn**, with
mature trees in all eight compass sectors (235 within 300 m). Close-range
detail — ferns, small bushes, fallen logs, mossy stones and wildflower
drifts — is generated on demand only for cells inside the ~190 m culling
ring, one cell per frame, so the density the player sees costs nothing at
range. Grass models were rebuilt from crossed rectangles (cardboard from
the saddle) into clusters of tapered blades: better looking and fewer
triangles.

The palette gained three-scale grass variation, finer rock strata,
moisture-driven ground-tint blending and a slow ambient hue drift — no
lighting changes. No texture anywhere exceeds 512 px.

## Tech

- [Three.js](https://threejs.org/) for rendering (only runtime dependency)
- Custom arcade heightfield physics (no physics engine — stable and cheap on low-end phones)
- Plain DOM/CSS for all UI (menu, pause, crash, touch HUD) — zero GPU cost, crisp at any DPI
- Vite for dev/build
- Runs in any Android browser; wrapped as an APK via Capacitor (`android/`)

## Run

```bash
npm install
npm run dev      # dev server
npm run build    # production build -> dist/
```

## Controls

| Action      | Touch                | Keyboard          |
| ----------- | -------------------- | ----------------- |
| Accelerate  | GAS (right)          | W / Up arrow      |
| Brake / Rev | BRAKE (right)        | S / Down arrow    |
| Steer       | ◀ ▶ (left)          | A, D / arrows     |
| Stunt/Trick | STUNT / TRICK        | Shift / Space     |
| POV toggle  | POV (top right)      | C                 |
| Reset bike  | ↺ (top right)        | R                 |
| Pause       | ⏸ (top right)        | Esc or P          |
| Debug HUD   | DBG (right edge)     | F3                |

Steering modes (Settings): buttons, virtual handlebar, tilt, swipe.

## Architecture

World (Phase 3 landforms on the Phase 2 foundation + Phase 1B streaming):

- `src/world/Landforms.js` — the authored continental skeleton: 4 ridge
  chains of named peaks with saddles, U/V valleys, flat-pan basins,
  escarpments, the summit plateau, and the FULL road hierarchy (main
  roads / pass switchbacks / spiral; grade-clamped by construction,
  junction-pinned, spatial-hash blended with bed-dominance weighting so
  junction handovers are seamless) plus road-computed scenic viewpoints.
- `src/world/Props.js` — instanced exploration props (7 InstancedMeshes):
  prayer flags, signposts, rocks, lookout platforms, cabins, caves,
  resting spots; deterministic per-sector placement, streamed with the
  sector window, solid props feed the bike's collider system.
- `src/world/TerrainField.js` — the analytic ground truth: height, trail
  mask, moisture and mountain factor as pure deterministic functions of
  world (x, z). Composes the Phase 2 rolling lowlands with the Phase 3
  landforms; lowland trails fade out at the foothills where pass roads
  take over.
- `src/world/FarTerrain.js` — static low-LOD continent backdrop: the whole
  world sampled once at 62.5 m into 4 frustum-culled meshes (~25 k tris);
  near-field fragments discarded under the streamed tiles.
- `src/world/palette.js` — shared vertex-color altitude palette
  (grass -> basin scrub -> alpine rock -> snow, roads always readable).
- `src/world/TerrainTiles.js` — render layer: pooled 125 m terrain tiles
  (7x7 window, 32x32 quads on an exact-binary global lattice) rebuilt
  nearest-first 2-3/frame. Shared vertex-colored Lambert material, no
  textures. Borders are bit-identical => zero seams, no skirts needed.
- `src/world/SectorWorld.js` — the fixed world facade: permanent 20x10
  sector grid (500 m sectors, IDs (0,0)..(19,9)), 3x3 logical sector window
  (gameplay content attaches here in later phases), world interface for the
  bike — `{ getHeight, getNormal, getColliders, getSurface,
  getRenderedPlane, getSpawn, isInBounds, update }` — plus `slopeAt` for
  the debug overlay. Spawn sits on a dirt trail near the world center.
- `src/world/streaming/ChunkGrid.js` — window bookkeeping with enter/leave
  deltas (drives both the sector and the tile windows).
- `src/world/streaming/ObjectPool.js` — fixed-capacity mesh pool
  (tile load/unload never allocates).
- `src/world/noise.js` — seeded hashing / value noise / fBM utilities.

Game core (preserved foundation):

- `src/bike/Bike.js` — arcade physics: ground/air states, suspension,
  surface grip/drag/roughness, wheelies/endos, flips, crash detection,
  safe-spot reset. Talks to the world only through the sampling interface.
- `src/bike/BikeModel.js` — low-poly bike + rider built from primitives,
  terrain-seated wheels, blob shadow (no shadow maps).
- `src/core/Game.js` — state machine (menu/playing/paused/crashed) +
  fixed-timestep loop.
- `src/core/Input.js` — keyboard + touch abstraction with selectable steering
  modes (buttons / handlebar / tilt / swipe).
- `src/core/FollowCamera.js` — smoothed third-person chase camera with
  terrain clearance + eased first-person POV.
- `src/core/Settings.js` — persisted control preferences + custom HUD layout.
- `src/core/RunStats.js` — run distance (teleport-guarded), persistent best.
- `src/core/StuntTracker.js` — trick detection/scoring/combos from bike state.
- `src/core/GameAudio.js` — synthesized engine + optional music (no assets).
- `src/ui/UI.js`, `src/ui/HudEditor.js` — DOM overlays + HUD layout editor.
- `src/ui/DebugOverlay.js` — developer overlay (F3 / DBG button): FPS,
  player X/Z, current sector, loaded sectors/tiles, terrain height, player
  altitude, slope, draw calls.

## Tests

```bash
bash tests/setup-browser.sh   # once per machine: headless-Chromium toolkit (to /tmp)
npm run test:e2e              # full foundation verification against the dev server
```

Made by Sworup Karki
