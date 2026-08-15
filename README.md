# Horizon Ride

A lightweight, Android-first, 3D off-road dirt-bike game.

**Current status: Phase 1B — Fixed world streaming engine.** The game now
runs on a PERMANENT, FINITE world: 10,000 m x 5,000 m (50 km^2) divided into
200 fixed 500 m sectors (20 columns x 10 rows). A 3x3 sector window streams
around the bike with pooled meshes — no loading screens, no infinite
coordinates. Sectors are flat placeholder planes with per-sector debug tints
(terrain content arrives in later phases). A developer overlay (F3 / DBG
button) shows FPS, position, current sector, loaded sectors and draw calls.

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

World (Phase 1B streaming engine):

- `src/world/SectorWorld.js` — the fixed world: permanent 20x10 sector grid
  (500 m sectors, IDs (0,0)..(19,9)), 3x3 streaming window, pooled flat
  sector planes with deterministic debug tints, sky/fog/sun. Implements the
  sampling interface the bike consumes — `{ getHeight, getNormal,
  getColliders, getSurface, getRenderedPlane, getSpawn, isInBounds, update }`.
  Spawn is the exact world center (5000, 2500). Riding off the world edge
  triggers the bike's existing safe-spot reset (no invisible walls).
- `src/world/streaming/ChunkGrid.js` — sector window bookkeeping with
  enter/leave deltas (drives the 3x3 streaming).
- `src/world/streaming/ObjectPool.js` — fixed-capacity mesh pool
  (sector load/unload never allocates).

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
  player X/Z, current sector, loaded sectors, draw calls.

## Tests

```bash
bash tests/setup-browser.sh   # once per machine: headless-Chromium toolkit (to /tmp)
npm run test:e2e              # full foundation verification against the dev server
```

Made by Sworup Karki
