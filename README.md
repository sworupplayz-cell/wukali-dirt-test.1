# Wukali Dirt

A lightweight, Android-first, 3D endless off-road dirt-bike game.

**Current status: Phase 3B** — rare, named, climbable **mountain destinations**:
analytic dome peaks (~55–90 m) on a sparse 1.2 km cell grid with spiral dirt
roads (cross-slope-cancelled, switchback feel), pine bands low / rock high /
snow caps on tall peaks, prayer flags + chorten at the summit, far-LOD impostor
domes so peaks are discoverable from kilometres away, summit detection with
one-time persistent achievements (per-mountain + First Summit / Mountain Rider /
King of the Mountains), and fictional Nepali-inspired names assigned by seed.

Phase 3A added core riding gameplay: run distance with persistent best,
real-time speed, a stunt system (air time / height / distance / whip detection,
combo multiplier, partial credit for crashed landings), a game-over screen with
run stats, and an exposed `run.difficulty` value (0→1 over 4 km).

Phase 2 delivered the **endless, seeded, Nepal-inspired procedural world**: green
mid-hills, pine foothill forests, terraced rural farmland, rocky hills and
snow-line high mountains, with dirt trails, streams, wooden bridges, natural jump
mounds and rare built kicker ramps, all streamed as 64 m chunks around the bike.

## Tech

- [Three.js](https://threejs.org/) for rendering (only runtime dependency)
- Custom arcade heightfield physics (no physics engine — stable and cheap on low-end phones)
- Plain DOM/CSS for all UI (menu, pause, crash, touch HUD) — zero GPU cost, crisp at any DPI
- Vite for dev/build
- Runs in any Android browser; ready to be wrapped as an APK later (Capacitor / TWA)

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
| Reset bike  | ↺ (top right)        | R                 |
| Pause       | ⏸ (top right)        | Esc or P          |

## Architecture

World (endless, Phase 2):

- `src/world/TerrainGenerator.js` — pure analytic terrain: height, biomes, trails,
  streams, terraces and jump features are all functions of `(x, z, seed)`. Chunk
  meshes only sample it, so edges always match and physics never waits for meshes.
- `src/world/ChunkManager.js` — 25 active 64 m chunks (3x3 at 2 m resolution,
  outer ring at 4 m with seam-hiding skirts), pooled meshes rebuilt in ~1 ms,
  nearest-first build queue (1–2 per frame), per-chunk deterministic prop scatter,
  colliders only from the player's 3x3 neighborhood.
- `src/world/InstancedPool.js` — one InstancedMesh per prop type (12 types); chunk
  load/unload only rewrites instance matrices — no object creation while riding.
- `src/world/props.js` — merged vertex-colored low-poly props: pines, broadleaf
  trees, bushes, rocks, logs, haystacks, rural houses, stone walls, prayer-flag
  poles, stupas, bridge decks, curved wooden ramp decks.
- `src/world/Mountains.js` — one unlit draw call of distant Himalayan silhouettes,
  re-centered on the player (never reachable, no collision).
- `src/world/MountainImpostors.js` — pooled far-LOD domes at true mountain
  positions (fog-exempt, haze-tinted); real chunks occlude them up close.
- `src/world/WorldManager.js` — facade implementing the Phase 1 world interface
  `{ getHeight, getNormal, getColliders, getSpawn, isInBounds }` + `update(pos)`,
  plus mountain lookups (`summitAt`, `nearestMountain`, `roadPoint`).
- `src/world/noise.js` — seeded hashing / value noise / fBM / PRNG.

Game (Phase 1 core + Phase 3A gameplay):

- `src/core/RunStats.js` — run distance (teleport-guarded), persistent best, difficulty value.
- `src/core/StuntTracker.js` — jump detection/scoring/combo from existing bike state (no physics changes).
- `src/core/Achievements.js` — local achievement manager (summits + count-based meta), UI-agnostic.
- `src/bike/Bike.js` — arcade physics (ground/air states, suspension, crash detection, safe-spot reset).
- `src/bike/BikeModel.js` — low-poly bike built from primitives, blob shadow (no shadow maps).
- `src/core/Game.js` — state machine (menu/playing/paused/crashed) + fixed-timestep loop.
- `src/core/Input.js` — single input abstraction for keyboard + touch.
- `src/core/FollowCamera.js` — smoothed third-person chase camera with terrain clearance.
- `src/core/GameAudio.js` — synthesized engine + optional music loop (no audio assets).
- `src/ui/UI.js` — wires the DOM overlays to the game.

The bike only talks to the world through the sampling interface; the world manager
tracks the player's chunk itself. `?seed=N` in the URL selects a different world.

## Tests

```bash
bash tests/setup-browser.sh   # once per machine: headless-Chromium toolkit (to /tmp)
npm run test:e2e              # full gameplay verification against the dev server
```

Made by Sworup Karki
