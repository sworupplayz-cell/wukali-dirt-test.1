# Horizon Ride

A lightweight, Android-first, 3D off-road dirt-bike game.

**Current status: Phase 2 — Seamless terrain foundation.** The fixed
10,000 m x 5,000 m world (200 permanent 500 m sectors, 3x3 streaming window)
now carries one seamless sculpted terrain: gentle hills, rolling valleys,
soft ridge lines, wide plains, small natural bumps, dirt trail kickers and a
deterministic dirt-trail network that follows the land. Height is a pure
analytic function of world coordinates, so sector/tile borders are
bit-identical — zero seams by construction — and physics never waits for a
mesh. Bike feel was tuned for the rolling terrain (suspension, landing
absorption, brake bite, steering attack). The F3 overlay adds terrain
height, player altitude and slope.

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

World (Phase 2 terrain foundation on the Phase 1B streaming engine):

- `src/world/TerrainField.js` — the analytic ground truth: height, trail
  mask and moisture as pure deterministic functions of world (x, z).
  Plains/valleys, gentle hills, region-masked ridge lines, natural bumps,
  sharp-crested dirt kickers on trails, smooth whoops in the open, and a
  wandering NS/EW dirt-trail network worn 0.2 m into the ground.
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
