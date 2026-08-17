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

**Chapter 6B — world art pass.** The world was drab. Every band in the
palette converged on one olive, so a meadow, a hillside and a mountain
flank a kilometre away all read as the same khaki, and eighty pines on a
slope read as eighty copies of one pine. No geometry changed here; this
is colour.

**Hue separation, not more noise.** Grass gained a 300 m *meadow mood*
field that swings a whole sward between fresh growth and sun-cured straw
as a hue rotation — red climbs while blue falls — so neighbouring
meadows read as different grasses rather than the same grass under
different light. The dry upland band is now gated on moisture as well as
altitude (keyed on height alone it painted every square metre above
145 m the same khaki), a cool *upland pasture* band was added between
the meadows and the rock, and the rock band itself moved from 260-720 m
up to 360-860 m: the conifer belt runs to about 700 m, so forested
hillsides were being painted as scree with trees standing in them. Rock
strata split into warm iron-stained and cool slate bands instead of one
grey lightening and darkening.

**Ground painting** happens in the tile builder, where the vertex normal
already exists and costs nothing. Grass thins on anything steeper than
about 25 degrees and the warm earth shows through; concave ground —
gullies, valley floors — takes a cooler, more saturated green while
convex ridge lines and banks dry out. That slope pass is mirrored exactly
in the far backdrop, because the two LODs sharing a palette is a hard
invariant here.

**Canopy variation.** Trees now carry a per-instance tint like the sward
already did — three floats per instance, no extra draw call, no extra
material — on a curve of their own that runs deep blue-green to warm
olive. The sward curve swings toward straw, which on a conifer just looks
dead. Mature heights went up about 10% (pine 13-20 m), and the forest
edge falloff holds full density further out (0.42 -> 0.55 of the patch
radius) with the remaining margin broken by a 40 m noise field, so a wood
ends in outliers and bays instead of on a tidy contour. Stone families
took a per-instance tint too, warm through neutral to cool slate.

**Atmosphere.** The horizon colour is now a single exported constant
shared by the sky gradient, the scene fog and the backdrop, so all three
resolve to the same value at the skyline instead of leaving a band. The
sky runs four stops rather than three; cloud shadows deepened from 0.13
to 0.19 (at the old value they were illegible past 200 m, and cloud
shadow is most of what makes a wide valley read as a wide valley); and
the saturation push went 0.16 -> 0.26, because the whole point of the
style is that colour, not texture, carries the surface.

One thing was tried and reverted: mixing high backdrop ground toward the
horizon colour to separate the mountain layers. It works in isolation but
applies to the backdrop only, so ground at the same altitude changed
colour the moment a streamed tile took over, and where the coarse mesh
poked through it showed as a flat pale slab in the middle distance.
Distance haze has to come from fog, which is a function of camera
distance and therefore agrees across both LODs by construction.

Draw calls at the five preview points are 79-119, unchanged from before
the pass. Preview frames are in `shots/`.

**Chapter 6A — macro terrain composition.** The lowland was carrying its
whole shape in noise: ridged fields at ~190 m and ~80 m wavelengths that
were statistically interesting and structurally meaningless. A quarter of
the interior sat pan-flat (under 6 m of relief across a 500 m circle)
while the 95th-percentile slope stood at 25 deg — a plain with a rash on
it. Nothing a rider crossed related to anything else.

The composition is now authored and the noise is demoted to grain.

**Four valley systems** (`VALLEY_SYSTEMS`) are polyline trunks with a
flat floor and a quartic wall. Fernwater, Kingsmere and Emberflow run
north to south down the continental tilt; **Southmarch** gathers them
along the coastal plain, so water — and a rider — can go from the
northern foothills to the sea without climbing out of a valley. They are
deliberately wide and shallow: 26 m over a 380 m half-width is a 6.4 deg
wall, and a valley you can see across is what connects a landscape,
where a ravine would just be a wall with a floor.

**Six ridgelines**, up from four, each running the length of the country
it divides, with two new ones closing the north-east interior (Halcyon)
and standing between the basins and the coastal plain (Sable). Every
flank got wider for the same height: with the quartic profile the
steepest gradient is `h * 1.54 / w`, so the old 50 m over 250 m stood at
17.1 deg — past the rideable ceiling — while 52 m over 340 m stands at
13.2 deg. **Gentle cliffs** come from a terrace band on the outer flank,
peaking at 0.9 of the half-width where the profile has already gone
slack; a step nearer the crest lands on the steepest part at u~0.58 and
the two gradients add into something unrideable, which is exactly what
the first attempt did (29.5 deg).

**Basins and valleys merge rather than sum** — a basin is where valleys
end, so a trunk running into one settles onto its floor instead of
digging a second trough through it. Summing them cost 10 m at the Twin
Lakes confluence, enough to put a landmark under the waterline once the
lake carve came off.

Measured over the interior (clear of the border-mountain band, above
water): **93.7% of ground is rideable at 16 deg or less**, median slope
4.1 deg, p95 16.9 deg. Off the road corridors and the authored Red
Canyon it is 92.7% with a 26.1 deg maximum — those maxima are the ridge
terraces and the plateau rims, i.e. the gentle cliffs the brief asked
for. Pan-flat interior fell from 24.4% to 19.2% while median relief over
a 300 m circle rose from 10.7 m to 13.8 m: less flat AND less steep,
because the relief moved from noise into structure. Border massifs
remain strictly at the edges — zero massif samples more than 1,120 m
inland. `tools/verify6a.mjs`, `tools/preflight6a.mjs` and
`tools/routes6a.mjs` reproduce all of these numbers.

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

**Chapter 7A — Whisper Valley rebuilt.** A complete rebuild of the spawn
region: Rider's Meadow is no longer the player's starting point — spawn has
moved into the centre of a continuous ~2.2 km handcrafted valley that
RESEMBLES NO OTHER REGION. 400 m wide floor with 3-10 m rolling noise
variation, and TWO continuous hill chains flanking the player for the
entire valley length. Left Hills (north) 55 m tall × 130 m half-width
with a gentle cos² crest; Right Hills (south) 65 m tall × 130 m
half-width with a steeper cos^2.6 crest. Always-both-sides hills mean
the player never sees a flat horizon inside the valley. 4 large forest
masses (r=85-90 m; pine/birch mix) at NW/NE/SW/SE of spawn provide
continuous woods instead of scattered trees. 6 boulder clusters at the
hill bases mark where the new hills meet the valley floor (24 boulders
total). One winding dirt road — **Whisper Path**, type-1 scenic, 4 m
bed, grade 0.10, strong lateral wander — connects both valley ends to the
(split) West Arm at z=2500. Nothing random: every placement is authored.
Spawn moved to (2150, 2610) with yaw = π/2 (facing east along the
valley); the straight slice of West Arm that crossed the valley floor
is DELETED. From spawn the player sees: winding dirt road, forests on
both sides, enclosing hills, no flat horizon. Preview at the live
dev URL after `npm run dev`. Build once, test once. No other regions
touched. Bike physics, camera, UI, streaming, quality, save unchanged.

## Chapter 7B — Whisper Valley living environment

Populates Whisper Valley (already rebuilt in 7A) with authored flora and
furniture. NOTHING in the locked systems changes, NOTHING in other
regions changes, NOTHING in the terrain itself changes.

**Forests (9 patches).** 4 dense pine patches (r=85-110 m, strength
1.75-1.85) + 3 oak groves (broadleaf, r=85-95 m) + 2 birch groves
(r=85-90 m). Each has the lobed irregular-edge shape from buildZones;
their high strength DOMINATES the existing cell ecosystem in WV so the
forest reads as continuous woods rather than scatter. Trees inside
Whisper Valley are scaled 1.30-1.80× (mature pines 13-20 m, oaks 11-18 m,
birches 9-15 m) for a real-forest feel rather than scattered sprites.
Inside the small clearings inside the densest forests, trees scale
back to ~65% — cleared glades feel open.

**Meadows (6).** Hand-placed wildflower meadows (kind='flower',
r=55-80 m) at the road entrances and between forest masses; surrounding
zones at the forest edges carry moisture-rich clover / tall grass
(16 small zones between the forests, each r=26 m). The Whisper Path has
been laid OUTSIDE these zones (zone placement skips any cell near the
road bed), so the riding line stays clear.

**Cabins (3).** Each handcrafted cabin (existing 'cabin' prop, coll:3.2
SOLID) has 5 SOLID accessories fanned out around the door:
- **fence**: existing 'fence' prop (coll:5×0.55 m circles), 6.5 m
  behind the cabin along the cabin's -forward axis
- **woodpile**: NEW 'woodpile' prop (3 stacked logs, coll:0.65),
  4 m behind the cabin
- **bench**: existing 'bench' prop (coll:0.9), 4 m in front of the
  door, facing back at the cabin
- **campfire**: NEW 'campfire' prop (stone bowl with glowing
  embers, coll:0.55), between bench and viewer
- **signpost**: existing 'sign' prop (coll:0.32), to one side, marking
  the cabin for debug overlay / F3 reference

**Natural details.** 24 hill-base boulder clusters from 7A + 30
new hand-placed boulders (`WHISPER_BOULDERS`) = 54 total
(spec 50-70). 30 fallen logs (`WHISPER_LOGS`) scattered by deterministic
seeds along the floor + forest edges (cylinder geometry solid by
3 collider circles along the length). 20 tree stumps at clearings and
meadow edges.

**Collisions (every prop SOLID).** Cabin (3.2 m circle), fence (5×0.55 m
per post), bench (0.9 m), sign (0.32 m), campfire (0.55 m), woodpile
(0.65 m), log (3×0.40 m), stump (0.30 m), boulder (2.2 m). The bike's
existing prop-collider system picks all of these up — nothing is
visual-only.

**Optimisation.** +4 InstancedMesh draws (campfire / woodpile / log /
stump), all using the shared MeshLambertMaterial — no new material.
Total prop draws = 20 (16 existing + 4 new). Combined with vegetation
(20 main instances + 5 impostors), terrain tiles (~6), far backdrop,
and the existing sky / sun (1 drawCall each): well under the 110-draw
cap. 60 FPS is preserved because instance count per frame is bounded
and no new shader is loaded.

**Preview.** Live preview at `npm run dev` after commit:
1. **Spawn meadow** — `(2150, 2610)` looking east: Whisper Path
   coming forward, pine + oak forest walls on every compass.
2. **Forest road** — ride Whisper Path through the woods.
3. **Wooden cabin** — walk to any of the 3 cabins; woodpile
   behind, bench + campfire in front.
4. **Flower meadow** — ride to either road entrance (x=1380 or
   x=3220) and look over the meadow.
5. **Forest clearing** — walk into one of the 4 small clearings
   inside the densest pines; trees recede, the rolling floor reads.

**Chapter 7C — Whisper Valley ecosystem fix.** Distribute the flora and
make the 7B cabins discoverable from the road. The terrain, roads,
lake and locked systems are UNCHANGED.

*Forests.* The 7B forest patches were piled up around x=2150, x=2480,
x=2820 (three pairs of pairs). 7C redistributes them as 8 single
patches along the full 2.2 km valley, alternating N/S of the road so a
given compass always sees wood on at least one side: 1430/2470 pine,
1680/2710 birch, 1930/2470 pine, 2180/2710 oak, 2430/2470 pine,
2680/2710 oak, 2930/2470 birch, 3180/2710 pine. Each is r=70-90 m
(140-180 m diameter — within the 80-180 m width spec) with strength
1.70-1.95 so they still dominate the cell ecosystem. Spawn-visibility:
forest 3 (x=1930) and forest 4 (x=2180) are both within 300 m of the
spawn at (2150, 2610), so the rider discovers a forest entrance on
first frame.

*Meadows.* 8 visible wildflower meadows (was 6) alternating N/S of the
road so each quarter of the valley has flowers visible from the path.
Per-instance yellow / white / purple tints in Vegetation._write() —
the brief's "mix yellow, white and purple flowers" is now visible at
the meadow scale, with a deterministic 3-choice palette per tuft so the
mix is stable across rebuilds and reads as a real wildflower meadow.

*Cabins.* 7B cabins were 70-150 m off the road bed — too far to
discover by riding past. 7C places all 3 within 15 m of Whisper Path,
doors facing the road: cabin 1 at (1900, 2645) ~15 m S of the road W
of spawn, cabin 2 at (2400, 2645) — one of the spawn-discovery
candidates per the brief (cabin 2 is ~250 m E of spawn), cabin 3 at
(2880, 2585) ~15 m S of the road at the E end. Each cabin keeps its
fenced yard + woodpile behind + bench + campfire + signpost in front
(unchanged from 7B — all SOLID). Spawn-visibility: cabin 2 is one of
the spawn-discovery candidates within the first 300 m.

*Rocks & logs.* 7B boulders had a 4-quadrant generator that made all 30
cluster around four anchor points (visibly quadrantal). 7C replaces that
with a hash-distributed scatter across the entire valley floor, skipping
points within 15 m of any forest centre so the player can always see
them. Up to 30 boulders plus 24 hill-base clusters = 54 total (within
the 50-70 spec). Logs went to a similar hash-distribution with
floor-wide coverage (no more clusters at specific (x, z) anchors).

*Constraints honoured.* Terrain unchanged, roads unchanged, lake
unchanged, bike physics / camera / UI / streaming / save / quality /
other regions all bit-identical to the prior commit. Only Landforms.js
forests / meadows / cabins / boulders / logs ARE recomputed; the terrain
carve / hill chains / Whisper Path road / locked systems were not
touched.

Build once. Test once. Commit message: **Whisper Valley ecosystem fix**.

**Chapter 7B.5 — Streaming performance hotfix.** The big hitch was a
multi-cell jump (`jump > 1` path in `Vegetation.update()`) firing
`_rebuild(..., Infinity)`, instantly placing hundreds of plants and
breaking the 2 ms streaming budget. 7B.5 converts even teleport
jumps to the amortised 2 ms per-frame slice. The cell cache is now
**permanent** (no LRU eviction -- rendered window + +1 ring is only
~30 cells, so a hash-hit is a no-op rather than a re-build). Cell
generation is amortised across frames via `_advanceCell` + the
2 ms `CELL_BUDGET_MS` cap. Draw calls unchanged (~45) and well under
the 110 budget. New F3 fields: **STREAM ACT** (active sectors /
generated this frame), **CACHED** (cells cached permanently),
**STREAM GEN** (frame generation time ms vs budget). The previous
build already amortised generation per-frame; this commit tightens the
teleport path, makes the cell cache permanent, adds the F3 counters,
and confirms no allocation during writes (everything reuses the
pre-allocated scratch objects in the class). Build once, test once
(615 kB bundle, no errors). Locked systems byte-identical.

## Tests

```bash
bash tests/setup-browser.sh   # once per machine: headless-Chromium toolkit (to /tmp)
npm run test:e2e              # full foundation verification against the dev server
```

Made by Sworup Karki
