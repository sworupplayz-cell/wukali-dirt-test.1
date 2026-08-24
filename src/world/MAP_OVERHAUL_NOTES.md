# Wukali Map Overhaul

This file marks the controlled map-polish branch based on `backup/v1-stable-before-engine-rewrite`.

Goals:
- improve map-wide visual variety without replacing the terrain engine;
- preserve deterministic terrain, collision, and streaming behavior;
- improve biome separation, scenic composition, route readability, and environmental dressing;
- keep mobile performance bounded through existing instancing/LOD systems;
- validate changes before touching the stable backup branch.

The first pass is intentionally additive and reversible.
