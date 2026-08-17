import { vnoise, sstep } from './noise.js';

/**
 * Landforms — Phase 3 WORLD REDESIGN (roads-first).
 *
 * The old mountain height algorithm is GONE. This is a new world plan for
 * the reduced 8,000 x 4,000 m map (128 permanent sectors), built in the
 * order gameplay demands:
 *
 *   1. MAIN DIRT ROADS   — authored first: the Horizon Loop (a 7 m road
 *                          circling the whole map) + four arms meeting in
 *                          a 4-way intersection at Rider's Meadow.
 *   2. VALLEYS           — the road corridors ARE the valleys: a corridor
 *                          mask suppresses all later landforms near every
 *                          main road, so roads always sit in wide, gentle
 *                          valley floors (100-350 m elevation band).
 *   3. ROLLING HILLS     — soft fabric between the corridors.
 *   4. MOUNTAIN RANGES   — scenery, added LAST in height composition and
 *                          only where the corridor mask allows: 4 connected
 *                          perimeter ranges (16 named peaks, highest
 *                          Kanjiro Peak ~2200 m) built from a new
 *                          spine-profile algorithm (cos^2 crest + wide
 *                          quartic skirt, domain-warped flanks).
 *   5. MOUNTAIN PASSES   — 6 switchback pass roads (5 m) laid by the
 *                          contour-aware walker over range saddles.
 *   6. HIDDEN TRAILS     — the lowland trail grid (2.5 m, in TerrainField)
 *                          plus scenic viewpoints computed ON the roads.
 *
 * RIDER'S MEADOW — handcrafted spawn area at the world center (4000,2000):
 * flat grass meadow (r 600), small lake, gentle undulation, the 4-way
 * intersection, signpost, abandoned cabin, one practice jump, and the
 * Northwall range as backdrop. No cliffs, no steep ground.
 *
 * Everything is a deterministic pure function of (x, z); roads are laid
 * once at startup into a spatial hash and blended into every sample.
 */

export const WORLD_W = 8000;
export const WORLD_H = 5000; // Chapter 4: 40 km^2
export const MEADOW = { x: 4000, z: 2500, r: 600, e: 66 }; // world center
export const LAKE = { x: 4230, z: 2710, r: 90, depth: 6 };
export const LAKES = [
  LAKE,
  { x: 3620, z: 3620, r: 140, depth: 7 },
  { x: 4780, z: 3880, r: 110, depth: 6 },
  // Chapter 5A CRYSTAL LAKES: still, clear water in sheltered ground —
  // one on the floor of Sundown Basin, one in the quiet flats under the
  // Glacier Wall. Both sit well clear of every road bed, so no road
  // apron can cut their shoreline open.
  { x: 2350, z: 2790, r: 172, depth: 12, level: 68, name: 'Mirror Lake', crystal: true },
  { x: 4830, z: 1060, r: 112, depth: 11, level: 76, name: 'Azure Tarn', crystal: true },
];
export const SEA_LEVEL = 42; // Chapter 4: the southern ocean

const S = 733;

// ---- Chapter 5A: authored macro-landforms ---------------------------------
// The Chapter 6 field gives the world its erosion grain (ridge lines,
// dendritic valleys, basins-by-noise). This layer puts NAMED landforms on
// top of it so the map has structure you can navigate by, instead of an
// evenly interesting texture. Everything here is a smooth analytic blob
// (quartic falloff / smoothstep rims), so nothing it adds can make a
// vertical wall, and every feature is corridor-aware so roads stay
// rideable through them.

// 4 RIDGE SYSTEMS — elongated chains, never isolated domes. Each spine is
// a polyline; the crest undulates along its length and drops to saddles
// between the named high points, which is what makes a ridge read as a
// range rather than a wall.
// Chapter 6A: SIX ridgelines, not four, and each one runs the length of
// the country it divides instead of sitting in the middle of it. Two
// things changed besides the count. The spines carry more points, so a
// crest meanders over 2-4 km and reads as continuous from any viewpoint
// on it. And every flank is WIDER for the same height: with the quartic
// profile the steepest gradient is h * 1.54 / w, so the old 50 m over
// 250 m stood at 17.1 deg — over the 16 deg rideable ceiling — while
// 52 m over 340 m stands at 13.2 deg and can be ridden straight up.
//
// `bench` adds a terrace on the outer flank: a short escarpment placed
// where the quartic profile has already gone slack, so the shelf reads
// as a small cliff line along the ridge without the two gradients
// stacking into something unrideable (see ridgeSystems).
const RIDGE_SYSTEMS = [
  { name: 'Sentinel Ridge', h: 52, w: 340, wave: 0.34, bench: 4,
    pts: [[1180, 2120], [1760, 2020], [2340, 2060], [2900, 2170], [3380, 2250]] },
  { name: 'Larkspur Ridge', h: 46, w: 320, wave: 0.40, bench: 4,
    pts: [[1300, 3120], [1900, 3210], [2500, 3160], [3060, 3040], [3520, 2960]] },
  { name: 'Ember Ridge', h: 50, w: 335, wave: 0.36, bench: 4,
    pts: [[4720, 2980], [5320, 3110], [5900, 3120], [6420, 3000], [6860, 2860]] },
  { name: 'Vanguard Ridge', h: 54, w: 345, wave: 0.32, bench: 4,
    pts: [[4760, 2010], [5360, 1900], [5960, 1900], [6480, 2010], [6900, 2140]] },
  // Chapter 6A additions: a northern chain closing the top of the
  // interior, and a southern one standing between the basins and the
  // coastal plain, so the lowland is divided into rooms on both axes.
  //
  // Halcyon sits in the north-east interior rather than north-centre.
  // The centre-north strip (x 2450-4050, z 1250-1560) is the only line
  // the world has to keep rideable cross-country, and a 42 m ridge laid
  // across it raised the ground 12 m and put a sustained 18-20 deg flank
  // where there had been 2 samples over 16. It also has to clear
  // Vanguard's north skirt (reach z 1555) and stop short of the
  // Emberflow trunk so the valley is not silled.
  { name: 'Halcyon Ridge', h: 42, w: 290, wave: 0.38, bench: 4,
    pts: [[4350, 1190], [4670, 1120], [4990, 1145], [5300, 1215]] },
  { name: 'Sable Ridge', h: 42, w: 305, wave: 0.42, bench: 4,
    pts: [[3960, 3660], [4560, 3760], [5180, 3720], [5740, 3600], [6260, 3480]] },
];

// ---- Chapter 6A: 4 LARGE VALLEY SYSTEMS ------------------------------------
// The drainage used to be pure ridged noise — statistically valley-like,
// but with no trunk a rider could follow and no reason for any two parts
// of the map to relate. These are authored trunks: broad, shallow,
// continuous, and connected. Three run north to south down the tilt of
// the continent and the fourth gathers them along the coastal plain, so
// water (and a rider) can run from the northern foothills to the sea
// without ever climbing out of a valley.
//
// They are deliberately WIDE and SHALLOW: 26 m over a 360 m half-width
// is a 6.4 deg maximum wall. A valley you can see across and ride out of
// in any direction is what makes the map feel like one connected
// landscape; a ravine would just be a wall with a floor.
const VALLEY_SYSTEMS = [
  { name: 'Fernwater Valley', d: 26, w: 380, flat: 0.34,
    pts: [[1230, 880], [1160, 1620], [1290, 2360], [1230, 3080], [1380, 3820], [1520, 4260]] },
  { name: 'Kingsmere Valley', d: 24, w: 360, flat: 0.32,
    pts: [[3480, 900], [3420, 1580], [3540, 2260], [3460, 2960], [3580, 3640], [3700, 4220]] },
  { name: 'Emberflow Valley', d: 25, w: 370, flat: 0.33,
    pts: [[5880, 980], [5980, 1660], [5840, 2340], [5960, 3020], [6120, 3700], [6240, 4240]] },
  // The collector: an east-west trunk across the southern plain that
  // every other valley drains into before the coast.
  { name: 'Southmarch Valley', d: 22, w: 400, flat: 0.36,
    pts: [[1400, 4120], [2600, 4200], [3800, 4180], [5000, 4160], [6200, 4120], [7150, 4020]] },
];

// 3 LARGE BASINS — wide, shallow, flat-floored bowls. They are the
// counterweight to the ridges: open ground you can see across, and the
// reason the lowland reads as a landscape with rooms in it.
const BASINS = [
  { name: 'Sundown Basin', x: 2350, z: 2690, r: 640, depth: 26, flat: 0.55 },
  { name: 'Kestrel Basin', x: 6150, z: 2700, r: 560, depth: 23, flat: 0.5 },
  { name: 'Willow Basin', x: 3300, z: 3760, r: 580, depth: 20, flat: 0.5 },
];

// PLATEAUS — flat tables lifted above the country on a rim that steepens
// to about 28 deg: a gentle cliff you ride along looking for the ramp,
// never a wall you cannot pass.
const PLATEAUS = [
  { name: 'Anvil Plateau', x: 1760, z: 1660, r: 330, rim: 105, h: 40 },
  { name: 'Copper Table', x: 6560, z: 3700, r: 290, rim: 95, h: 37 },
];

// 6 MAJOR VIEWPOINTS — authored, on the new landforms and within reach of
// a road. They are merged into the road-computed viewpoint list, so the
// prop system furnishes them exactly like the rest (lookout + flags).
const MAJOR_VIEWPOINTS = [
  { id: 'MV1', name: 'Sentinel Point', x: 3040, z: 2215 },
  { id: 'MV2', name: 'Larkspur Lookout', x: 3140, z: 2995 },
  { id: 'MV3', name: 'Ember Overlook', x: 5060, z: 3020 },
  { id: 'MV4', name: 'Vanguard Vista', x: 5110, z: 1975 },
  { id: 'MV5', name: 'Anvil Rim', x: 1880, z: 1665 },
  { id: 'MV6', name: 'Mirror Lake Overlook', x: 2352, z: 2565 },
];

// ---- Chapter 7A — Whisper Valley (REBUILD, not addition) -------------
// A continuous 2.2 km scenic valley that REPLACES the straight road
// slice of West Arm and BECOMES the spawn region. Handcrafted: two
// hill chains flanking a rolling floor, four forest masses around the
// spawn, one winding dirt road that the player can ride. NOTHING in
// the world is random — every placement is authored here.
export const WHISPER_VALLEY = {
  // Floor centerline (~2.2 km, gently curving). Spawn sits near the
  // middle at roughly (2150, 2610) so the rider sees the whole valley
  // when they look either direction along the road.
  spine: [
    [1300, 2540], [1520, 2570], [1800, 2600], [2150, 2610],
    [2450, 2630], [2750, 2610], [3030, 2570], [3300, 2530],
  ],
  // Floor dimensions: 200 m half-width = 400 m wide valley. Both
  // hill chains flank the floor without overlapping it enough to
  // create a wall — the player can ride the rim, not bounce off it.
  floorHalfWidth: 200,
  // Base trench depth — kept small (~2 m) because the BASIN under
  // Whisper Valley (Sundown Basin, centered at 2350, 2690 r=640)
  // already carved the wider floor to ~26 m below natural terrain.
  // We gently deepen its groove, then add rolling undulation on top.
  floorDepth: 2,
  // LEFT hills (north side of the valley). Cos² crest: gentle silhouette.
  leftHills: {
    spine: [
      [1280, 2360], [1500, 2400], [1800, 2450], [2150, 2500],
      [2450, 2540], [2750, 2530], [3030, 2470], [3300, 2420],
    ],
    height: 55,        // 45-70 m spec, mid-range
    halfWidth: 130,
    steepness: 1.0,    // cos² (gentle)
  },
  // RIGHT hills (south side). Cos^2.6 crest: slightly steeper flank,
  // peak narrower at the top — matches the spec's "slightly steeper
  // than left". Both hills span the full valley length without a gap.
  rightHills: {
    spine: [
      [1290, 2760], [1510, 2800], [1800, 2840], [2150, 2880],
      [2450, 2910], [2750, 2890], [3030, 2840], [3300, 2790],
    ],
    height: 65,        // 45-80 m spec, slightly higher than the left
    halfWidth: 130,
    steepness: 1.6,    // cos^2.6 → flank drops faster
  },
};

// Spawn axis-aligned bbox (rough). Used by Vegetation / Props to gate
// "inside Whisper Valley" checks. Loose bounds so the hills and road
// are inside, the foreground forest edges are inside, and the surrounding
// lowland is outside.
export const WHISPER_BBOX = { x0: 1100, x1: 3400, z0: 2280, z1: 2960 };

// ---- Chapter 7B: Whisper Valley living environment ----------------
// FORESTS. 9 masses total = 4 dense pines + 3 oak groves + 2 birch
// groves, scattered across the valley so the rider is always surrounded
// by woods. Each forest is r=80-110 m (160-220 m diameter -- within
// spec). Strength > 1.65 so these zones DOMINATE the cell ecosystem.
// ---- Chapter 7C: Whisper Valley ecosystem fix --------------------
// FORESTS. EXACTLY 8 patches distributed evenly across the 2.2 km
// valley so the rider sees wood in every compass bearing. Strength
// 1.70-1.95 so they DOMINATE the cell ecosystem in WV. Sizes
// r=70-90 m (140-180 m diameter) match the 80-180 m spec. Kinds alternate
// pine / oak / birch along the valley.
//
// Valley spans x = 1300..3300 (2000 m). 8 patches -> ~250 m spacing.
// z alternates N (smaller z) and S (larger z) of the road so a given
// compass always sees wood on at least one side.
export const WHISPER_FORESTS = [
  // W - W entrance woodland (mostly pine, dense centre).
  { x: 1430, z: 2470, r: 80, kind: 'pine',  strength: 1.85 },
  { x: 1680, z: 2710, r: 75, kind: 'birch', strength: 1.75 },
  // W-mid
  { x: 1930, z: 2470, r: 80, kind: 'pine',  strength: 1.85 },
  { x: 2180, z: 2710, r: 85, kind: 'oak',   strength: 1.90 },  // central oak
  // E-mid
  { x: 2430, z: 2470, r: 80, kind: 'pine',  strength: 1.80 },
  { x: 2680, z: 2710, r: 75, kind: 'oak',   strength: 1.85 },
  // E - E entrance woodland
  { x: 2930, z: 2470, r: 70, kind: 'birch', strength: 1.70 },
  { x: 3180, z: 2710, r: 80, kind: 'pine',  strength: 1.85 },
];

// 8 VISIBLE WILDFLOWER MEADOWS alternating N and S of the road so the
// rider sees them in every quarter of the valley. Each is 60-80 m wide
// and 8-12 m off the road bed (Props.sectorProps() filters anything too
// close to the road so the riding path stays clear). 'flower' kind
// drives dense wildflower drift; per-instance yellow/white/purple
// tints in Vegetation._write() give each meadow the visible colour
// mix the brief asks for.
export const WHISPER_MEADOWS = [
  { x: 1555, z: 2490, r: 70 },  // W entry - N side
  { x: 1700, z: 2725, r: 65 },  // W - S side
  { x: 1950, z: 2490, r: 75 },  // W-mid - N (within 300 m of spawn)
  { x: 2090, z: 2735, r: 65 },  // W-mid - S
  { x: 2450, z: 2730, r: 65 },  // E-mid - S
  { x: 2700, z: 2490, r: 70 },  // E-mid - N
  { x: 2950, z: 2720, r: 65 },  // E - S
  { x: 3220, z: 2480, r: 75 },  // E entry - N side
];

// Small forest CLEARINGS -- interior open spots inside the densest pine
// forests (every third zone gets a 18-30 m clearing so the woods read as
// travelled rather than uniform). Cleared areas pick low-density sward.
export const WHISPER_CLEARINGS = (() => {
  const a = [];
  for (let i = 0; i < WHISPER_FORESTS.length; i++) {
    if (i % 3 !== 0) continue;
    const f = WHISPER_FORESTS[i];
    a.push({
      x: f.x + (((i * 41) % 60) - 30),
      z: f.z + (((i * 67) % 60) - 30),
      r: 18 + ((i * 13) % 12),
    });
  }
  return a;
})();

// Tall-grass RINGS around each forest mass -- small zones that override
// the meadow-cell ecosystem to clover / grassTall instead of bare floor.
export const WHISPER_FOREST_EDGE_GRASS = (() => {
  const a = [];
  for (let i = 0; i < WHISPER_FORESTS.length; i++) {
    const f = WHISPER_FORESTS[i];
    for (let k = 0; k < 4; k++) {
      const ang = (k * 1.57) + 0.4;
      a.push({
        x: f.x + Math.cos(ang) * (f.r + 22),
        z: f.z + Math.sin(ang) * (f.r + 22),
        r: 26,
      });
    }
  }
  return a;
})();

// 3 handcrafted CABINS, each beside Whisper Path and within 15 m of the
// road bed so riders see + discover them on the first pass. cabin.yaw is
// the door / yard direction (facing TOWARD the road, so the rider sees
// the door + campfire + bench when they pass). roadYaw is the direction
// from cabin to road (used by Props to place the signpost on the road
// approach). Props.fence+woodpile go BEHIND the cabin (away from the
// road), so the yard opens toward the player.
export const WHISPER_CABINS = [
  // Cabin 1 (W entry) - road at ~z 2630 here, cabin 15 m S at 2645.
  { x: 1900, yaw: Math.PI, roadYaw: Math.PI },
  // Cabin 2 (centre) - one of the spawn-discovery candidates.
  { x: 2400, yaw: Math.PI, roadYaw: Math.PI },
  // Cabin 3 (E entry) - road at ~z 2570 here, cabin 15 m S at 2585.
  { x: 2880, yaw: Math.PI, roadYaw: Math.PI },
];

// 52 BOULDERS -- distributed naturally across the valley floor via a
// hash-distributed pseudo-random sequence (so they don't form visible
// 4-quadrant clusters like the previous layout did). Each is skipped
// when within 15 m of any WV forest centre, so stones never land inside
// the dense woods where the player can never see them. Combined with
// the 24 hill-base clusters from 7A, total WV boulders = 24 + 30..52
// (target ~50-70 per spec). Each uses the existing 'boulder' prop /
// coll:2.2 / collider. Props.sectorProps() filters road-bed collisions too.
export const WHISPER_BOULDERS = (() => {
  const a = [];
  let i = 0;
  for (let tries = 0; tries < 200 && a.length < 30; tries++, i++) {
    const hx = 1340 + ((i * 167 + 91) % 1920);
    const hz = 2340 + ((i * 211 + 67) % 530);
    let ok = true;
    for (let j = 0; j < WHISPER_FORESTS.length; j++) {
      const f = WHISPER_FORESTS[j];
      const dx = hx - f.x, dz = hz - f.z;
      if (Math.sqrt(dx * dx + dz * dz) < f.r + 15) { ok = false; break; }
    }
    if (!ok) continue;
    a.push({
      x: hx, z: hz,
      seed: ((i * 17 + 11) % 100) / 100,
      s: 0.55 + ((i * 23) % 60) / 200,
    });
  }
  return a;
})();

// 32 fallen LOGS — distributed naturally across the whole valley
// (not clustered around specific forest/road anchor points like before).
// Hash-distributed positions + a 0.85-1.30 scale band so they read as
// scattered debris across the floor and meadow edges. Skips points inside
// forest cores where the player can't see a log.
export const WHISPER_LOGS = (() => {
  const a = [];
  let i = 0;
  for (let tries = 0; tries < 220 && a.length < 32; tries++, i++) {
    const hx = 1340 + ((i * 131 + 47) % 1920);
    const hz = 2340 + ((i * 199 + 73) % 530);
    let skip = false;
    for (let j = 0; j < WHISPER_FORESTS.length; j++) {
      const f = WHISPER_FORESTS[j];
      if (Math.hypot(hx - f.x, hz - f.z) < f.r + 10) { skip = true; break; }
    }
    if (skip) continue;
    a.push({
      x: hx, z: hz,
      yaw: ((i * 1.91 + 0.31) * 6.28 % (2 * Math.PI)),
      s: 0.85 + ((i * 7) % 30) / 70,
    });
  }
  return a;
})();

// 20 TREE STUMPS — small sawn woody discs scattered through clearings
// and at the entrance to each forest mass (30 are 50-70 spec apex,
// these are additional hand-placed props).
export const WHISPER_STUMPS = (() => {
  const a = [];
  const pts = [
    [1620, 2470], [1670, 2700], [1810, 2620], [1960, 2570], [2130, 2640],
    [2270, 2470], [2440, 2700], [2580, 2530], [2730, 2630], [2870, 2560],
    [1970, 2400], [2230, 2790], [2540, 2400], [2900, 2700], [3100, 2520],
    [1880, 2680], [2380, 2680], [2620, 2460], [2800, 2400], [3200, 2600],
  ];
  for (let i = 0; i < pts.length; i++) {
    a.push({
      x: pts[i][0] + ((i * 19) % 7) - 3,
      z: pts[i][1] + ((i * 23) % 7) - 3,
    });
  }
  return a;
})();

// Six boulder CLUSTERS where the two hill chains meet the valley
// floor. One primary boulder + 3 companions each = 24 boulders total,
// reusing the existing 'boulder' InstancedMesh / material / collider.
export const WHISPER_ROCKS = [
  { x: 1700, z: 2400, seed: 0.21 },  // left (north) base, west
  { x: 2150, z: 2480, seed: 0.55 },  // left base, centre
  { x: 2600, z: 2410, seed: 0.82 },  // left base, east (NE corner)
  { x: 1700, z: 2780, seed: 0.33 },  // right (south) base, west
  { x: 2150, z: 2780, seed: 0.66 },  // right base, centre
  { x: 2600, z: 2780, seed: 0.91 },  // right base, east (SE corner)
];

// ---- 4. Mountain ranges (scenery): spine nodes [x, z, H, W, name] ----------
// Phase 3.1 redistribution — the spawn bowl is gone:
//   N  : Northwall (major range, pushed to the top edge)
//   NE : Kanjiro Massif (the highest peaks, 2000-2200 m)
//   E  : Eastguard (moderate, carries the mountain passes; the Horizon
//        Loop squeezes between its walls = the canyon region)
//   S  : open grasslands & lakes (NO range)
//   SW : rolling hills only (no range)
//   W  : wide valleys (no range)
// Everything serious sits 2+ km of riding from Rider's Meadow; an open
// spawn basin mask additionally suppresses any massif within ~1.8 km.
const RANGES = [
  {
    id: 'N', name: 'Glacier Wall',
    nodes: [
      [900, 210, 1020, 576, 'Vetra Peak'],
      [2100, 380, 1150, 980, 'Mistral Horn'],
      [3300, 760, 1240, 900, 'Sorren Dome'],
      [4400, 200, 1060, 450, 'Thornspire'],
      [5300, 180, 820, 378, 'Weisshorn'],
    ],
    dips: [0.56, 0.42, 0.46, 0.42],
  },
  {
    id: 'K', name: 'Kanjiro Massif',
    nodes: [
      [6300, 330, 1020, 414, 'Vel Morra'],
      [7250, 480, 2080, 576, 'Kanjiro Peak'],
      [7820, 1100, 900, 378, 'Eastwatch'],
    ],
    dips: [0.28, 0.30],
  },
  {
    id: 'V', name: 'Volcanic Highlands',
    nodes: [
      [7930, 2100, 820, 360, 'Cinder Ridge'],
      [7960, 2850, 1120, 414, 'Mount Ember'],
      [7930, 3600, 800, 342, 'Ash Spire'],
    ],
    dips: [0.33, 0.33],
  },
  {
    id: 'R', name: 'Redwall',
    nodes: [
      [180, 1700, 700, 315, 'Redwall North'],
      [140, 2500, 900, 360, 'Redwall Point'],
      [180, 3300, 740, 324, 'Redwall South'],
    ],
    dips: [0.33, 0.33],
  },
];

// Profile: cos^2 crest (45% of height, width W) on a quartic skirt
// (55%). Chapter 6: the skirt width drops from 2.6 W to 1.55 W. The old
// wide skirt is what pushed the WHOLE interior up to 150-350 m — a
// 1,890 m peak still added ~750 m of ground a kilometre away. Peak
// heights and near-crest slopes are unchanged (the two terms still sum
// to H at the summit); only the far tail is cut, so the ranges read as
// mountains standing at the border instead of a continent-wide dome.
const CREST_F = 0.45, SKIRT_F = 0.55, SKIRT_W = 1.25;
// Border confinement: massifs are full strength within MTN_EDGE0 of a
// map edge and gone by MTN_EDGE1. Every authored spine sits inside
// MTN_EDGE0, so no peak loses height — this only forbids inland tails.
const MTN_EDGE0 = 620, MTN_EDGE1 = 1120;
// Red Canyon (west): axis, floor and the width over which the trench
// blends back into the natural ground.
const CANYON_X = 690, CANYON_FLOOR = 56;
const CANYON_HALF = 210, CANYON_FADE = 470;

// ---- 1. Main roads (authored FIRST — gameplay skeleton) --------------------
// Chapter 3A: every road is a named, handcrafted spline. The Meadow Loop
// ring passes EXACTLY through the four arm lines (its cardinal control
// points sit on them), so the crossings become natural junctions.
const MAIN_ROUTES = [
  { name: 'Horizon Loop', pts: [
    [1000, 1700], [2200, 1550], [4000, 1480], [5800, 1550], [7000, 1700],
    [7150, 2500], [7000, 3300], [5800, 3450], [4000, 3520], [2200, 3450],
    [1000, 3300], [850, 2500], [1000, 1700]] },
  { name: 'North Arm', calm: true, pts: [[4000, 1480], [4000, 2000], [4000, 2500]] },
  { name: 'South Arm', calm: true, pts: [[4000, 2500], [4000, 3000], [4000, 3520]] },
  // Chapter 7A: West Arm is SPLIT around Whisper Valley. The straight
  // slice that used to cross the WV floor (x=1100 to 3300 at z=2500)
  // is replaced by the winding Whisper Path (see NAMED_TRAILS). West
  // Arm still connects Rider's Meadow at (4000, 2500) westward to the
  // western world (850, 2500); it just stops at each WV entrance and
  // picks up at the WV exit. No dead end: Whisper Path inherits both
  // endpoints from West Arm at z=2500.
  { name: 'West Arm', calm: true, pts: [[850, 2500], [1100, 2500]] },
  { name: 'West Arm', calm: true, pts: [[3300, 2500], [4000, 2500]] },
  { name: 'East Arm', calm: true, pts: [[4000, 2500], [5600, 2500], [7150, 2500]] },
  { name: 'Meadow Loop', calm: true, pts: [
    [4000, 1680], [4410, 1790], [4710, 2090], [4820, 2500], [4710, 2910],
    [4410, 3210], [4000, 3320], [3590, 3210], [3290, 2910], [3180, 2500],
    [3290, 2090], [3590, 1790], [4000, 1680]] },
  // Chapter 4 scenic roads: Coastal Cliffs, Red Canyon, Volcanic Highlands.
  { name: 'Coastal Road', pts: [
    [1000, 3300], [1250, 3950], [2300, 4300], [4000, 4360],
    [5700, 4300], [6750, 3950], [7000, 3300]] },
  { name: 'Red Canyon Road', grade: 0.14, pts: [
    [850, 2500], [700, 2560], [630, 2720], [600, 2950],
    [620, 3250], [780, 3560], [1250, 3950]] },
  { name: 'Caldera Road', grade: 0.14, pts: [
    [7000, 1700], [7360, 2150], [7520, 2870], [7000, 3300]] },
  // Chapter 4: the marquee climb — a handcrafted serpentine from the
  // Glacier Route bench (232 m) up the Vetra/Mistral notch to the Eagle
  // Pass saddle (~1150 m): 8 authored switchback legs, grade-clamped.
  // Chapter 6: the serpentine was re-laid ONTO the rebuilt flank. It
  // traverses the foot at valley level, then switchbacks inside the
  // 560-1000 m band where the ground actually climbs, so the bed is a
  // cutting in the hillside instead of a viaduct over the meadow.
  { name: 'Eagle Approach', w: 3.4, grade: 0.16, wander: 0.2, corrStr: 0.88, corrW: 700, endSaddle: [0, 1], pts: [
    [2500, 1395], [2620, 1180], [2500, 1010], [2830, 950], [2500, 890],
    [2810, 830], [2520, 770], [2760, 710], [2600, 650], [2700, 570]] },
];

// Named singletrack routes laid AFTER the passes (they pin to them).
//   Glacier Route  — high-altitude crest traverse along the Northwall
//                    between the two pass saddles: long flowing corners,
//                    a viewpoint every few bends, ~1000 m elevation.
//   Canyon Trail   — narrow technical braid through the Eastguard canyon
//                    beside the East Arm; rock formations + Stone Arch.
//   Ridge Shortcut — hidden connector over the hill crest between the
//                    Meadow Loop NW and the Horizon Loop NW.
const NAMED_TRAILS = [
  // Scenic singletrack (counts toward the 6 scenic roads).
  { name: 'Glacier Route', w: 2.5, grade: 0.115, type: 1, wander: 0.5, pts: [
    [2420, 1400], [2800, 1355], [3200, 1330], [3600, 1300], [3950, 1280], [4250, 1300]] },
  // 12 hidden trails — every one ends at a landmark.
  { name: 'Canyon Trail', w: 1.25, grade: 0.175, type: 4, wander: 0.8, pts: [
    [6650, 2505], [6780, 2610], [6950, 2650], [7080, 2590], [7130, 2510]] },
  { name: 'Ridge Shortcut', w: 1.25, grade: 0.175, type: 4, wander: 1, pts: [
    [3590, 1790], [3350, 1710], [3100, 1650], [2850, 1580], [2600, 1530]] },
  { name: 'Lakeshore Trail', w: 1.25, grade: 0.14, type: 4, wander: 0.8, pts: [
    [4230, 2830], [3950, 3150], [3700, 3480]] },
  { name: 'Twin Lakes Link', w: 1.25, grade: 0.14, type: 4, wander: 0.8, pts: [
    [3700, 3700], [4220, 3820], [4700, 3830]] },
  { name: 'Beach Drop', w: 1.25, grade: 0.16, type: 4, wander: 0.4, pts: [
    [4000, 4390], [4200, 4470], [4010, 4560], [4210, 4650], [4110, 4700]] },
  { name: 'Cliff Edge Path', w: 1.25, grade: 0.16, type: 4, wander: 0.4, pts: [
    [2300, 4330], [2520, 4420], [2350, 4530], [2560, 4630], [2640, 4680]] },
  { name: 'Glacier Foot Path', w: 1.25, grade: 0.115, type: 4, wander: 0.5, pts: [
    [4000, 1560], [3970, 1420], [3940, 1285]] },
  { name: 'Moraine Path', w: 1.25, grade: 0.16, type: 4, wander: 0.7, pts: [
    [2600, 1530], [2520, 1470], [2440, 1408]] },
  { name: 'Ember Scramble', w: 1.25, grade: 0.16, type: 4, wander: 0.6, pts: [
    [7330, 2210], [7480, 2060], [7590, 1920]] },
  { name: 'Rim Vista Trail', w: 1.25, grade: 0.13, type: 4, wander: 0.6, pts: [
    [850, 2470], [950, 2280], [1030, 2120]] },
  { name: "Miner's Path", w: 1.25, grade: 0.115, type: 4, wander: 0.35, pts: [
    [700, 2830], [720, 2500], [700, 2230]] },
  { name: 'Coast Caves Trail', w: 1.25, grade: 0.16, type: 4, wander: 0.4, pts: [
    [5700, 4310], [5920, 4400], [5980, 4520], [6180, 4620]] },
  // Chapter 7A: WHISPER PATH — the winding dirt road through valley
  // floor. Both endpoints meet the (split) West Arm at z=2500, so no
  // dead end. Strong lateral wander (0.7) lets the road follow the
  // rolling contours rather than cutting across them. Passes very
  // close to spawn (2150, 2610) so the road is visible from there.
  // Type 1 (small main) so it draws as packed dirt, grade 0.10 keeps
  // it under the rideable ceiling even across the basin floor.
  { name: 'Whisper Path', w: 2.0, grade: 0.10, type: 1, wander: 0.7, pts: [
    [1300, 2500], [1500, 2560], [1700, 2600], [1900, 2630],
    [2100, 2620], [2300, 2630], [2500, 2620], [2700, 2590],
    [2900, 2550], [3100, 2520], [3300, 2500]] },
];

// ---- 5. Pass roads: [rangeIdx, gapIdx] saddles carrying switchbacks --------
// East = the pass region (both Eastguard saddles), plus Northwall and the
// Kanjiro Massif approaches. The Mistral Horn / Sorren Dome crossing is
// the marquee climb: EAGLE PASS ROAD.
const PASS_SADDLES = [[0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0]];
const PASS_NAMES = { '01': 'Eagle Pass Road' };

// Road hierarchy geometry. Half-widths of the flat bed:
//   MAIN 3.5 (7 m), PASS 2.5 (5 m), TRAIL 1.25 (2.5 m).
const W_MAIN = 3.5;
const W_PASS = 2.5;
const MAIN_GRADE = 0.11;   // 6.3 deg — well under the 10 deg road cap
const PASS_GRADE = 0.138;  // 7.9 deg construction => surface stays <= 10 deg
const ROAD_FADE_MAX = 190; // apron reach cap (Chapter 6: bounded)
const FILL_MAX = 40;       // deepest embankment a laid bed may stand on
const CUT_MAX = 30;        // deepest cutting before the bed is relaxed up
const PASS_WAVE = 560; // longer traverses on the wide Chapter 4 pedestals
const RD_STEP = 16;
const RD_CELL = 128;
// Chapter 5: corridor-segment index grid (see _buildCorridorIndex) and the
// integer cell-key stride shared by both spatial hashes (numeric keys —
// the old `${cx},${cz}` template strings allocated 9 strings per sample).
const CORR_CELL = 256;
const CORR_KEY = 4096;
const RD_KEY = 65536;

// Practice jump on the South Arm, 140 m from the spawn intersection.
const PJUMP = { x: 4000, z: 2640, h: 1.5, l: 8, w: 6 };

const q4 = (t) => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));

export class Landforms {
  constructor() {
    this.peaks = [];
    for (const r of RANGES) {
      r.bbox = rangeBBox(r);
      r.nodes.forEach((n, i) => this.peaks.push({
        id: `${r.id}${i}`, range: r.name, x: n[0], z: n[1], h: n[2], w: n[3], name: n[4],
      }));
    }
    this.lakes = LAKES;   // shoreline queries (vegetation)
    this.passes = [];     // filled by initRoads()
    this.mainRoads = [];  // filled by initRoads()
    this.viewpoints = []; // filled by initViewpoints()
    this.roadKm = 0;

    // Chapter 5 sampling acceleration (RESULTS ARE BIT-IDENTICAL — this
    // is pure bookkeeping, the world is not changed by one millimetre):
    //   * corridor() used to test all 56 main-route segments per sample;
    //     it now tests only the segments bucketed into the query cell.
    //   * corridor()/mountains() get a one-slot memo because one
    //     TerrainField.sample() asks for each of them 2-3 times at the
    //     very same (x, z) (base composition + the mountain factor).
    // Terrain sampling is the frame loop's single biggest cost (a tile
    // build is 1,225 samples), so this is where riding hitches come from.
    this._buildCorridorIndex();
    this._cmX = NaN; this._cmZ = NaN; this._cmV = 0; // corridor memo
    this._mmX = NaN; this._mmZ = NaN; this._mmV = 0; // mountains memo

    // Rider's Meadow fixtures (rendered by Props with the spawn sector).
    this.meadowFixtures = [
      { t: 'sign', x: 4016, z: 2516, yaw: -0.7, s: 1.1 },
      { t: 'cabin', x: 3865, z: 2620, yaw: 2.35, s: 1 },
      { t: 'flags', x: 4055, z: 2445, yaw: 0.9, s: 1 },
      { t: 'bench', x: 4152, z: 2648, yaw: -2.4, s: 1 },   // facing the lake
      { t: 'bench', x: 3968, z: 2755, yaw: 0.4, s: 1 },
      { t: 'flags', x: 4290, z: 2648, yaw: 2.1, s: 0.9 },  // lake far shore
    ];
  }

  stats() {
    return {
      peaks: this.peaks.length,
      ranges: RANGES.length,
      passes: this.passes.length,
      mainRoads: this.mainRoads.length,
      roadKm: +this.roadKm.toFixed(1),
      mainKm: +((this._mainM || 0) / 1000).toFixed(1),
      passKm: +((this._passM || 0) / 1000).toFixed(1),
      viewpoints: this.viewpoints.length,
      majorViewpoints: this.majorViewpoints ? this.majorViewpoints.length : 0,
      ridgeSystems: RIDGE_SYSTEMS.length,
      valleySystems: VALLEY_SYSTEMS.length,
      basins: BASINS.length,
      plateaus: PLATEAUS.length,
      crystalLakes: LAKES.filter((l) => l.crystal).length,
      scenicRoads: 6, // Horizon/Meadow Loops, Coastal, Red Canyon, Caldera, Glacier Route
      hiddenTrails: this.namedTrails ? this.namedTrails.filter((t) => {
        const m = [...this.roadMeta.values()].find((mm) => mm.name === t.name);
        return m && m.type === 4;
      }).length : 0,
      landmarks: this.destinations ? this.destinations.length : 0,
      worldW: WORLD_W, worldH: WORLD_H,
    };
  }

  // ---- 2. Valleys: the road-corridor mask ----------------------------------

  /**
   * Corridor mask in [0,1]: 1 on a main-road line, fading to 0 at 450 m.
   * Mountains and hills are suppressed by it, so the main roads always
   * run through wide gentle valleys — roads first, scenery second.
   */
  corridor(x, z) {
    // Chapter 5: one-slot memo — TerrainField asks for the corridor two
    // to three times at the same (x, z) per sample (base band, mountain
    // suppression, mountain factor).
    if (x === this._cmX && z === this._cmZ) return this._cmV;
    let m = 0;
    // Chapter 4: per-route corridor strength/width. The Eagle Approach
    // carves only a narrow partial notch (str 0.82, w 320) — it climbs
    // THROUGH the massif rather than flattening it.
    // Chapter 5: only the segments bucketed into this cell can reach the
    // point (every segment is registered in every cell its corridor-width
    // bbox touches), so the result is identical to the old full scan.
    const arr = this._corrHash.get(
      Math.floor(x / CORR_CELL) * CORR_KEY + Math.floor(z / CORR_CELL));
    if (arr) {
      const sn = _SN;
      for (let k = 0; k < arr.length; k++) {
        const i = arr[k];
        const cw = this._csW[i];
        segNearest(x, z, this._csAx[i], this._csAz[i], this._csBx[i], this._csBz[i]);
        if (sn.d2 < cw * cw) {
          const v = (1 - sstep(cw * 0.27, cw, Math.sqrt(sn.d2))) * this._csStr[i];
          if (v > m) m = v;
          if (m >= 1) { m = 1; break; }
        }
      }
    }
    this._cmX = x; this._cmZ = z; this._cmV = m;
    return m;
  }

  /**
   * Bucket every main-route segment into a uniform grid, dilated by its
   * own corridor width, so corridor() can look up candidates in O(1).
   * Built once at construction; ~1,700 index entries.
   */
  _buildCorridorIndex() {
    this._csAx = []; this._csAz = []; this._csBx = []; this._csBz = [];
    this._csStr = []; this._csW = [];
    this._corrHash = new Map();
    for (const route of MAIN_ROUTES) {
      const str = route.corrStr ?? 1;
      const cw = route.corrW ?? 340;
      const pts = route.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0], az = pts[i][1];
        const bx = pts[i + 1][0], bz = pts[i + 1][1];
        const idx = this._csAx.length;
        this._csAx.push(ax); this._csAz.push(az);
        this._csBx.push(bx); this._csBz.push(bz);
        this._csStr.push(str); this._csW.push(cw);
        const cx0 = Math.floor((Math.min(ax, bx) - cw) / CORR_CELL);
        const cx1 = Math.floor((Math.max(ax, bx) + cw) / CORR_CELL);
        const cz0 = Math.floor((Math.min(az, bz) - cw) / CORR_CELL);
        const cz1 = Math.floor((Math.max(az, bz) + cw) / CORR_CELL);
        for (let cz = cz0; cz <= cz1; cz++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const key = cx * CORR_KEY + cz;
            let a = this._corrHash.get(key);
            if (!a) this._corrHash.set(key, (a = []));
            a.push(idx);
          }
        }
      }
    }
  }

  /** Rider's Meadow mask: 1 at the spawn, 0 beyond the meadow rim. */
  meadowMask(x, z) {
    // Phase 3.1: wide outer fade (to 1.4 r) — the meadow plane eases into
    // the surrounding valley over ~500 m, so the rim never reads as a berm.
    const d = Math.hypot(x - MEADOW.x, z - MEADOW.z);
    return 1 - sstep(MEADOW.r * 0.55, MEADOW.r * 1.4, d);
  }

  // ---- 4. Mountains (new spine-profile algorithm) ---------------------------

  /**
   * Range contribution at (x,z). Input coordinates are domain-warped so
   * flanks and foothill lines are naturally irregular; the profile is a
   * cos^2 crest on a wide quartic skirt. Suppressed by the road corridor
   * and the meadow — mountains never swallow a road.
   */
  mountains(x, z) {
    // Chapter 5: one-slot memo (sample() composes the base height and
    // then asks for the mountain factor at the identical coordinate).
    if (x === this._mmX && z === this._mmZ) return this._mmV;
    // Domain warp (~90 m) breaks up the analytic spine silhouette.
    const wx = x + 180 * (vnoise(x * 0.0011 + 3.1, z * 0.0011 - 7.7, S + 3) - 0.5);
    const wz = z + 180 * (vnoise(x * 0.0011 - 9.2, z * 0.0011 + 4.4, S + 5) - 0.5);
    let best = 0;
    for (const r of RANGES) {
      const bb = r.bbox;
      if (wx < bb[0] || wx > bb[1] || wz < bb[2] || wz > bb[3]) continue;
      let d2 = Infinity, gi = 0, gu = 0;
      for (let i = 0; i < r.nodes.length - 1; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1];
        segNearest(wx, wz, a[0], a[1], b[0], b[1]);
        if (_SN.d2 < d2) { d2 = _SN.d2; gi = i; gu = _SN.t; }
      }
      const a = r.nodes[gi], b = r.nodes[gi + 1];
      const fs = gu * gu * (3 - 2 * gu);
      const sad = 1 - r.dips[gi] * Math.sin(Math.PI * gu) ** 2;
      const H = (a[2] + (b[2] - a[2]) * fs) * sad;
      const W = a[3] + (b[3] - a[3]) * fs;
      const d = Math.sqrt(d2);
      let h = SKIRT_F * H * q4(d / (SKIRT_W * W));
      if (d < W) {
        const c = Math.cos((d / W) * Math.PI * 0.5);
        h += CREST_F * H * c * c;
      }
      if (h > best) best = h;
    }
    if (best <= 0) { this._mmX = x; this._mmZ = z; this._mmV = 0; return 0; }
    // Alpine texture (multiplicative, never a wall).
    best *= 1 + 0.12 * (vnoise(x * 0.004 + 1.7, z * 0.004 - 2.9, S + 9) - 0.5);
    // Roads first: the corridor pushes the ranges back. Phase 3.1: an
    // OPEN SPAWN BASIN replaces the old tight meadow ring — no massif
    // contribution within 1 km of Rider's Meadow, full height only
    // beyond ~1.8 km, so the spawn reads as an open valley with distant
    // mountains instead of a bowl.
    // Border-only rule: fade the massif out as we move inland from the
    // nearest map edge (Chapter 6).
    const edge = Math.min(x, WORLD_W - x, z, WORLD_H - z);
    const sup = (1 - 0.94 * this.corridor(x, z)) *
      (1 - sstep(MTN_EDGE0, MTN_EDGE1, edge)) *
      sstep(1000, 1800, Math.hypot(x - MEADOW.x, z - MEADOW.z));
    const out = best * sup;
    this._mmX = x; this._mmZ = z; this._mmV = out;
    return out;
  }

  /**
   * Red Canyon trench (Chapter 4, west region): a deep carve between the
   * Redwall range and the Horizon Loop's west side. Floor ~95 m, walls
   * eased by smin; the north/south ends ramp closed so roads/trails can
   * enter along the floor.
   */
  canyonCarve(x, z, h) {
    if (x > 1500 || z < 1380 || z > 3820) return h;
    const zm = sstep(1400, 1760, z) * sstep(3800, 3440, z);
    if (zm <= 0) return h;
    // Chapter 6: the trench is blended in with a WIDTH MASK instead of a
    // hard min() inside a rectangular region. The old version clipped at
    // x = 250 and dropped ~900 m in one step — the single worst wall in
    // the world. Now the carve fades out before it reaches the Redwall
    // crest, so the rim is the mountain's own flank.
    const d = x - CANYON_X;
    const w = 1 - sstep(CANYON_HALF, CANYON_FADE, Math.abs(d));
    if (w <= 0) return h;
    const prof = CANYON_FLOOR +
      (d < 0 ? 1.05 * Math.max(0, -d - 70) : 0.7 * Math.max(0, d - 120));
    if (prof >= h) return h;
    return h + (prof - h) * w * zm;
  }

  /** Practice jump kicker on the South Arm (applied AFTER road blending). */
  practiceJump(x, z) {
    const du = Math.abs(z - PJUMP.z) / PJUMP.l;
    if (du >= 1) return 0;
    const cw = (x - PJUMP.x) / PJUMP.w;
    let w = 1 - cw * cw;
    if (w <= 0) return 0;
    w *= w;
    const t = 1 - du;
    return PJUMP.h * t * t * w;
  }

  /** Combined lake bowl depth (meadow lake + the southern lakes). */
  /**
   * Chapter 5A ridge systems: authored crest chains added on top of the
   * eroded lowland. `corr` suppresses them along main-road corridors so a
   * road never has to climb a ridge head-on — it runs around the flank or
   * through a saddle.
   */
  ridgeSystems(x, z, corr) {
    let add = 0;
    for (const r of RIDGE_SYSTEMS) {
      const bb = r._bb || (r._bb = ridgeBBox(r));
      if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
      let d2 = Infinity, u = 0, seg = 0;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        segNearest(x, z, a[0], a[1], b[0], b[1]);
        if (_SN.d2 < d2) { d2 = _SN.d2; u = _SN.t; seg = i; }
      }
      const d = Math.sqrt(d2);
      if (d >= r.w) continue;
      // Crest undulation along the spine: high points with saddles
      // between them (the low points are the natural crossings).
      const t = (seg + u) / (r.pts.length - 1);
      const crest = 1 - r.wave * (0.5 - 0.5 * Math.cos(t * Math.PI * 2 * (r.pts.length - 1)));
      const rough = 1 + 0.16 * (vnoise(x * 0.0035 + 12.7, z * 0.0035 - 4.3, S + 61) - 0.5);
      let v = r.h * crest * rough * q4(d / r.w);
      // Chapter 6A — GENTLE CLIFFS ALONG THE RIDGE EDGES. A terrace band
      // on the OUTER flank, peaking at 0.9 of the half-width where the
      // quartic profile has already gone slack (its gradient there is
      // about 7 deg). A step nearer the crest lands on the profile's
      // steepest part at u~0.58 and the two gradients add into something
      // unrideable, which is exactly what the first attempt at this did.
      // 4 m spread over 0.12 of the half-width keeps the sum near 16 deg:
      // a low escarpment you ride along looking for the ramp.
      if (r.bench) {
        const u = d / r.w;
        v += r.bench * crest * sstep(0.78, 0.90, u) * sstep(1.0, 0.90, u);
      }
      if (v > add) add = v;
    }
    return add * (1 - 0.72 * corr);
  }

  /** Chapter 5A basins: wide bowls with flat floors, eased at the rim. */
  basinDepth(x, z, corr) {
    let cut = 0;
    for (const b of BASINS) {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d >= b.r) continue;
      // Flat floor out to `flat` of the radius, then a smooth rim.
      const v = b.depth * (1 - sstep(b.r * b.flat, b.r, d));
      if (v > cut) cut = v;
    }
    return cut * (1 - 0.45 * corr);
  }

  /**
   * Chapter 6A: the four authored valley systems. A broad flat-bottomed
   * trough along each trunk — flat out to `flat` of the half-width, then
   * a quartic wall out to the full width. Depths take the DEEPEST valley
   * at a point rather than summing, so where two trunks meet the floors
   * merge into one confluence instead of digging a pit.
   *
   * `corr` softens the carve along a main road corridor. The corridors
   * already sit in the valley floors by design, so this only stops a
   * road that crosses a trunk from dropping into it and back out.
   */
  valleyDepth(x, z, corr) {
    let cut = 0;
    for (const v of VALLEY_SYSTEMS) {
      const bb = v._bb || (v._bb = ridgeBBox({ pts: v.pts, w: v.w }));
      if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
      let d2 = Infinity;
      for (let i = 0; i < v.pts.length - 1; i++) {
        const a = v.pts[i], b = v.pts[i + 1];
        segNearest(x, z, a[0], a[1], b[0], b[1]);
        if (_SN.d2 < d2) d2 = _SN.d2;
      }
      const d = Math.sqrt(d2);
      if (d >= v.w) continue;
      const u = d / v.w;
      // Flat floor, then a smooth wall. A little meander on the wall so
      // the trough is not a perfectly parallel-sided ditch.
      const wob = 1 + 0.14 * (vnoise(x * 0.0028 - 5.1, z * 0.0028 + 7.6, S + 71) - 0.5);
      const dep = v.d * wob * (u <= v.flat ? 1 : q4((u - v.flat) / (1 - v.flat)));
      if (dep > cut) cut = dep;
    }
    return cut * (1 - 0.5 * corr);
  }

  /** Named landform under a point (debug/report tooling). */
  landformAt(x, z) {
    for (const b of BASINS) if (Math.hypot(x - b.x, z - b.z) < b.r) return b.name;
    for (const p of PLATEAUS) if (Math.hypot(x - p.x, z - p.z) < p.r) return p.name;
    for (const r of RIDGE_SYSTEMS) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        segNearest(x, z, a[0], a[1], b[0], b[1]);
        if (_SN.d2 < r.w * r.w) return r.name;
      }
    }
    for (const v of VALLEY_SYSTEMS) {
      for (let i = 0; i < v.pts.length - 1; i++) {
        const a = v.pts[i], b = v.pts[i + 1];
        segNearest(x, z, a[0], a[1], b[0], b[1]);
        if (_SN.d2 < v.w * v.w) return v.name;
      }
    }
    return null;
  }

  /** Chapter 5A plateaus: flat tables on a ~28 deg rim ("gentle cliffs"). */
  plateauLift(x, z, corr) {
    let add = 0;
    for (const p of PLATEAUS) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d >= p.r + 40) continue;
      const v = p.h * (1 - sstep(p.rim, p.r, d));
      if (v > add) add = v;
    }
    return add * (1 - 0.6 * corr);
  }

  // ---- Chapter 7A: WHISPER VALLEY floor + hill methods -----------------
  // Floor returns the DEPTH in metres to CARVE OUT. Terrain subtracts it;
  // outside the floor half-width it returns 0. Hills return the height in
  // metres to ADD; outside their respective half-widths they return 0.
  // Both rebuild the world only inside WHISPER_VALLEY — a tight bbox
  // around the new spine — so every other region stays bit-identical.

  /** Floor profile (Chapter 7A). Subtract this from natural terrain. */
  whisperValleyFloor(x, z) {
    const spine = WHISPER_VALLEY.spine;
    let d2 = Infinity;
    for (let i = 0; i < spine.length - 1; i++) {
      segNearest(x, z, spine[i][0], spine[i][1], spine[i + 1][0], spine[i + 1][1]);
      if (_SN.d2 < d2) d2 = _SN.d2;
    }
    const d = Math.sqrt(d2);
    if (d >= WHISPER_VALLEY.floorHalfWidth) return 0;
    const u = d / WHISPER_VALLEY.floorHalfWidth;
    // Base trench: smooth (1 - u^2) fade from 0 at the rim to floorDepth
    // at the centre. Kept small (~2 m) because Sundown Basin (centered
    // at 2350, 2690, r=640, depth=26 m) already carved the wider floor
    // to ~26 m below natural. We just gently deepen the groove.
    const trenchDepth = WHISPER_VALLEY.floorDepth * (1 - u * u);
    // GENTLE ROLLING UNDULATION. Two layers of noise sampled at large
    // wavelengths (~150 m and ~80 m) so the variation lands in the
    // 3-10 m spec band, with no sharp bumps. Edge-fade so noise dies
    // before the floor rim so WV terrain joins the surrounding lowland
    // smoothly (no cliff where the trench meets the open country).
    const lon = vnoise(x * 0.0042 - 7.3, z * 0.0034 + 11.5, 8.13);
    const lat = vnoise(x * 0.0078 + 3.1, z * 0.0061 - 4.3, 16.39);
    const rolling = (lon - 0.5) * 7 + (lat - 0.5) * 3;     // ±5 m peak-to-peak
    const edge = 1 - u * u;
    return trenchDepth + rolling * edge;
  }

  /**
   * Enclosing hills on one side of the valley.
   *   side === 'l'  →  left hills (north side, gentler flank)
   *   side === 'r'  →  right hills (south side, slightly steeper flank)
   *
   * Profile: cos^p(u * π/2) where p = 1 + steepness.
   *   left hills:  steepness 1.0 → cos²    (45-70 m spec, gentle)
   *   right hills: steepness 1.6 → cos^2.6  (45-80 m spec, steeper)
   * Domain-warped so each hill's silhouette is irregular, not perfectly
   * repeated along the spine. Returns 0 outside the configured half-width
   * so the contribution dies smoothly at the flank.
   */
  whisperValleyHills(x, z, side) {
    const cfg = side === 'l' ? WHISPER_VALLEY.leftHills : WHISPER_VALLEY.rightHills;
    let d2 = Infinity;
    for (let i = 0; i < cfg.spine.length - 1; i++) {
      segNearest(x, z, cfg.spine[i][0], cfg.spine[i][1],
        cfg.spine[i + 1][0], cfg.spine[i + 1][1]);
      if (_SN.d2 < d2) d2 = _SN.d2;
    }
    const d = Math.sqrt(d2);
    if (d >= cfg.halfWidth) return 0;
    const u = d / cfg.halfWidth;
    const exp = 1 + (cfg.steepness || 1.0);                 // left: 2, right: 2.6
    const crest = cfg.height * Math.cos(u * Math.PI * 0.5) ** exp;
    // Mild domain warp so the ridge silhouette isn't a perfect prism.
    const wob = 1 + 0.18 * (vnoise(x * 0.0035 + 11.3, z * 0.0035 - 4.4, S + 81) - 0.5);
    return crest * wob;
  }

  /** Loose-axis bbox test for the new valley (used by Vegetation / Props). */
  inWhisperValley(x, z) {
    return x >= WHISPER_BBOX.x0 && x <= WHISPER_BBOX.x1
        && z >= WHISPER_BBOX.z0 && z <= WHISPER_BBOX.z1;
  }


  /** True inside a lake's water surface — nothing is planted or scattered
   *  there (Chapter 5A: the crystal lakes had pines standing in them). */
  inWater(x, z) {
    for (const l of LAKES) {
      const r = l.level ? l.r * 1.04 : l.r * 0.9;
      const dx = x - l.x, dz = z - l.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  lakeDepth(x, z) {
    let h = 0;
    for (const l of LAKES) {
      if (l.level) continue; // levelled lakes are shaped in lakeShape()
      const d = Math.hypot(x - l.x, z - l.z);
      if (d < l.r) h += l.depth * q4(d / l.r);
    }
    return h;
  }

  /**
   * Chapter 5A crystal lakes: a LEVELLED lake. A bowl carved into sloping
   * ground gives you a flat water disc standing proud of the downhill
   * shore (water running uphill); a real lake sits in a level pan. Inside
   * the basin the surface is blended to `level - depth * bowl`, the shore
   * ring is pinned at the waterline and the apron rises ~9 m above it, so
   * the lake is enclosed from every direction and the blend back into the
   * natural ground is smooth.
   */
  lakeShape(x, z, h) {
    for (const l of LAKES) {
      if (!l.level) continue;
      const d = Math.hypot(x - l.x, z - l.z);
      const R = l.r * 3.4;
      if (d >= R) continue;
      const bowl = l.level - l.depth * q4(d / l.r) + 13 * sstep(l.r * 0.98, R * 0.55, d);
      const w = 1 - sstep(R * 0.42, R, d);
      h += (bowl - h) * w;
    }
    return h;
  }

  // ---- Roads (laid once at startup) -----------------------------------------

  initRoads(raw) {
    this._rx = []; this._rz = []; this._re = [];
    this._rid = []; this._rw = []; this._rt = [];
    this._hash = new Map();
    this.roadMeta = new Map(); // rid -> { name, i0, n, type }
    let roadId = 0, totalM = 0;
    this._mainM = 0; this._passM = 0; this._trailM = 0;

    // 1. Main roads: the loop first, then the meadow arms and the Meadow
    // Loop ring (later routes pin their junction elevations to roads
    // already laid).
    for (const route of MAIN_ROUTES) {
      const id = roadId++;
      const i0 = this._rx.length;
      // Chapter 6: a route may be declared a CLIMB to a named saddle.
      // Its last vertex is then pinned to the saddle elevation, so the
      // grade clamp turns the authored serpentine into a real ramp
      // instead of letting it wander back down every dip in the flank
      // (which left the marquee climb 200 m below its own pass road).
      let endE = null;
      if (route.endSaddle) {
        const r = RANGES[route.endSaddle[0]];
        const a = r.nodes[route.endSaddle[1]], b = r.nodes[route.endSaddle[1] + 1];
        endE = raw((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      const lenM = this._laySpline(raw, route.pts, id, {
        w: route.w ?? W_MAIN, grade: route.grade ?? MAIN_GRADE, type: 1,
        calm: route.calm, wander: route.wander ?? 1, endE,
      });
      this.roadMeta.set(id, { name: route.name, i0, n: this._rx.length - i0, type: 1 });
      this.mainRoads.push({ name: route.name, roadId: id, lengthM: lenM });
      this._mainM += lenM;
      totalM += lenM;
    }

    // 5. Pass roads over the range saddles (both flanks per pass).
    for (const [ri, gi] of PASS_SADDLES) {
      const r = RANGES[ri];
      const a = r.nodes[gi], b = r.nodes[gi + 1];
      const sx = (a[0] + b[0]) / 2, sz = (a[1] + b[1]) / 2;
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const vx = (b[0] - a[0]) / tl, vz = (b[1] - a[1]) / tl;
      const ux = -vz, uz = vx;
      const saddleE = raw(sx, sz);
      const passName = PASS_NAMES[`${ri}${gi}`] || `${a[4]} / ${b[4]} Pass`;
      let lenM = 0;
      const flankIds = [];
      for (const side of [1, -1]) {
        flankIds.push(roadId);
        const i0 = this._rx.length;
        lenM += this._walkSwitchbacks(raw, sx, sz, saddleE,
          ux * side, uz * side, vx, vz, roadId);
        this.roadMeta.set(roadId, { name: passName, i0, n: this._rx.length - i0, type: 2 });
        roadId++;
      }
      this.passes.push({
        id: `${r.id}${gi}-${r.id}${gi + 1}`, name: passName,
        sx, sz, elev: +saddleE.toFixed(0), lengthM: lenM, roadId: flankIds[0], flankIds,
      });
      this._passM += lenM;
      totalM += lenM;
    }

    // 6. Named singletrack (Glacier Route / Canyon Trail / Ridge
    // Shortcut) — laid last so both endpoints pin to the network.
    this.namedTrails = [];
    for (const t of NAMED_TRAILS) {
      const id = roadId++;
      const i0 = this._rx.length;
      const lenM = this._laySpline(raw, t.pts, id, {
        w: t.w, grade: t.grade, type: t.type, wander: t.wander,
      });
      this.roadMeta.set(id, { name: t.name, i0, n: this._rx.length - i0, type: t.type });
      this.namedTrails.push({ name: t.name, roadId: id, lengthM: lenM });
      this._trailM += lenM;
      totalM += lenM;
    }
    this.roadKm = totalM / 1000;

    this._initDestinations(raw);
  }

  /**
   * Destinations (Chapter 3A): every named road terminates at (or passes)
   * a rewarded landmark — no dead ends without a payoff. Props renders
   * them; F3 names the nearest one.
   */
  _initDestinations(raw) {
    const eagle = this.passes[0];      // Eagle Pass saddle (N gap 1)
    const glacierEnd = this.passes[1]; // Sorren/Thornspire saddle
    this.destinations = [
      { id: 'D1', name: 'Eagle Eyrie Lookout', x: eagle.sx + 14, z: eagle.sz + 10,
        kind: 'lookout', props: ['lookout', 'flags', 'bench'] },
      { id: 'D2', name: "Hermit's Cabin", x: glacierEnd.sx + 16, z: glacierEnd.sz + 12,
        kind: 'cabin', props: ['cabin', 'sign'] },
      { id: 'D3', name: 'Stone Arch', x: 6950, z: 2648,
        kind: 'arch', props: ['arch', 'rocks'] },
      { id: 'D4', name: 'Prayer Flag Hill', x: 2560, z: 1445,
        kind: 'flags', props: ['flags', 'flags', 'bench'] },
      { id: 'D5', name: 'Twin Lakes Rest', x: 3700, z: 3590,
        kind: 'rest', props: ['rest', 'bench', 'sign'] },
      { id: 'D6', name: "Rider's Meadow", x: MEADOW.x, z: MEADOW.z,
        kind: 'meadow', props: [] },
      // Chapter 4 landmarks (each at a named-trail / scenic-road end).
      { id: 'D7', name: 'Glacier Overlook', x: 3952, z: 1268,
        kind: 'lookout', props: ['lookout', 'flags'] },
      { id: 'D8', name: 'Moraine Cave', x: 2408, z: 1392,
        kind: 'cave', props: ['cave', 'rocks'] },
      { id: 'D9', name: 'Redwall Vista', x: 1042, z: 2104,
        kind: 'lookout', props: ['lookout', 'bench'] },
      { id: 'D10', name: 'Canyon Floor Cave', x: 672, z: 2214,
        kind: 'cave', props: ['cave', 'scree'] },
      { id: 'D11', name: 'Black Sand Rest', x: 4110, z: 4700,
        kind: 'rest', props: ['rest', 'bench'] },
      { id: 'D12', name: 'Cliff Arch', x: 2652, z: 4696,
        kind: 'arch', props: ['arch', 'rocks'] },
      { id: 'D13', name: 'Ember Lookout', x: 7532, z: 2886,
        kind: 'lookout', props: ['lookout', 'flags', 'bench'] },
      { id: 'D14', name: 'Cinder Cave', x: 7560, z: 1950,
        kind: 'cave', props: ['cave', 'scree'] },
      { id: 'D15', name: 'Coast Caves', x: 6192, z: 4636,
        kind: 'cave', props: ['cave', 'rocks', 'bench'] },
    ];
  }
  /** Nearest destination landmark to (x,z) — F3 + tests. */
  nearestDestination(x, z) {
    let best = null, bd = Infinity;
    for (const d of this.destinations) {
      const dd = Math.hypot(x - d.x, z - d.z);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best ? { ...best, dist: +bd.toFixed(0) } : null;
  }

  /**
   * Road under (x,z) within its bed/apron: { name, type, progress } or
   * null. Progress is the fraction along the named road (F3).
   */
  roadAt(x, z) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    let bi = -1, bd2 = 30 * 30;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get((cx + dx) * RD_KEY + (cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - this._rx[i], ddz = z - this._rz[i];
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < bd2) { bd2 = d2; bi = i; }
        }
      }
    }
    if (bi < 0) return null;
    const meta = this.roadMeta.get(this._rid[bi]);
    if (!meta) return null;
    return {
      name: meta.name,
      type: this._rt[bi],
      progress: meta.n > 1 ? +((bi - meta.i0) / (meta.n - 1)).toFixed(2) : 0,
    };
  }

  /**
   * Lay one named road spline: resample at RD_STEP with a flowing
   * lateral wander scaled by opts.wander (suppressed near Rider's Meadow
   * for calm arms), grade-clamp the terrain-following elevation both
   * directions to opts.grade, smooth, pin junction endpoints to
   * already-laid roads, and close loops seamlessly.
   */
  _laySpline(raw, pts, roadId, opts) {
    const grade = opts.grade, halfW = opts.w, type = opts.type;
    const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
    const X = [], Z = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      const px = -uz, pz = ux;
      const n = Math.max(1, Math.round(L / RD_STEP));
      for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
        const t = k / n;
        let wob = (Math.sin((i + t) * 2.4 + roadId) * 26 +
                  Math.sin((i + t) * 5.9 + roadId * 2.7) * 11) * (opts.wander ?? 1);
        wob *= Math.sin(Math.PI * t); // stay put at control points
        const bx = a[0] + (b[0] - a[0]) * t, bz = a[1] + (b[1] - a[1]) * t;
        if (opts.calm) {
          const dm = Math.hypot(bx - MEADOW.x, bz - MEADOW.z);
          wob *= Math.min(1, Math.max(0, (dm - 450) / 300));
        }
        X.push(bx + px * wob);
        Z.push(bz + pz * wob);
      }
    }
    const E = new Float64Array(X.length);
    for (let i = 0; i < X.length; i++) E[i] = raw(X[i], Z[i]);
    const eStart = this._roadElevNear(X[0], Z[0]);
    if (eStart !== null) E[0] = eStart;
    const eEnd = opts.endE != null ? opts.endE
      : this._roadElevNear(X[X.length - 1], Z[X.length - 1]);
    if (eEnd !== null) E[E.length - 1] = eEnd;
    const pinnedEnd = eEnd !== null;
    const clampGrade = () => {
      const last = E.length - (pinnedEnd ? 2 : 1);
      for (let i = 1; i <= last; i++) {
        const ds = Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
        E[i] = Math.max(E[i - 1] - grade * ds, Math.min(E[i - 1] + grade * ds, E[i]));
      }
      for (let i = E.length - 2; i >= 1; i--) {
        const ds = Math.hypot(X[i + 1] - X[i], Z[i + 1] - Z[i]);
        E[i] = Math.max(E[i + 1] - grade * ds, Math.min(E[i + 1] + grade * ds, E[i]));
      }
    };
    clampGrade();
    // Chapter 6 — ROADS FOLLOW THE VALLEYS. A single grade clamp pass can
    // leave a bed hundreds of metres off the ground on steep flanks (the
    // clamp propagates one endpoint's elevation across the whole road),
    // which is what built the old fill pedestals and their wall-like
    // aprons. Alternating "pull back down to the ground" with "re-clamp
    // the grade" converges on the closest alignment the grade limit
    // allows — exactly how a real alignment is fitted to a valley.
    // The correction is a FILL CAP, not a general pull: a bed may cut
    // into a hillside as deep as the alignment needs (that is how a road
    // climbs a flank), but it may not stand on more than FILL_MAX of
    // embankment. Alternating the cap with a grade re-clamp converges on
    // an alignment that lies on the ground wherever it can — no more
    // 500 m fill pedestals, and their wall-like aprons go with them.
    if (opts.endE == null) {
      for (let it = 0; it < 6; it++) {
        for (let i = 1; i < E.length - 1; i++) {
          const g = raw(X[i], Z[i]);
          if (E[i] > g + FILL_MAX) E[i] += (g + FILL_MAX - E[i]) * 0.5;
          else if (E[i] < g - CUT_MAX) E[i] += (g - CUT_MAX - E[i]) * 0.5;
        }
        clampGrade();
      }
    }
    for (let p = 0; p < 2; p++) {
      for (let i = 1; i < E.length - 1; i++) E[i] = (E[i - 1] + 2 * E[i] + E[i + 1]) / 4;
    }
    // Re-pin junction endpoints. The clamp/smooth passes may have drifted
    // them; distribute the correction linearly over ~12 vertices (~190 m)
    // so re-pinning adds at most a few % of grade, never a step.
    if (eStart !== null) {
      const dE = eStart - E[0];
      for (let k = 0; k < Math.min(12, E.length); k++) E[k] += dE * (1 - k / 12);
    }
    if (eEnd !== null) {
      const n = E.length;
      const dE = eEnd - E[n - 1];
      for (let k = 0; k < Math.min(12, n); k++) E[n - 1 - k] += dE * (1 - k / 12);
    }
    if (closed) {
      // Seamless closure: blend both ends to their average over ~15 pts.
      const n = E.length;
      const eJ = (E[0] + E[n - 1]) / 2;
      for (let k = 0; k < 15; k++) {
        const f = 1 - k / 15;
        E[k] += (eJ - E[k]) * f * (1 - k / 15);
        E[n - 1 - k] += (eJ - E[n - 1 - k]) * f * (1 - k / 15);
      }
      E[0] = eJ; E[n - 1] = eJ;
    }
    let len = 0;
    for (let i = 0; i < X.length; i++) {
      this._pushVertex(X[i], Z[i], E[i], roadId, halfW, type);
      if (i > 0) len += Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
    }
    return len;
  }

  /**
   * Contour-aware switchback walker for one flank of a pass (unchanged
   * proven algorithm): candidate-heading fan follows the contour matching
   * a grade-clamped descent, hairpins on the serpentine clock, stops at
   * conflicts/embankments, tapers its tip into the terrain.
   */
  _walkSwitchbacks(raw, sx, sz, saddleE, ox, oz, vx, vz, roadId) {
    let x = sx, z = sz, e = saddleE;
    let lat = 1, sinceTurn = 0, len = 0, embank = 0;
    let hx = ox, hz = oz;
    this._pushVertex(x, z, e, roadId, W_PASS, 2);
    for (let i = 0; i < 700; i++) {
      let bx = vx * lat + ox * 0.62, bz = vz * lat + oz * 0.62;
      const bl = Math.hypot(bx, bz);
      bx /= bl; bz /= bl;
      const eWant = e - PASS_GRADE * RD_STEP * 0.8;
      let bestS = Infinity, bhx = bx, bhz = bz;
      for (let a = -0.9; a <= 0.9; a += 0.15) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const cx2 = bx * ca - bz * sa, cz2 = bx * sa + bz * ca;
        if (cx2 * hx + cz2 * hz < -0.2) continue;
        const eC = raw(x + cx2 * RD_STEP, z + cz2 * RD_STEP);
        const score = Math.abs(eC - eWant) + Math.abs(a) * 1.6;
        if (score < bestS) { bestS = score; bhx = cx2; bhz = cz2; }
      }
      const turn = Math.max(0, (bhx * hx + bhz * hz + 1) / 2);
      hx = bhx; hz = bhz;
      const nx2 = x + hx * RD_STEP, nz2 = z + hz * RD_STEP;
      const eT = raw(nx2, nz2);
      const gStep = PASS_GRADE * RD_STEP * (0.15 + 0.85 * turn * turn);
      let eN = Math.max(e - gStep, Math.min(e + gStep, eT));
      const cur0 = this._rx.length - 1;
      // Elbow clamp window must cover a FULL switchback leg (PASS_WAVE/2
      // of arc plus the fold), so adjacent legs always get clamped and
      // never trip the self-conflict check between them.
      for (let b2 = 4; b2 <= 30; b2++) {
        const i2 = cur0 - b2;
        if (i2 < 0 || this._rid[i2] !== roadId) break;
        const dpx = nx2 - this._rx[i2], dpz = nz2 - this._rz[i2];
        const dp = Math.hypot(dpx, dpz);
        if (dp < 60) {
          const lim = Math.max(0.8, 0.155 * dp);
          const ei = this._re[i2];
          eN = Math.max(ei - lim, Math.min(ei + lim, eN));
        }
      }
      const gCap = Math.max(0.08, PASS_GRADE * (0.3 + 0.7 * turn)) * RD_STEP;
      eN = Math.max(e - gCap, Math.min(e + gCap, eN));
      if (this._conflict(nx2, nz2, eN, roadId)) break;
      x = nx2; z = nz2; e = eN;
      this._pushVertex(x, z, e, roadId, W_PASS, 2);
      len += RD_STEP;
      sinceTurn += RD_STEP;
      if (sinceTurn > PASS_WAVE / 2) { lat = -lat; sinceTurn = 0; }
      if (this.mountains(x, z) < 45 && Math.abs(e - eT) < 3) break;
      // Embankment with hysteresis: brief gully crossings bench over
      // (the blend widens automatically); only a SUSTAINED drop-away
      // (6 consecutive steps > 34 m) ends the flank.
      if (e - eT > 30) { if (++embank >= 5) break; }
      else embank = 0;
      if (x < 60 || x > WORLD_W - 60 || z < 60 || z > WORLD_H - 60) break;
    }
    // Landing taper.
    for (let i = 0; i < 60; i++) {
      const eT0 = raw(x, z);
      if (Math.abs(e - eT0) < 1) break;
      const nx2 = x + hx * RD_STEP, nz2 = z + hz * RD_STEP;
      if (nx2 < 40 || nx2 > WORLD_W - 40 || nz2 < 40 || nz2 > WORLD_H - 40) break;
      const eT = raw(nx2, nz2);
      const eN = Math.max(e - PASS_GRADE * RD_STEP, Math.min(e + PASS_GRADE * RD_STEP, eT));
      if (eN - eT > 26) break;
      if (this._conflict(nx2, nz2, eN, roadId)) break;
      x = nx2; z = nz2; e = eN;
      this._pushVertex(x, z, e, roadId, W_PASS, 2);
      len += RD_STEP;
    }
    // Trim hanging tips.
    let last = this._rx.length - 1;
    while (last >= 0 && this._rid[last] === roadId &&
           this._re[last] - raw(this._rx[last], this._rz[last]) > 22) {
      this._popVertex();
      last--;
      len -= RD_STEP;
    }
    return Math.max(0, len);
  }

  /** Conflict: another road (or own loop-back) nearby at a >30% wall. */
  _conflict(x, z, e, roadId) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    const cur = this._rx.length - 1;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get((cx + dx) * RD_KEY + (cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - this._rx[i], ddz = z - this._rz[i];
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > 110 * 110) continue;
          const d = Math.sqrt(d2);
          if (this._rid[i] === roadId) {
            const arc = (cur - i) * RD_STEP;
            // Own path: within the elbow-clamp window (30 verts) the
            // clamp guarantees the beds stay joined — never a conflict;
            // beyond it only a true LOOP-BACK counts (returned close to
            // a much older bench at a >30% wall). On the wide Chapter 4
            // pedestals legs run closer for longer, so the euclid/arc
            // ratio threshold drops to 0.22 and the wall test still
            // applies below.
            if (arc <= 30 * RD_STEP || d > 0.35 * arc) continue;
          }
          const dE = Math.abs(e - this._re[i]);
          if (dE > Math.max(3, 0.30 * d)) return true;
        }
      }
    }
    return false;
  }

  /** Distance to the nearest road vertex (prop placement keeps clear). */
  roadDist(x, z) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    let best = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get((cx + dx) * RD_KEY + (cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - this._rx[i], ddz = z - this._rz[i];
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  }

  /** Interpolated elevation of the nearest laid road segment within 60 m. */
  _roadElevNear(x, z) {
    let best = null, bd2 = 60 * 60;
    for (let i = 0; i < this._rx.length - 1; i++) {
      if (this._rid[i + 1] !== this._rid[i]) continue;
      const ax = this._rx[i], az = this._rz[i];
      const abx = this._rx[i + 1] - ax, abz = this._rz[i + 1] - az;
      const l2 = abx * abx + abz * abz;
      let t = l2 > 0 ? ((x - ax) * abx + (z - az) * abz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + abx * t), dz = z - (az + abz * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < bd2) { bd2 = d2; best = this._re[i] + (this._re[i + 1] - this._re[i]) * t; }
    }
    return best;
  }

  _pushVertex(x, z, e, roadId, halfW = W_PASS, type = 2) {
    const idx = this._rx.length;
    this._rx.push(x); this._rz.push(z); this._re.push(e); this._rid.push(roadId);
    this._rw.push(halfW); this._rt.push(type);
    const key = Math.floor(x / RD_CELL) * RD_KEY + Math.floor(z / RD_CELL);
    let arr = this._hash.get(key);
    if (!arr) this._hash.set(key, (arr = []));
    arr.push(idx);
  }

  _popVertex() {
    const idx = this._rx.length - 1;
    if (idx < 0) return;
    const x = this._rx[idx], z = this._rz[idx];
    const key = Math.floor(x / RD_CELL) * RD_KEY + Math.floor(z / RD_CELL);
    const arr = this._hash.get(key);
    if (arr) {
      const k = arr.lastIndexOf(idx);
      if (k >= 0) arr.splice(k, 1);
    }
    this._rx.pop(); this._rz.pop(); this._re.pop();
    this._rid.pop(); this._rw.pop(); this._rt.pop();
  }

  /**
   * Blend all roads into h — weighted average over nearby segments with
   * bed-dominance weighting (a segment whose bed you are ON outweighs
   * distant neighbors ~30x): continuous everywhere, smooth junction
   * handovers, aprons widen 3.2x cut/fill so shoulders stay <= 18 deg.
   */
  roads(x, z, h, L) {
    const cx = Math.floor(x / RD_CELL), cz = Math.floor(z / RD_CELL);
    let wSum = 0, weSum = 0, wMax = 0, dMin2 = Infinity, nearW = W_PASS, nearT = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._hash.get((cx + dx) * RD_KEY + (cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const j = i + 1 < this._rx.length && this._rid[i + 1] === this._rid[i] ? i + 1 : i;
          const ax = this._rx[i], az = this._rz[i];
          const abx = this._rx[j] - ax, abz = this._rz[j] - az;
          const l2 = abx * abx + abz * abz;
          let t = l2 > 0 ? ((x - ax) * abx + (z - az) * abz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = x - (ax + abx * t), pz = z - (az + abz * t);
          const d2 = px * px + pz * pz;
          if (d2 > ROAD_FADE_MAX * ROAD_FADE_MAX) continue;
          const E = this._re[i] + (this._re[j] - this._re[i]) * t;
          const hw = this._rw[i];
          const d = Math.sqrt(d2);
          // Per-segment weight: continuous, 0 at its own fade edge; the
          // apron widens 3.2x cut/fill depth (shoulders <= ~17 deg).
          const fade = Math.min(ROAD_FADE_MAX, hw * 2.3 + Math.abs(E - h) * 3.4);
          if (d >= fade) continue;
          let w = 1 - sstep(0, fade, d);
          w *= w;
          const bd = 1 - sstep(0, hw * 1.6, d);
          w *= 1 + 220 * bd * bd; // bed dominance: on-bed snaps to its road
          wSum += w; weSum += w * E;
          if (w > wMax) wMax = w;
          if (d2 < dMin2) { dMin2 = d2; nearW = hw; nearT = this._rt[i]; }
        }
      }
    }
    if (wSum <= 0) return h;
    const roadE = weSum / wSum;
    // SATURATING blend — continuous EVERYWHERE by construction (every
    // weight is a continuous function of position). On a bed the weight
    // is >~ 220 => blend ~ 0.9995; at any fade edge it goes to 0.
    //
    // Chapter 6: the apron reach is bounded (see ROAD_FADE_MAX) so a bed
    // perched on a ridge can no longer drag the valley floor 200 m away
    // up with it — those fill pedestals, not the terrain itself, built
    // the last near-vertical walls in the playable world. Their real fix
    // is upstream: spline beds are relaxed onto the ground and the pass
    // walker stops as soon as it starts flying (see _walkSwitchbacks).
    const blend = wSum / (wSum + 0.12);
    h += (roadE - h) * blend;
    const dMin = Math.sqrt(dMin2);
    const bed = 1 - sstep(nearW * 0.8, nearW * 1.9, dMin);
    if (bed > L.road) { L.road = bed; L.roadType = nearT; }
    return h;
  }

  // ---- 6. Viewpoints (computed ON the road network) --------------------------

  initViewpoints(raw) {
    const best = new Map();
    for (let i = 0; i < this._rx.length; i += 4) {
      const x = this._rx[i], z = this._rz[i], e = this._re[i];
      if (x < 150 || x > WORLD_W - 150 || z < 150 || z > WORLD_H - 150) continue;
      let drop = 0;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const d = e - raw(x + Math.cos(th) * 90, z + Math.sin(th) * 90);
        if (d > drop) drop = d;
      }
      if (drop < 22) continue;
      const key = `${Math.floor(x / 600)},${Math.floor(z / 600)}`;
      const cur = best.get(key);
      if (!cur || drop > cur.score) best.set(key, { score: drop, i });
    }
    const arr = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 14);
    const computed = arr.map((v) => ({
      x: this._rx[v.i], z: this._rz[v.i], e: this._re[v.i],
      drop: +v.score.toFixed(0),
      type: this._rt[v.i] === 1 ? 'main' : 'pass',
    }));
    // Chapter 5A: the six MAJOR viewpoints are authored on the new
    // landforms (ridge crests, a plateau rim, a lake shoulder). They are
    // furnished exactly like the computed ones, and any computed
    // viewpoint that lands on top of one is dropped so a spot never gets
    // two lookout platforms.
    const major = MAJOR_VIEWPOINTS.map((m) => {
      let drop = 0;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const dd = raw(m.x, m.z) - raw(m.x + Math.cos(th) * 110, m.z + Math.sin(th) * 110);
        if (dd > drop) drop = dd;
      }
      return { name: m.name, x: m.x, z: m.z, e: raw(m.x, m.z), drop: +drop.toFixed(0), type: 'major' };
    });
    const keep = computed.filter((c) =>
      !major.some((m) => Math.hypot(c.x - m.x, c.z - m.z) < 260));
    this.viewpoints = major.concat(keep).map((v, n) => ({
      id: `VP${String(n + 1).padStart(2, '0')}`, ...v,
    }));
    this.majorViewpoints = this.viewpoints.filter((v) => v.type === 'major');
  }

  nearestViewpoint(x, z) {
    let best = null, bd = Infinity;
    for (const v of this.viewpoints) {
      const d = Math.hypot(x - v.x, z - v.z);
      if (d < bd) { bd = d; best = v; }
    }
    return best ? { ...best, dist: +bd.toFixed(0) } : null;
  }

  /** Nth vertex of a pass road's first flank (tests/debug). */
  /**
   * Nth vertex of a pass road, from the saddle down its MAIN flank.
   * (Chapter 6: it used to always read the first flank's road id, so a
   * pass whose first flank is short — the Eagle Pass, hemmed in by its
   * own approach road — looked like a two-point stub to anything reading
   * the pass geometry, including the CI pass-climb ride.)
   */
  passPoint(pi, n) {
    const p = this.passes[pi];
    let pts = p._pts;
    if (!pts) {
      const collect = (rid) => {
        const out = [];
        for (let i = 0; i < this._rx.length; i++) {
          if (this._rid[i] !== rid) continue;
          out.push({ x: this._rx[i], z: this._rz[i], e: this._re[i] });
        }
        return out;
      };
      const ids = p.flankIds || [p.roadId];
      const a = collect(ids[0]);
      const b = ids[1] ? collect(ids[1]) : [];
      // The pass IS its main flank: saddle -> foot down the longer side.
      pts = b.length > a.length ? b : a;
      p._pts = pts;
    }
    return n < pts.length ? pts[n] : null;
  }

  /** Nearest peak whose massif contains (x,z), or null (F3 overlay). */
  peakAt(x, z) {
    let best = null, bestD = Infinity;
    for (const p of this.peaks) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.w * SKIRT_W && d < bestD) { bestD = d; best = p; }
    }
    return best ? { ...best, chain: best.range } : null;
  }
}

// ---- helpers ----------------------------------------------------------------

/**
 * Nearest point on a segment. Chapter 5: the result is written into the
 * shared _SN scratch instead of a fresh object — this is called ~60x per
 * terrain sample (millions of times per tile window), and the per-call
 * object was the biggest source of garbage in the whole engine, i.e. of
 * the GC pauses that showed up as random frame drops while riding.
 */
const _SN = { t: 0, d2: 0 };
function segNearest(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  _SN.t = t; _SN.d2 = dx * dx + dz * dz;
  return _SN;
}

function ridgeBBox(r) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of r.pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
  }
  return [x0 - r.w, x1 + r.w, z0 - r.w, z1 + r.w];
}

function rangeBBox(r) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, m = 0;
  for (const n of r.nodes) {
    x0 = Math.min(x0, n[0]); x1 = Math.max(x1, n[0]);
    z0 = Math.min(z0, n[1]); z1 = Math.max(z1, n[1]);
    m = Math.max(m, n[3] * SKIRT_W + 320);
  }
  return [x0 - m, x1 + m, z0 - m, z1 + m];
}
