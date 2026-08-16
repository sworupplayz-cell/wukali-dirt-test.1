# Horizon Ride

A lightweight, Android-first, 3D off-road dirt-bike game.

**Current status: Chapter 3B — Art & performance pass.** The world is now
stylized low-poly hand-painted: a procedural 512x512 shared ground atlas
(grass/dirt/rock/gravel/snow/mud painted-daub cells) plus a 256px seamless
neutral detail map world-tiled over the terrain and multiplied with the
vertex-color palette — brushwork without breaking LOD color matching. Road
wear is painted into the palette: worn tire paths, center crown, gravel
shoulders, scattered stones, plus a few cm of wheel-rut/washboard height
character. Five reusable instanced rock models (cluster, boulder, slab,
spire, scree) replace the single rock. NEW: the vegetation system — 10
plant types (pine, fir, birch, small oak, dead tree, bush, fern, grass
patch, flowers, shrub) as one InstancedMesh per type with a far impostor
LOD ring (near 5x5 cells full models, far 9x9 cone impostors, ground cover
distance-culled), deterministic per-cell placement off roads/meadow/lake,
species by altitude & moisture. Lighting: warm afternoon sun + cool blue
ambient + cool counter-fill, vertical sky gradient texture, FogExp2 tinted
to the horizon band. F3 adds TREES (visible/near). All physics, roads,
terrain shape, streaming, camera, controls and UI untouched.

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
