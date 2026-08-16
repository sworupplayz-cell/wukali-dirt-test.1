# Horizon Ride

A lightweight, Android-first, 3D off-road dirt-bike game.

**Current status: Chapter 5A — Terrain generation rework.** The world has grown
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
past its grade limit. Two placement bugs surfaced and were fixed on the
way: roadside fences could stand across a curving bed (a 6 m solid run
offset only by the half-width) and a viewpoint platform could land on the
road — both now verify clearance before placing. Road beds are relaxed onto the ground under a fill cap instead of
being propped on 500 m pedestals, and the Eagle Approach serpentine was
re-laid onto the rebuilt flank with its summit pinned to the pass saddle,
so the marquee climb is a genuine 1.5 km switchback ascent again.

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
