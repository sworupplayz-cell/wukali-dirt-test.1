# Horizon Ride

A lightweight, Android-first, 3D off-road dirt-bike game.

**Current status: Phase 1A — Project reset.** The experimental
Wukali-Dirt endless-world prototype has been cleaned down to its permanent
foundation: the bike, its physics, the cameras, the controls, the menus and
the rendering pipeline — riding in a tiny static test scene. All procedural
world generation (terrain, biomes, villages, towns, cities, industry, NPCs,
traffic, trials, discoveries) has been removed. Future Horizon Ride phases
build on this foundation.

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

Steering modes (Settings): buttons, virtual handlebar, tilt, swipe.

## Architecture

World (Phase 1A test scene):

- `src/world/TestWorld.js` — the entire world: an analytic heightfield
  (flat ground + one ramp wedge) implementing the sampling interface the bike
  consumes — `{ getHeight, getNormal, getColliders, getSurface,
  getRenderedPlane, getSpawn, isInBounds, update }` — plus a dirt test road,
  sky, fog and one sun light. No generation, no per-frame work.
- `src/world/streaming/ObjectPool.js` — neutral fixed-capacity object pool
  (retained streaming architecture; dormant until future phases use it).
- `src/world/streaming/ChunkGrid.js` — neutral sector/chunk bookkeeping with
  enter/leave deltas (retained streaming architecture; dormant).

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

## Tests

```bash
bash tests/setup-browser.sh   # once per machine: headless-Chromium toolkit (to /tmp)
npm run test:e2e              # full foundation verification against the dev server
```

Made by Sworup Karki
