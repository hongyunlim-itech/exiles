# Exiles — Architecture & Game Design Spec

A Banished-inspired survival city builder that runs in the browser: **TypeScript + three.js + Vite**, no other runtime
deps. `npm run dev` (port 5173), `npm run build`, `npm test` (vitest, headless sim tests), `npm run typecheck`.
Public online rooms run on Cloudflare (§10): `npm run cf:dev` (http://localhost:8787), `npm run cf:deploy`,
`npm run typecheck:cloud`.

This document is the single source of truth for every module author. Read it fully before writing code.

---------------------------------------------------------------------------------------------------------------------

## 1. Module ownership (who may edit what)

| Area | Files | Owner |
|---|---|---|
| **Contract** (read-only for everyone) | `src/core/types.ts`, `src/core/app.ts`, `src/core/events.ts`, `src/core/rng.ts`, `src/core/world.ts`, `src/render/types.ts`, `src/net/types.ts`, `src/net/transport.ts` (signatures) | architect |
| Tunable content | `src/core/defs.ts`, `src/core/constants.ts` | sim-core may tune numbers (no renames/removals); others read-only |
| App bootstrap | `src/main.ts`, `index.html`, `src/net/driver.ts` (DOM-free co-op glue of main.ts) | architect / integration |
| Co-op | `src/net/**` (session, commands, protocol, hash, snapshot, transports) — see §9 | **net-core** |
| Public-room relay | `cloud/**` (room-core.ts: pure room logic + wire protocol; worker.ts: Worker + Durable Object), `wrangler.jsonc` — see §10 | **net-core** |
| Simulation core | `src/sim/game.ts` + any new `src/sim/core/*.ts` (time, citizens, behavior, jobs, storage, buildings, farming…) | **sim-core** |
| World | `src/sim/worldgen.ts`, `src/sim/pathfinding.ts`, `src/sim/nature.ts`, `src/sim/save.ts` (+ `src/sim/world/*.ts`) | **sim-world** |
| Sim extensions | `src/sim/disasters.ts`, `src/sim/trade.ts`, `src/sim/nomads.ts`, `src/sim/wellbeing.ts`, `src/sim/stats.ts` (+ `src/sim/ext/*.ts`) | **sim-ext** |
| Scene | `src/render/renderer.ts`, `camera.ts`, `terrain.ts`, `water.ts`, `sky.ts` (+ `src/render/scene/*.ts`) | **render-scene** |
| Building models | `src/render/models/**`, `src/render/buildings.ts` | **render-models** |
| Entities & FX | `src/render/nature.ts`, `citizens.ts`, `animals.ts`, `crops.ts`, `effects.ts` (+ `src/render/entities/*.ts`) | **render-entities** |
| UI | `src/ui/**` (incl. CSS) | **ui** |
| Input & audio | `src/input/**`, `src/audio/**` | **input** |
| Tests | `tests/<owner>.*.test.ts` (e.g. `tests/simworld.pathfinding.test.ts`) | each owner their own prefix |
| Dev sandboxes | `dev/<owner>/*` (extra HTML entry pages + scripts for visual self-checks; not shipped) | each owner their own folder |

Rules:
1. **Never edit files you don't own.** If you need something from another module that isn't in its public API, work
   around it inside your own files and list the request in your final report.
2. **Public APIs in stub files are fixed** (class names, method signatures, constructor args). You may ADD methods,
   fields and new files within your area. Keep all exported names from the stubs.
3. Contract types may only be extended by the architect. If you absolutely need extra per-entity data, keep it in your
   own module (e.g. a `WeakMap`/`Map` keyed by id, or inside the opaque `Citizen.task` / `Animal.wander` fields you own).
   Anything that must survive save/load must live in GameState — ask in your report.
4. `npx tsc --noEmit` must report **zero errors in your files**. Other agents are editing their files concurrently, so
   errors in files you don't own may appear transiently — ignore them. Filter with e.g.
   `npx tsc --noEmit 2>&1 | grep "src/render/terrain"`.
5. No new npm dependencies. three.js (`three`, `three/examples/jsm/...` → import from `three/addons/...`) is available.
6. Sim code (`src/sim/**`, `src/core/**`) must NOT import three.js or touch the DOM — it runs headless in vitest.
7. Everything must work with `isolatedModules` + `verbatimModuleSyntax`: use `import type` for type-only imports.
   Do not use `const enum`.
8. Performance matters: this must hold 60 fps on a mid-range laptop with ~200 citizens and ~10k trees.

## 2. Coordinates & conventions

- Map `W × H` tiles (small 128, medium 160, large 208). Tile index `i = z * W + x`.
- 1 tile = 1 world unit. Tile `(x, z)` spans `[x, x+1] × [z, z+1]`, center `(x+0.5, z+0.5)`. Y up.
- Terrain heights live on tile **corners**: `tiles.height[z * (W+1) + x]`. Use `heightAt(state, wx, wz)` for the ground
  height under any continuous point; `tileHeight` for a tile's average.
- Water surface at `WATER_LEVEL` (0). Water tiles are below it; land above. Mountains are high & impassable.
- Buildings: footprint `[x, x+w) × [z, z+h)` (w, h already rotated). `rotation` 0..3 = door faces +Z, −X, −Z, +X.
  Door tile from `computeDoor` (outside the footprint; inside for walkable zones).
  Model space: origin at footprint center, door toward +Z, unrotated dims; place with
  `position = (b.x + b.w/2, ground, b.z + b.h/2)` and `rotation.y = rotationAngle(b.rotation)`.
  For rotation 1/3 the unrotated dims are `(b.h, b.w)`.
- Citizens/animals positions are continuous world coords `(x, z)`; y = `heightAt(x, z)` (or bridge deck height on
  bridges: WATER_LEVEL + 0.25).
- Revision counters `state.rev.{terrain,features,roads,buildings,fields}` are bumped by the sim whenever that data
  changes. Renderers compare with the last seen value to rebuild lazily (throttle heavy rebuilds to a few Hz).
- Game time unit: game seconds. `MONTH_SECONDS = 60`, 12 months/year, day/night cycle every `DAY_SECONDS = 24`.
  `Game.speed` ∈ {0,1,2,5,10}. `Game.update(realDt)` → `gameDt = min(realDt, 0.1) * speed`, split into sub-steps
  ≤ `MAX_SIM_STEP`, each calling `step(dt)`. Nobody calls `Game.update` directly any more: main.ts drives the game
  through `NetSession.update(realDt)` (solo/lobby → `Game.update`; co-op → fixed `NET_STEP` lockstep ticks, §9).
- Every player mutation of the town goes through `AppContext.dispatch(cmd)` (a `Command`, `src/net/types.ts`), never
  through Game mutators — solo applies it at once, co-op routes it through the lockstep session (§9).
- Debug handle in the browser: `window.__app` (AppContext) → `__app.game.state`, `__app.setSpeed(10)`, `__app.net`
  (co-op session: `status()`, `players()`, `stats`), `__app.debug.*` (fire, tornado, merchant… — local only, so in
  co-op they desync this peer on purpose, which is a handy resync test).

## 3. Simulation design (Banished rules, adapted)

### 3.1 Step order — `Game.step(dt)` (sim-core implements; calls other owners' functions)
1. time & weather (sim-core) — clock, month/season/year, temperature, precipitation, snow cover, wind; emits
   `seasonChanged`/`yearChanged`; at new year rotate `producedThisYear → producedLastYear`.
2. `updateNature(game, dt)` (sim-world) — sapling growth, slow forest spread, deer herds wander & breed.
3. buildings (sim-core) — construction completion, house heating/firewood burn, crop/orchard growth & frost, pasture
   breeding/products, `smoking` flags.
4. citizens lifecycle (sim-core) — hunger, warmth, aging, coming of age, marriage & housing, births, old-age deaths,
   tool/coat wear, accidents.
5. job assignment (sim-core, ~1 Hz) — builders count, workplace workers, students.
6. behavior (sim-core) — every citizen's task state machine & movement; resets and recounts `Building.fireFighters`.
7. `updateWellbeing(game, dt)` (sim-ext) — health, happiness, education, disease, graves/unburied, grief decay.
8. `updateDisasters(game, dt)` (sim-ext) — fire ignite/spread/extinguish/destroy, tornado, disease outbreaks.
9. `updateTrade(game, dt)`, `updateNomads(game, dt)` (sim-ext).
10. `updateStats(game, dt)` (sim-ext) — monthly `history` samples, advisor warnings via `game.addMessage`.

### 3.2 Citizen field ownership
- sim-core writes: `age, food, warmth, dietMask, dietTimers, toolWear, coatWear, homeId, workplaceId, profession,
  spouseId, childIds, x, z, heading, moving, activity, taskLabel, carrying, task, path, pathIndex, starveTime,
  freezeTime, grief (set to 100 on relatives at death)`.
- sim-ext writes ONLY: `health, happiness, education, sick` (and decays `grief`).
- Nobody else writes citizen fields. Render/UI read only (never read `task`/`path`).
- Deaths: `game.killCitizen(id, cause)` (sim-core) — the only way to remove a citizen. sim-core triggers old age,
  accidents; sim-ext triggers when `health` reaches 0 (cause: `starvation` if food≈0, `freezing` if warmth≈0,
  `disease` if sick, else `oldAge`), fire/tornado deaths.

### 3.3 Needs (sim-core)
- **Food**: `food` drops at `HUNGER_RATE`; below `HUNGER_THRESHOLD` the citizen goes home and eats `MEAL_SIZE` from the
  house inventory (else from the nearest market/barn with food, eating on the spot). Hunger becomes URGENT
  (`hungerIsUrgent`) below `URGENT_FOOD` (15), or below 42 when the food left would not last 1.25 × the walk to the
  nearest meal + 12 s: the citizen then interrupts non-need work (household supply trips only below 7.5), keeps what it
  carries (deposited after eating), eats before depositing, and eats where food is nearest (a closer barn beats a far
  home; food in hand is eaten on the spot). Meal composition maximises
  variety: prefer food groups whose `dietTimers` are lowest; eating a group sets its timer to 3 months; `dietMask` bits
  = groups with timer > 0 (protein 1, grain 2, vegetable 4, fruit 8). No food anywhere → `starveTime` accumulates.
- **Warmth**: outdoors when temperature < `COLD_TEMP`, warmth drops proportionally to the cold (coat ×0.4). Below 40 in
  cold weather → go home to warm up (fast if the house has firewood/is heated, slow otherwise). Warm weather restores.
- **Household supply**: houses keep `HOUSE_FOOD_TARGET` food (mixed types), `HOUSE_FIREWOOD_TARGET` firewood and ~5
  herbs. One adult resident at a time fetches from the nearest market (if the house is within the market radius) or
  storage. Houses burn `FIREWOOD_BURN_RATE × heatEfficiency` firewood/s while temperature < `COLD_TEMP`
  (`smoking = true` while burning).
- **Tools**: workers with `toolWear == 0` fetch a tool from storage (sets `toolWear = TOOL_LIFETIME`); tools wear only
  while working. Without a tool work speed ×0.5. **Coats**: same with `COAT_LIFETIME`, wear only in cold weather.
- **Work efficiency** = `wellbeingEfficiency(c)` (sim-ext) × (tool ? 1 : 0.5) × (elderly ? 0.7 : 1).

### 3.4 Lifecycle (sim-core)
- Children `< ADULT_AGE` (10) play near home. At 10: if a school with a teacher covers their home → `student` until
  `STUDENT_GRADUATE_AGE` (14), studying at the school during daytime (`activity = 'studying'`, sim-ext raises education),
  else become `laborer`.
- Marriage/housing (every few seconds, `sim/core/households.ts`): from `MARRY_AGE` (14) young adults may leave their
  parents' home. An empty family house gets a couple (single, unrelated M + F adults ≥ `MARRY_AGE`, preferably those
  still living with parents or homeless) — or one young adult claims it alone and is joined by a partner later; else a
  homeless family/individual moves in. Boarding houses take single adults; orphans are taken in by another household.
  Population growth therefore follows the housing supply.
- Births: married couple living together in a family home, woman `FERTILE_MIN`–`FERTILE_MAX` (16–45), fewer than
  `MAX_CHILDREN_PER_HOUSE` (5) children there → chance `BIRTH_RATE` (≈ 1/year) × happiness factor × food factor (×0.25
  when the mother is starving or ill); 0.4 % childbirth death risk. New child spawns at the house (age 0),
  `citizenBorn` event, tally.
- Old age: `age ≥ lifespan` → death. Elderly (≥60) work at 70%.
- `killCitizen`: removes from home/workplace/spouse links, sets `grief = 100` on living spouse/children/parents, uses a
  free cemetery grave (`graves++`) else `state.unburied++`, emits `citizenDied` + message, tallies.
- Game over when population hits 0 (`gameOver = true`, `gameOver` event).

### 3.5 Jobs (sim-core)
- Laborers = unassigned adults. `buildersDesired` builders are taken from laborers; workplace `workersDesired` filled
  from laborers (prefer laborers living nearest). Reducing a count releases workers back to laborers.
- **Laborer tasks** (job board with reservations so two people never take the same job): clear marked
  trees/rocks/iron (tree: chop `WORK_TIME_CHOP` → `LOGS_PER_TREE` logs; rock/iron: carry up to `CARRY_CAPACITY` units
  per trip until depleted), haul workplace output buffers to storage, deliver construction materials, demolish/clear
  ruins. Idle laborers loiter near storage.
- **Builders** deliver materials and build: construction progress cap = fraction of materials delivered; work speed ×
  efficiency; emits `sound: hammer`. When nothing to build they act as laborers.
- **Storage**: stockpiles hold `stockpile` resources, barns hold `barn` resources, markets/trading posts hold both.
  Capacity = def capacity (× tiles if `perTile`). Reservations: `reservedIn` (capacity promised) and `reservedOut`
  (items promised) prevent over-commit. `resourceTotals()` sums stockpiles, barns, markets and trading posts.
- **Workplaces** (worker behaviour per type):
  - *Gatherer*: walk to a random mature tree tile in radius, `gathering` ~8 s, yield berries/mushrooms/roots (≈5 ×
    efficiency × forest density), nothing in winter; return and deposit to hut buffer; haul buffer to barn when ≥ half.
  - *Hunter*: reserve a deer in radius (`Animal.huntedBy`), walk to it, `hunting` 5 s, `removeAnimal`, venison ~10 +
    leather 2.
  - *Fisherman*: walk to a shore tile in radius, `fishing` ~12 s, fish ≈5 × efficiency × water density; all seasons.
  - *Forester*: plant saplings (`Feature.Tree`, amount 0.05) on free grass tiles in radius; cut trees with growth ≥ 1
    (keep some density) → logs.
  - *Herbalist*: like gatherer, yields herbs (~3), not in winter.
  - *Workshops* (woodcutter/blacksmith/tailor/brewery): fetch recipe inputs from storage into the building, `working`
    for `recipe.seconds / efficiency`, outputs into the buffer, haul outputs to storage when ≥ threshold. `recipe`
    −1/undefined = auto (first recipe whose inputs are in stock). `smoking` while working.
  - *Quarry*: `mining` ~20 s → 4 stone (10%: +1 iron). *Mine*: ~20 s → 3 iron + 1 stone; accident risk (death).
  - *Crop field*: Early/Mid spring: plow & plant tiles (stage 0/4 → 2); crops grow in the buildings step
    (`growMonths`, slower with too few farmers, stalls below 3°C); ripe (stage 3) tiles harvested → buffer. First
    frost (temperature < 0 in autumn/winter) kills unharvested crops (message). Winter: farmers haul / idle.
  - *Orchard*: trees mature over `matureYears`; fruit ripens by late summer/autumn; harvested per tile like fields.
  - *Pasture*: livestock breed toward capacity (`w*h/tilesPerAnimal`); herders slaughter when > 60% capacity (meat;
    cattle also leather), collect products (wool in summer, eggs spring–autumn). Starts with 2 animals of the chosen
    unlocked type; nothing without an unlocked livestock type.
  - *Market vendors*: keep the market stocked (food, firewood, tools, coats, herbs, ale) from barns/stockpiles.
  - *Teacher/healer/priest/tavernkeeper/trader*: stay at the building (`working`/`healing`/`praying`), healer keeps
    herbs stocked, tavernkeeper keeps ale stocked (from storage).
- **Fire fighting**: when a building burns and a well covers it, adults within ~25 tiles run to it (`firefighting`),
  and each increments `fireFighters` of that building every step.
- Emit `sound` events for chop/hammer/dig/splash, throttled (≤ ~4/s globally).

### 3.6 Buildings & placement (sim-core)
- `checkPlacement` rules: all footprint tiles `isTileBuildable` (land, flat enough, no building/road), within map.
  `placement: 'shore'` → some footprint tiles may be shallow/deep water (at least ~25% water, ≥ ~40% land, door on land).
  `placement: 'mountain'` → at least one tile adjacent to the footprint is Mountain. Door tile must be walkable land.
  Trees/rocks/iron in the footprint are allowed; they are returned in `clearing` and auto-marked on placement.
  Zones: size within `resizable.min..max`.
- Placement flattens corner heights under non-zone footprints (average) and bumps `rev.terrain`.
- States: `clearing` (until footprint features removed) → `construction` (`buildWork == 0` completes immediately when
  materials delivered) → `active`. `demolish`: construction → cancel & refund delivered to storage; active →
  `demolishing` (laborers work, 50% materials returned) → removed.
- Roads: dirt roads are instant and free; stone roads cost 1 stone/tile (taken from storage immediately; skip tiles you
  can't afford); roads on shallow water become `Road.Bridge` (cost from `ROAD_DEFS.bridge`); recompute regions.

### 3.7 Time, weather, seasons (sim-core)
- Temperature = `MONTH_TEMPERATURE[month]` (interpolated) + `CLIMATE_OFFSET[climate]` + slow noise (±3) + day/night
  swing (±2). Precipitation: rain in warm months, snow when < 0 °C. Snow cover rises while snowing / below 0, melts
  above 2 °C. Wind slowly varies.
- Start: Year 1, Early Spring (month 0), dayTime 0.3.

### 3.8 Wellbeing (sim-ext)
- Health drifts toward a target: base 70; diet variety (# groups: 1 → −15, 2 → 0, 3 → +10, 4 → +20); herbs at home
  (+8, occasionally consumed); well within radius of home (+5); hospital with healer & herbs within radius (+cures);
  cold (warmth < 30: −), starving (food < 10: strong −); elderly (−10). Health 0 → death.
- Disease: `sick` 0..1; untreated sick lose health; spreads within households and to neighbours; hospital cures using
  herbs; herbs at home reduce infection chance.
- Happiness drifts toward: base 50; chapel with priest in range +15; tavern with ale in range +15; food variety (+0..10);
  coat +5; stone house +5, boarding house −10; homeless −25; grief −(grief × 0.3); unburied dead −10 (town-wide);
  well +3. Efficiency multiplier `wellbeingEfficiency(c) ≈ 0.6 + 0.4·happiness/100 + 0.25·education`, ×0.7 if health<30.
- Education: +1 per ~4 years of studying (activity `studying` at a school with a teacher).
- Cemetery: move `unburied` into free graves over time.

### 3.9 Disasters, trade, nomads, stats (sim-ext; only when `settings.disasters` for disasters)
- **Fire**: rare random ignition (≈0.4%/building/year; ×3 workshops with fire, ×2 summer; ×0.3 if a well covers it).
  `fire` grows to 1 in ~60 s; fireFighters with a well in range reduce it; at 1 for ~20 s → `removeBuilding(id,'fire')`.
  Burning buildings (>0.5) may ignite neighbours within 3 tiles. Messages + `fireStarted` + `sound: bell`.
- **Tornado**: very rare (summer), crosses the map (`state.tornado`), destroys buildings/trees it touches, may kill.
- **Disease outbreaks**: occasional, more likely after merchants/nomads arrive.
- **Trade**: active trading post with a trader → merchants arrive every ~4–8 months outside winter, stay 2 months.
  Kinds: food, goods, livestock (unlocks), seeds (crop/orchard unlocks), general. `executeTrade` barters: value of
  `give` (def value, taken from storage) must cover `take` (offer price); bought goods go into the trading post (or
  storage); unlocks append to `state.unlocked`. `requestMerchant` sets the preferred kind.
- **Nomads**: with an active Town Hall, every ~1–2 years a group (3–12) may arrive (`state.nomads`, expires in 1
  month). Accept → `spawnCitizen` adults near the town hall (homeless, possible disease). Messages.
- **Stats**: a `StatsSample` each month into `history` (cap 600). Advisors (cooldown ≥ 2 months each): food < ~2 months
  of consumption, low firewood before/during winter, homeless families, no tools, construction waiting on builders or
  materials, storage full, no graves. "X people are starving — put more workers on food" only fires when town food
  (storage + homes + workplace buffers) is under 2 months; with food in town, hungry citizens raise `hungryWithFood`
  instead (names the food amount, suggests a Storage Barn / Market nearer homes and workplaces, plus roads).

### 3.10 Starting conditions (sim-core `Game.create`)
| | families | pre-built | supplies (approx) | unlocked |
|---|---|---|---|---|
| easy | 7 (+ kids) | stockpile, storage barn, 4 wooden houses | food 900, firewood 300, logs 200, stone 100, iron 60, tools 40, coats 30, herbs 30 | wheat, corn, beans, potato; apple, pear; chicken, sheep |
| medium | 5 | stockpile, storage barn | food 600, firewood 200, logs 150, stone 60, iron 30, tools 25, coats 20, herbs 20 | wheat, beans; apple; chicken |
| hard | 3 | small stockpile, storage barn | food 350, firewood 100, logs 80, stone 30, iron 10, tools 12, coats 10 | wheat |
Camera starts focused on the start location. The world is generated so the start is on open flat grass with forest,
stone, iron and water within ~30 tiles.

## 4. World generation & pathfinding (sim-world)
- Deterministic from `settings.seed`. Styles: `valleys` (rolling hills, a river, mountain ridges at edges),
  `mountains` (more/higher mountains, narrower buildable land), `lakes` (several lakes, fewer mountains).
- Layers: heightmap (fBm value/simplex noise) → mountains (steep, impassable, rocky) → river (winding shallow `Water`,
  3–6 wide, crossing the map; carve heights below WATER_LEVEL) and lakes (`DeepWater` centers with `Water` rims) →
  sand beaches next to water → forests (noise-clustered; conifers near mountains, deciduous/birch elsewhere, growth
  0.6–1.0 with some saplings) → rocks & iron deposits (clusters, iron nearer mountains; amounts 10–40) → deer herds
  (4–10 herds of 3–7 in forests) → `computeRegions`. Keep a clear ~24×24 flat grass area at the start (few trees).
  Map borders: mountains/terrain rise near edges so the world looks bounded.
- Pathfinding: A* (binary heap, typed arrays reused between searches, octile heuristic, 8-neighbour, no diagonal
  corner cutting), costs from `tileCost` (roads faster, forest slower). Buildings block except walkable zones; the goal
  may be a blocked tile (door semantics: path to an adjacent walkable tile when `adjacent`). Must handle ~50 searches/s
  on a 208² map without frame drops (budget ~1–2 ms each typical).
- Nature: sapling growth `TREE_GROWTH_RATE`; rare natural spread next to mature trees (keeps forests alive); deer herds
  wander within forests, avoid water/mountains/buildings, breed slowly up to a cap; `huntedBy ≥ 0` → stand still.
- Save: `serializeState`/`deserializeState` — compact (RLE for Uint8 arrays, base64 for float arrays, omit
  `building`/`region` and rebuild), versioned (`SAVE_VERSION`), validation with clear errors.

## 5. Rendering (render-scene, render-models, render-entities)

**Look**: Banished-like low-poly, flat-shaded, warm & slightly desaturated palette, soft shadows, atmospheric fog.
Grass `#6f8f45`→ autumn `#9a8a45` → winter snow `#e8eef2`; soil `#6b5236`; dirt road `#8a7050`; stone road `#8e8b84`;
sand `#c9b98a`; water deep `#2d5566` shallow `#4f7f86`; mountains grey-brown `#7d766c` with snow caps. Wooden
buildings: timber `#7a5534`, plaster `#d8cfb8`, thatch roofs `#9c7d45`, stone `#a19d94`, shingle roofs `#5d4636`.
Use `MeshLambertMaterial`/`MeshStandardMaterial` with `flatShading: true`; ACES filmic tone mapping; sRGB output.

**Scale**: citizen ~0.55 tall; wooden house (3×3) walls ~1.1 high, roof ridge ~2.1; barn ~2.8 high; chapel spire ~5;
mature trees 1.8–3.5 tall (conifers taller); rocks 0.3–0.7.

**Performance**: InstancedMesh for trees, rocks, crops, citizens, animals, particles. Share geometries/materials
between building instances (cache per type/part). Avoid per-frame allocations. Heavy rebuilds only on rev changes,
throttled. Shadows: one directional light, shadow camera follows camera focus (~60–90 unit box), map 2048 (high) /
1024 (medium) / off (low). Target ≤ ~400 draw calls. The render/app performance pass (`render/scene/perf.ts`, unit
tested in `tests/render.perf.test.ts`) adds:
- **Quality `auto`** (the default; old stored 'high' settings migrate to it, `migrateSettings`): the tier comes from the
  unmasked WebGL renderer string (`classifyGpu`: software → low, integrated/mobile → medium, discrete → high; MSAA off
  only for low). Pixel-ratio caps per tier: high min(dpr, 1.5), medium 1, low 0.75.
- **Dynamic resolution** (auto only): `DynamicResolution` smooths the frame interval fed by the main loop
  (`renderer.reportFrame`) and steps the render scale 0.6–1 (down after 1.5 s over budget, up slowly after 5 s of
  headroom; CPU-bound frames never lower it). Idle frames are not reported.
- **Frame cap** (`AppSettings.fpsCap` 30 / 60 / 0 = display refresh) via `FramePacer` (keeps the phase on high-refresh
  displays). **Idle ≤ 30 fps**: menu open, or paused / game over with a still camera and no input for 1 s
  (`effectiveFpsCap`); any input wakes the loop at once. The sim advances by real elapsed time, so skipped refreshes
  never change the game speed. Joining a co-op town never idles.
- **LOD**: trees have 3 LODs (full / reduced / far 16–26 tris; distances per tier `natureLodFor`), per-instance
  frustum culling; trees beyond lod1 cast no shadows; small props (citizens, animals, low crops) cast shadows only
  when the camera is close (`smallPropShadows`, with hysteresis).
- **On-demand shadows**: `shadowMap.autoUpdate = false`; the shadow map is re-rendered every frame while the view moves
  fast, ≤ 30 Hz while the game runs or the view drifts, and only on world changes (or every 0.5 s) when static.
  Shadow casters are culled by shadow footprint (`scene/shadowCasters.ts`).
- The co-op layer `remotePlayers` (other players' cursors, name labels, tinted ghosts; §9) is a SubRenderer added after
  effects; no shadows, polled at 20 Hz.

- **render-scene**: `GameRenderer` creates renderer (antialias, shadows PCFSoft), scene, camera (fov 45), the sub
  renderers (constructor order: sky, terrain, water, nature, crops, buildings, animals, citizens, effects — effects
  takes the BuildingRenderer), `overlayGroup`, and builds a `FrameContext` each frame. Terrain = per-tile quads (4
  unique verts per tile so tiles can have their own colours) using the shared corner heights; flat shading; vertex
  colours per tile (terrain type, roads, soil under fields/orchards/pastures, packed earth under buildings/stockpiles,
  cemetery grass), seasonal tint + snow blend (update colours on rev changes & when snow/season changes noticeably),
  optional grid lines (shader or line mesh). Heightfield ray-march picking. Camera: orbit around target, clamp pitch
  (~25°–80°) & distance (8–120), keep target on terrain & inside the map, smooth damping. Sky: gradient background,
  fog colour by time of day/season, sun direction animated by `dayTime` (night is dim blue, never pitch black),
  hemisphere light. Water: large plane(s) at WATER_LEVEL covering water tiles with a vertex/fragment shader for gentle
  waves & colour; slightly transparent at shores.
- **render-models**: A distinct, recognisable model for EVERY building type (see defs): houses with chimneys,
  barn with big doors, stockpile (flat packed-earth pad with piles whose size reflects inventory by resource colour),
  fields (fenced edge posts only — crops are drawn by CropRenderer), orchard (low fence), pasture (fence ring & gate),
  cemetery (low stone wall + headstones by `graves`), quarry (stepped pit with stone blocks), mine (tunnel entrance
  timber frame against the hill + cart), fishing dock (wooden pier over water), trading post (pier + warehouse),
  market (stalls with awnings), chapel (spire), school, hospital (red cross flag), tavern (sign), town hall (clock),
  well (round stone + roof), blacksmith (anvil + forge chimney), etc. Construction stage visuals: `clearing` → stakes
  & string outline; `construction` → foundation + scaffolding + model revealed bottom-up by `progress`; `ruin` →
  charred remains. Snow on roofs by `weather.snow`. Burning → darken/char tint by `fire`. Bridges: wooden deck +
  posts on `Road.Bridge` tiles (rebuild on `rev.roads`). Merchant boat moored at the trading post when
  `trade.merchant` is present (`arrive` animates in). Selection highlight (emissive tint or outline ring).
- **render-entities**: trees (3 species, growth-scaled, deterministic jitter from `hash2`, autumn colours for
  deciduous, bare in winter, snow tint), rocks (grey) and iron (rusty/dark with orange flecks), marked features show a
  small red/orange marker or tint; crops per field tile (young→ripe colour, height by growth; stubble when
  harvested); orchard trees per ~2×2 tiles (blossoms in spring, fruit dots late summer/autumn); citizens (body/head/
  legs/arms, tunic by profession colour, women with skirt shape, children 0.65 scale, elderly slightly bent; walk
  cycle when `moving`; chopping/mining/hammering/farming arm swings by activity; carried item block coloured by
  resource; sick = pale), deer (walk/graze), livestock inside pastures (count from state), smoke puffs from chimneys
  (drift with wind), fire flames + embers + flickering light, snowfall & rain near the camera, tornado funnel.

## 6. UI (ui) — Banished-like, polished
- Visual style: dark wood/leather translucent panels (`rgba(28,22,16,.88)`), parchment highlights (`#e8dcc0`), gold
  accents (`#c9a45c`), serif headings (Google Font "Cinzel" + "Alegreya Sans" with Georgia/system fallbacks), emoji
  icons from defs, subtle shadows, compact but readable (13–14px), smooth hover states.
- Layout: **top bar** (town name, year & month name, season icon, temperature; key resources with icons: food total,
  firewood, logs, stone, iron, tools, coats, herbs; population adult/student/child; speed buttons ⏸ 1× 2× 5× 10×;
  menu ☰). **Bottom toolbar**: build categories → flyout grid of buildings (icon, name, cost, disabled if unaffordable
  with tooltip); tools: Roads (dirt/stone), Remove road, Clear (all/trees/stone/iron), Unclear, Demolish.
  **Selection panel** (right): building — name, state & progress bar, materials delivered/needed, workers
  desired/assigned with −/+, residents list (click → select citizen), inventory, produced this/last year, crop/orchard/
  livestock selector (only unlocked), recipe selector, pause/priority/demolish buttons, work-radius note; citizen —
  name, age, profession, health/happiness/food/warmth/education bars with factor tooltips (`happinessFactors`,
  `healthFactors`), home/workplace links, family, current task, carrying. **Windows** (toggle buttons + hotkeys):
  Professions (P) — every profession with count & −/+ for builders and per-workplace totals; Town Overview (O) —
  population breakdown & all resources by category, storage usage; Citizens (N) — sortable list; Event Log (L) —
  messages with severity colours & "go to" buttons; Statistics (K) — line charts (canvas) from `history`; Trade
  dialog when a merchant is present (select goods to give/take, value balance); Nomads dialog (accept/decline); Help (H).
  Toasts for new messages (warning/danger stay longer). Tooltip following the pointer for `hoverInfo`.
  **Main menu**: title "EXILES", New Game form (town name, seed w/ dice, map size, terrain, climate, difficulty,
  disasters), Load (saves list w/ delete), Settings (shadows, quality Auto/Low/Medium/High, frame rate 30/60/unlimited,
  volumes, edge scroll, autosave, FPS), Controls, Continue/Save (in game). Game-over overlay with stats. FPS counter
  when enabled. Co-op UI (players window J, chat bar Enter, net banner, menu co-op block, pending values): §9.6.
- `#ui` has `pointer-events: none`; interactive elements set `pointer-events: auto`. `isPointerOverUI()` must be
  accurate so canvas clicks aren't swallowed. Keyboard shortcuts ignored while typing in inputs.

## 7. Input & audio (input)
- Pointer: left = tool action / select; right-click (camera `rightDragMoved < 5`) = cancel tool / deselect; hover
  → `hoverInfo` event with tile description (terrain, feature + growth/amount, building name/state).
- Every tool action becomes a `Command` through `AppContext.dispatch` (§9.2): roads/remove-road are split into chunks of
  120 tiles (`input/geometry.ts chunkTiles`); a co-op result may be `pending` (no building id yet — BuildTool then
  refuses a second order on that footprint for 3 s). Each frame the input layer publishes cursor / camera / build
  ghost / tool label via `net.setLocalPresence` (`input/presence.ts`, quantised, allocation-free).
- Build: ghost via `createGhostModel`, snapped so the footprint is centred on the cursor tile, `R` rotates, validity
  from `game.checkPlacement` (recompute only when tile/rotation changes) with per-tile overlay (green ok, yellow
  clearing, red blocked), work-radius ring (and faint rings of existing same-type buildings), click places (tool stays
  active; `audio.playUi('place')`), invalid → `ui.toast(reason)` + error sound. Zones: drag a rectangle (min/max
  clamped, size label) — single click places default size.
- Roads: drag an L-shaped path; preview valid/blocked tiles; release → `game.placeRoad`. Remove road: drag rect.
- Clear/unclear: drag rect preview → `markForRemoval(filter)` / `unmarkRemoval`. Demolish: hover highlight, click →
  `ui.confirm` → `game.demolish`.
- Selected building → show its work radius ring.
- **Hotkeys** (single source of truth — nobody else binds these): camera (render-scene) W/A/S/D, arrows, Q/E rotate,
  =/− zoom, Home focus town; input: R rotate, Esc (cancel tool → deselect → open menu), Space pause toggle, 1/2/3/4
  speeds 1×/2×/5×/10×, C clear tool, V dirt road, G grid toggle, Delete demolish selected; ui: P, O, N, L, K, H, J
  (co-op players) windows, Enter (co-op chat bar, only while connected). UI modals capture Esc (keydown capture + `preventDefault`) while open; input ignores events with
  `defaultPrevented` and while typing in inputs.
- Audio: procedural WebAudio only (no files): ambient wind (louder in winter/when zoomed out), birds (spring/summer
  days), crickets (summer nights), river hush near water; event sounds (chop, hammer, dig, splash, bell, birth chime,
  death toll, build complete) attenuated by distance from the camera focus; UI clicks. Max ~8 concurrent voices.

## 8. Verification expectations
- Every agent: zero TS errors in own files; unit tests for pure logic you own; visual owners use a dev sandbox page
  (`dev/<owner>/index.html`, served by `npx vite --port <your port>`) with a mock/real state and headless Playwright
  (`playwright` is installed; launch chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`) to screenshot
  and inspect their own output. Use your assigned port only (see your task prompt).
- **Machine safety**: never run several headless browsers at once (it froze the dev PC before) — one browser at a time,
  and only when your task allows it. Run vitest with at most 2 workers (`npx vitest run --maxWorkers=2 <files>`); run
  only the relevant files while iterating, the full suite once at the end.
- Integration: `npm run typecheck`, `npm test`, `npm run build` all green; the game boots, a new game starts, and the
  town survives & grows for several simulated years under a sensible scripted build order.

## 9. Co-op (net-core: `src/net/**`; app glue: `src/main.ts` + `src/net/driver.ts`)

Several people viewing the published artifact build ONE town together. It rides on the Claude artifact `room`
capability (`vendor/claude-artifact-types/0.2.54/room.d.ts`): presence = one small latest-wins object per open tab
(≤ 4 KiB, shared ~30 Hz, handed to newcomers, cleared on leave; anyone may set it); events = moments on topics
(≤ 4 KiB, may be dropped, never replayed, admin-only by default, the room drops past ~40/s). Everything also works with
no room at all: solo play is exactly the single-player game.

### 9.1 Model — deterministic lockstep
- Every peer runs the same simulation in fixed ticks of `NET_STEP` = 0.25 game s (`src/net/types.ts`). Commands, not
  state, travel; the host's clock decides which tick each command applies at.
- **Modes** (`NetStatus.mode`): `solo` (no room: public link, signed out, `?net=off`, local dev without `?net=local`);
  `lobby` (room connected, this tab plays its own town locally — nobody hosts, or someone does and it has not joined);
  `host` (runs the shared town and broadcasts turns); `guest` (follows the host's town); `joining` (downloading the
  snapshot / catching up — also used for a resync).
- **Who may host**: admin viewers only (`user.canEdit()` = artifact owner/editors; events are admin-only). View-only
  members and outside guests follow and play fully — their commands and chat travel in their presence.
- **Host**: steps whole ticks from an accumulator at the shared speed (real dt per update ≤ 1 s: animation frames bring
  ≤ 0.1 s, a hidden tab's timer ~0.25 s, so a backgrounded host keeps real-time pace), CPU budget 8 ms per frame
  (40 ms for background ticks; the backlog is dropped when over budget, like solo). It applies its own commands and the
  guests' queued ones at its CURRENT tick (execution delay 0 — safe because guests never simulate past the last
  broadcast tick, which is never ahead of the host) and broadcasts turns at 5 Hz.
- **Guests** never step past the confirmed tick `k`; they apply command entries in seq order at their tick (also while
  paused), stay about one turn behind with a gentle rate controller, fast-forward when far behind or paused (8 ms per
  frame) and after a join (20 ms per frame), and report the first missing seq in presence (`f.a`) — the host re-sends
  from there.
- **Desync detection**: every `HASH_INTERVAL` (20) ticks each peer hashes the full sim state (`src/net/hash.ts`:
  rng, time, weather, tallies, every citizen / building / animal / tile array, quantised so NaN/±0/JSON noise cannot
  alarm; ~0.26 ms); turns carry the host's last two hashes; a mismatch → resync from a fresh snapshot (≥ 3 s apart).
- **Late join / resync**: the host saves (`Game.save`, ~12 ms), gzips it (CompressionStream) and sends base64 chunks;
  the joiner loads it, applies the command log since the snapshot and fast-forwards. One snapshot is shared by
  joiners within 10 s; missing chunks are re-requested after 1.5 s without progress.
- **Host vanishes** (tab closed / crashed: peer gone or its claim gone for 2.5 s while we are connected): the admin
  follower with a loaded town takes over — in-sync ones first, then the smallest peer label — after fast-forwarding
  to its confirmed tick; epoch + 1, base `[tick, nextSeq]`, re-issues its own unacked commands. Followers not ahead of
  the base continue, the others resync. With no admin to take over, guests show "Waiting for the host…" (speed 0)
  and automatically follow the next town an admin hosts.
- **Stop sharing** (host `leave()`): the host marks the town closed in its presence (`x`, 30 s); followers go to the
  lobby keeping their copy (no host election). **Host opens another town** (New Game / Load while hosting): guests
  follow it (new snapshot, full swap).
- **Two hosts**: same town → higher epoch wins; different towns → earliest `since` wins (tie → smaller peer); the loser
  joins the winner's town. The app therefore never hosts while `hostedTown()` reports someone else's town.

### 9.2 Commands (`src/net/commands.ts`) and dispatch results
- `Command` (`src/net/types.ts`): place, road, removeRoad, mark, unmark, demolish, workers, builders, crop, recipe,
  pause, priority, trade, requestMerchant, nomads, speed. `applyCommand` is THE place that mutates the Game for a
  player action; `sanitizeCommand` (pure: integer fields, enums, own-property building/crop/resource keys, ≤ 400 road
  tiles) runs on every peer, so a malformed command is rejected identically everywhere; `precheckCommand` (guests,
  before sending) never mutates (a test compares hashes before/after).
- `NetSession.dispatch` → `CommandResult`: **solo/lobby/host** the real outcome (`buildingId` for place, `count` for
  road/removeRoad/mark/unmark); **guest** `{ ok: true, pending: true }` (+ precheck `count`) or a local refusal
  (precheck failed, > 80 unacknowledged commands); **joining** refused. A guest's command that the host could not apply
  fires `rejected` on the issuing peer only (the issuer travels in each entry). Road drags are split into commands of
  ≤ 120 tiles (input `chunkTiles` and session `ROAD_SPLIT`).
- `speed` is shared: any player may change it (0 pauses everyone's clock); in co-op it is applied at a turn.
  `NetSession.speed()` is what the UI shows (0 while a guest waits for its host).

### 9.3 Wire protocol (`src/net/protocol.ts`, `PROTOCOL_VERSION` 1, compact JSON)
| Topic (events, admin-only) | Sender | Fields |
|---|---|---|
| `turn` | host, 5 Hz (1 Hz keepalive when idle) | `v` version · `g` gameId · `e` epoch · `k` confirmed tick · `s` shared speed · `ls` last assigned seq · `lo` oldest seq in the host log · `c?` command entries (new ones + a redundant window from the lowest `f.a` any follower reports) · `a?` acks `{peer: highest applied local seq}` · `h?` last two `[tick, hash]` · `b?` `[baseTick, baseNextSeq]` (new epoch after failover) · `t/y/p` town name, year, population |
| `cmds` | host | `{v, g, e, c}` overflow / re-sends that do not fit a turn (≤ 3 extra per turn cycle) |
| `snap` | host | `{v, g, e, id, i, n, k, ns, s, z, r, d}` chunk `i` of `n` of the town at tick `k`; `ns` = first seq NOT in it; `z` 1 = gzip; `r` = join request ids answered; `d` ≤ 3300 base64 chars |
| `chat` | any admin; the host relays view-only players | `{t, rp?, rn?, i?}` text, relayed peer & name, line id — every line is emitted twice 400 ms apart, receivers show each id once |

**Command entry**: `[seq, tick, issuerPeer, issuerLocalSeq (0 = host-issued), cmd]`, applied by every peer at `tick`
(before stepping to tick + 1) in seq order.

**Presence** (every tab): `{ v, n nickname, c colour (picked once from 8), ad 1 = admin, l? {cu cursor, ca camera
[x,z,yaw,dist], gh ghost [type,x,z,rot,w,h,valid], t tool label} (10 Hz), h? host claim {id, s since, e epoch, t town,
y year, p pop, k tick}, f? following {id, e, k tick, a first missing seq (= resend request), sy in sync} (4 Hz), q?
command queue [[lseq, cmd]…] (≤ 24 entries / 2000 B; the host applies and acks via `turn.a`), j? join request {id, r
request id, q ask counter, m? missing chunk indices}, ch? chat outbox [[cseq, text]…] (non-admins, ≤ 3 lines / 20 s),
x? id of a town this tab stopped sharing }`. Free text is cleaned of control, private-use and invisible format
characters (the room refuses them). Keys are plain identifiers, nesting ≤ 6.

### 9.4 Limits & budgets
- `MAX_PAYLOAD_BYTES` = 3800 (platform 4096) for every event and the whole merged presence object; an oversized
  presence drops `l.gh`, then `l`, then `ch`, then trims `q`.
- Emits: token bucket 30/s, burst 40 (room drops past ~40/s, burst 80); snapshot chunks and chat re-sends only while
  more than 6 tokens remain, so turns always go first. Measured: turns average ~160 B (max ~480 B), ~0.8 KB/s;
  presence ~150 B at ~6 updates/s; largest payload seen in tests 3.4 KB.
- Snapshot of a medium map at year 5 (pop 37): raw 199 KiB → gzip 71 KiB → 30 chunks; gzip ~30 ms (async), gunzip
  ~5 ms, load ~15 ms; a join over a lossy room (50 ms + 60 ms jitter, 10 % drop) takes ~3 s. Small map year 1: 20
  chunks, ~2.3 s.
- Sim cost: ~0.12–0.14 ms per tick (medium map, year 5); lockstep at 10× costs < 1 ms per frame for host + guest.
- Host log 4000 entries; re-sends ≤ 2 × `MAX_PAYLOAD_BYTES` per turn cycle; host lost after 2.5 s; resyncs ≥ 3 s
  apart; chat ≤ 240 characters (the UI caps at 160).

### 9.5 Determinism rules (every sim author — `tests/net.determinism.test.ts` is the regression gate)
1. Code reachable from `Game.step` uses `src/sim/core/dmath.ts` (`hypot`, `sq`, `sin`, `cos`, `atan2`, `exp` built
   from + − × ÷, sqrt, floor, round) instead of `Math.hypot/sin/cos/atan2/exp/pow` or `**` — those differ in the last
   bit between V8, SpiderMonkey and JavaScriptCore. World generation (host only; guests receive the world) may use
   `Math.*`.
2. Results must not depend on Set/Map iteration order or insertion history (which differ after a save/load); break
   ties with stable keys (id, tile index).
3. Planner probes and other read paths must be pure (no deleting expired entries while reading, no lazy caches that
   change behaviour). UI, input, renderers and audio only READ the game; every mutation is a Command.
4. No runtime-only cache (countdown timers, lazily built indexes, `rt.*`) may change sim behaviour unless it is rebuilt
   at a fixed point of every step or saved in `GameState` — a restored game must behave exactly like the original.
5. Randomness only from `game.rng` (saved in the state); never `Math.random` or wall-clock time in the sim.
   `rt.realTimeDriven` may only affect sound throttling. `rev.features` is render-only (excluded from the hash).
6. Every new piece of state that affects the future must be in `GameState` (saved) — the snapshot is how peers join.

### 9.6 App integration & UX
- **main.ts → `CoopDriver`** (`src/net/driver.ts`, DOM-free, shared with `tests/net.e2e.test.ts`): the app boots solo
  (`new NetSession(game, null)`), `connectTransport()` resolves in the background (≤ 11 s) and is attached with
  `attachTransport` (solo → lobby). `AppContext.net` is the session, `AppContext.dispatch` / `setSpeed` forward to it.
- **New Game / Load / Continue** (`startGame`): a guest leaves the shared town first (the menu locks these while
  following and explains); a connected admin hosts the town unless someone else already hosts one (then it is played
  locally and a toast says so); non-admins play locally in the lobby. An admin already playing when the room connects
  is offered "Share town" (toast after 3 s) — a running town is never shared by itself.
- **'gameReplaced'**: full swap (renderer, UI, input, audio, game-event bindings; camera jumps to the host's view; the
  menu closes) on a join or when the host opens another town; a **soft** swap (same seed & town name) on a resync keeps
  camera, tool, selection, open dialogs and toasts.
- **Clock**: `net.update(realDt)` every frame; its return value is the renderer's `gameDt`. The menu freezes only
  solo/lobby towns; a shared town keeps running in the menu, while the pacer idles, and in a hidden tab (a Blob-URL
  Worker timer calls `net.update(≤ 1 s)` every 250 ms; fallback `setInterval`, which Chrome throttles to 1 Hz in hidden
  tabs and ~1/min after 5 min — if the platform's CSP blocks Blob workers, a backgrounded HOST slows the shared clock).
  Joining never idles. Autosave only for solo/lobby/host — a guest's copy never overwrites its saves.
- **UI** (`src/ui/coop/*`): Players window (J; 👥 button bottom-right with an unread-chat dot) — status line, join
  progress, resyncs / pending orders / ticks behind, player rows (colour, name, 👑 host, you, guest tag, current tool,
  idle dimming, click to look) and Join / Share this town / Leave shared town / Stop sharing, chat log. Chat bar (Enter
  while connected; Esc closes; typing never triggers hotkeys). Net banner under the top bar (joining %, "Waiting for
  the host…", "Catching up…", "Connection lost — reconnecting…"). Main-menu co-op block ("Join <host>'s town" with
  town · year · population; hosting notice + Stop sharing). Toasts: refused commands with the host's reason, players
  joining/leaving, joined/hosting/host closed, repaired resyncs. **Pending values** (`src/ui/pending.ts`): a guest's
  requested value (workers, builders, pause, priority, crop, recipe, merchant) is shown in gold italic until the game
  reflects it or 4 s pass; a rejection clears it.
- **Other players** (`src/render/remotePlayers.ts`): coloured cursor ring + pin with name and tool label, and a tinted
  ghost of what they are placing — only for players in the same town (the session nulls world positions of peers in
  other towns). Names: `user.profiles()` via the peer's `by` → presence nickname → "Settler NN".
- **Public rooms** (relay): "Play online", room card, nicknames, host seat, kicking and terminal states — §10.6.
  main.ts `connectCoop` calls `UIManager.onNetChanged(transport)` after a successful attach (the co-op UI reads only the
  transport's `kind`, `closeReason()`, `adminPeer()` and `peers()`) and `onNetUnavailable()` when `connectTransport()`
  resolved null or attaching failed.

### 9.7 Transports & publishing
- `connectTransport()` (`src/net/transport.ts`, never throws): `?net=off` → solo; `?net=local` → `LocalTransport`
  (BroadcastChannel 'exiles-net' between tabs of ONE browser; `&role=guest` = view-only, `&drop=0.2` drops that
  fraction of incoming events); otherwise the Claude room (`claude.use('room')` + `claude.use('user')`), or null after
  11 s. `ClaudeRoomTransport` filters `kind: 'agent'` peers and treats terminal error codes as a permanent disconnect.
  `MemoryHub`/`MemoryTransport` (tests): virtual clock, latency, jitter, seeded drops, per-peer admin flags.
- `?room=<code>` (outside a Claude artifact) → `RelayTransport`: a public room on the Cloudflare Worker that anyone
  with the link can join — see §10. The Claude artifact is published from the same `dist/`; inside it `?room=` is
  ignored and no relay is ever contacted (artifacts block outside connections).
- **Capabilities to declare when publishing**: `{ room: {}, user: { scopes: ["profile"] } }`. Do **not** declare
  `db` (it makes the artifact organization-internal and breaks the owner's public link), and do not open room topics to
  the interact level (guests use presence only). Viewers without a room (public link, signed out) get the full solo
  game.

### 9.8 Testing co-op
- Headless (`npx vitest run --maxWorkers=2 tests/net.*.test.ts`): `net.determinism` (restore-every-397-ticks full-state
  equality over years, disasters, trade, famine), `net.session` (host + admin guest + view-only guest, 15 % drop,
  jitter, bot-driven years, injected desync, failover), `net.edge` (solo = Game.update, lobby, host conflicts, waiting
  guests, bursts, chat, town switch), `net.e2e` (the app flow through `CoopDriver` and the UI/input command paths:
  join from the menu, pending values, conflicting orders, chat, pause, host in the menu, failover, stop sharing,
  waiting + follow, soft resync, hidden-host pace), `net.transport`, `net.commands`, `net.perf`; public rooms:
  `cloud.room-core`, `net.relay.transport`, `net.relay.session` (NetSessions over the real room logic: failover,
  blips, step-down, forged host claims, kick), `ui.rooms` — §10.7.
- Browser: `npm run dev`, then TWO SEPARATE WINDOWS side by side (a background tab gets no animation frames):
  `http://localhost:5173/?net=local` (admin — starts/hosts the town) and `http://localhost:5173/?net=local&role=guest`
  (view-only — joins from the menu). A third `?net=local` window is a second admin (failover when the host window
  closes). Console: `__app.net.status()`, `__app.net.players()`, `__app.net.stats` (`hashChecks`, `hashMismatches`,
  `lastJoin`, `lastSnapshot`), `__app.net.currentTick`; force a desync on a guest with
  `__app.net.game.state.citizens[0].food = 1` (repaired by one resync).
- Published artifact: the owner hosts; a second organization member (view-only) opens the page and joins; a public
  link still plays solo.

---------------------------------------------------------------------------------------------------------------------

## 10. Public online rooms (Cloudflare) — net-core: `cloud/**`, `wrangler.jsonc`, `src/net/transport-relay.ts`

Inside a Claude artifact, co-op rides on the `room` capability, which only admits people the owner invited and who are
signed in (§9). The same Vite build is ALSO deployed to Cloudflare, where anyone who opens
`https://<host>/?room=<code>` joins the room — no account, no sign-in. The lockstep session (§9.1–9.5) is unchanged: it
runs over a third transport, `RelayTransport` (`kind: 'relay'`), whose semantics match the Claude room (presence,
admin-only events, own emits echoed), except that there is exactly ONE admin, the **host seat**, and the relay (not
the clients) decides who holds it.

### 10.1 Architecture
```
 browser tab ── GET /, /assets/* ─────────────▶ Workers Static Assets (dist/, SPA fallback; never runs Worker code)
             ── GET /api/health ──────────────▶ Worker fetch → 200 {ok:true, service, protocol, time} (CORS *)
             ══ wss /api/room/<code> ═════════▶ Worker fetch → code / Upgrade / Origin checks
                                                   → env.ROOMS.get(idFromName(code)) → Durable Object `Room`
                                                       (one per room code; RoomCore = all the room logic)
```
- **One Worker** `exiles` (`wrangler.jsonc` at the repo root; `main: cloud/worker.ts`, `compatibility_date`
  2026-09-01): `assets` = `./dist` (binding `ASSETS`, `not_found_handling: single-page-application`,
  `run_worker_first: ["/api/*"]`), Durable Object binding `ROOMS` → class `Room`, migration `v1`
  `new_sqlite_classes: ["Room"]` (SQLite-backed — the only kind the Workers Free plan allows; never edit `v1`, add a new
  tag for class changes), `observability` on. Other `/api/*` paths → 404 JSON.
- **`cloud/room-core.ts`** — a pure state machine for one room (no Cloudflare APIs): seats, presence merge, admin-only
  events, host seat, kick + bans, rate limits, liveness sweep, rebuild after hibernation. It documents the wire
  protocol and exports its constants; the client imports them (`src/net/transport-relay.ts` → `../../cloud/room-core`,
  tree-shaken), so client and server share ONE definition. Unit-tested in `tests/cloud.room-core.test.ts` and used
  in-process as the relay of the net tests (`tests/net.relay.helpers.ts`).
- **`cloud/worker.ts`** — the glue: the fetch handler, and `Room` on the WebSocket **Hibernation API**
  (`ctx.acceptWebSocket`; per-socket state in `serializeAttachment`, so a woken or evicted object rebuilds the room from
  `ctx.getWebSockets()`; `ping` → `pong` answered by `setWebSocketAutoResponse` without waking the object), bans in
  `ctx.storage.kv` (cleared when the room empties), an in-memory timer only while a reconnect grace or the host seat's
  liveness check is due (never sooner than 100 ms), and a 60 s alarm while the room is occupied to sweep dead sockets.
  An idle room hibernates; a hosted one stays awake (turns every 200 ms).
- **Client** — `connectTransport()` order: `?net=off` → solo; `?net=local` → `LocalTransport`; `?room=<code>` (not
  inside a Claude artifact) → `RelayTransport`, returned at once — it connects and reconnects in the background until a
  terminal close; an invalid code → null; else the Claude room. `?room=` is parsed strictly (trim + lower-case, then
  `[a-z0-9-]{3,32}`) by both the transport (`roomCodeFromParam`) and the UI (`readRoomParam`); a test keeps them equal.
  `?relay=<ws(s)|http(s) base>` points a page at another relay for development — accepted only for localhost / LAN
  hosts or the page's own host (`relayBase`, also used by the UI's health probe).
- **Session integration** (`src/net/session.ts`): `onAdminChange(admin)` sets `canHost` and republishes presence `ad`;
  failover candidates come from `transport.adminPeer()` instead of presence `ad`; host claims (`h`) count only from the
  seat (§10.5); `stepDown()` when the seat is lost while hosting; a terminal close (`closeReason()`) leaves the shared
  town and keeps a local copy. Additive `NetSession` API: `setNickname`, `getNickname`, `transportKind`, `inviteLink`,
  `canKick`, `kick`, `closeReason`. Optional `Transport` members: `onAdminChange`, `adminPeer`, `kick`, `inviteUrl`,
  `closeReason` (the Claude, local and memory transports do not have them, so their behaviour is unchanged).

### 10.2 Wire protocol `exiles-relay.1` (WebSocket text frames; full spec at the top of `cloud/room-core.ts`)
| | |
|---|---|
| Handshake | `GET /api/room/<code>`, `Sec-WebSocket-Protocol: exiles-relay.1, cid.<clientId>, tab.<nonce>`; server answers `exiles-relay.1`. clientId `[A-Za-z0-9_-]{16,64}`, one per browser tab (sessionStorage `exiles.relay.cid`; bans key on it); tab nonce `[A-Za-z0-9_-]{4,32}`, new per page load. Peer label = first 16 hex of SHA-256(`exiles-peer\n<code>\n<clientId>`): stable across reconnects, never reveals the id. |
| Keepalive | client sends bare `ping` every 5 s → `pong` (runtime auto-response) |
| client → server | `{t:'p', patch, r?:1}` presence (merge, top-level null deletes; `r:1` replaces — the client always sends the whole object) · `{t:'e', topic, data}` event, host seat only · `{t:'kick', peer}` host seat only |
| server → client | `{t:'hello', self, admin, peers:[{peer, joinedAt, presence}]}` (oldest first, self included) · `{t:'join', peer, joinedAt}` · `{t:'leave', peer}` · `{t:'admin', peer}` · `{t:'p', peer, presence}` (whole object, never echoed to its sender) · `{t:'e', peer, topic, data}` (never echoed: the client echoes its own emits locally) · `{t:'err', code, msg?}` (`not_permitted`, `invalid_argument`, `too_large`, `kicked`, `room_full`, `duplicate`, `bad_request`) |
| Close codes | 4001 kicked/banned · 4002 replaced (same tab reconnected) · 4003 duplicate (a copied client id in another tab → pick a new id, reconnect) · 4004 room full · 4005 bad request · 4006 timeout (silent) · 4007 reset (the relay lost the socket's state → reconnect). **Terminal** (no reconnect; `closeReason()`): 4001 `kicked`, 4004 `room_full`, 4005 `bad_request`. |
| HTTP errors | 400 `bad_room_code` / `unsupported_protocol` · 426 `expected_websocket` · 403 `origin_not_allowed` |

### 10.3 Host seat & failover
- The **host seat** (the room's only admin): the oldest connected, non-banned seat. It is sticky — it moves only when
  its holder's seat is removed; then the oldest CONNECTED seat gets it (`admin` broadcast). A holder that comes back
  later never takes it back. Only the seat may emit events (turn, cmds, snap, chat) and kick; so in a public room
  `status().canHost` is true only for the seat holder, and only they can start or share a town. Everyone else plays
  locally in the lobby, joins the hosted town, or waits ("Waiting for <name> to start a town").
- **Reconnect grace**: a seat whose socket dropped without a clean close keeps its presence, seniority and host seat for
  5 s (`GRACE_MS`); a reconnect within that time resumes the same seat and label — nobody notices. A clean close
  (1000/1001: the tab left — the client closes on `pagehide`) frees the seat at once.
- **Failover timings**: host tab crashes / network dies → relay sees an abnormal close → 5 s grace → seat moves → the
  new holder's session waits `HOST_LOST_MS` (2.5 s) → promotes (§9.1): ≈ 7.5 s. Host tab closed normally: ≈ 2.5 s. A
  host that returns after the grace finds the seat taken → `stepDown()`: it resyncs as a follower of its own town under
  the new host (toast "Another player took over hosting…").
- Liveness: a socket silent for 90 s is closed (clients ping every 5 s; hidden tabs may be throttled); the seat holder
  after 12 s when it emitted in the last 30 s. Client side: no answer for 12 s or no hello within 10 s → reconnect;
  backoff 0.5 s doubling to 10 s with jitter; never after a terminal close.

### 10.4 Limits
- Room code `[a-z0-9-]{3,32}`; **16 seats** (held seats count); the 17th gets 4004 `room_full`.
- Payload ≤ 4096 B (event data; the merged presence object) and client frame ≤ 4608 B (payload + envelope); the
  session keeps its own `MAX_PAYLOAD_BYTES` 3800 (§9.4). Presence: ≤ 64 top-level keys, each an identifier
  (`[A-Za-z][A-Za-z0-9_]{0,31}` — no `__proto__`).
- Rate: per socket two token buckets, events+kicks and presence, each 40/s burst 80; frames past them are dropped
  silently (an `err` for malformed frames is rate-limited too). The session already stays below (emits 30/s burst 40,
  presence ≤ 20 Hz, coalesced by the transport to one send per 50 ms).
- Bans: ≤ 256 client ids per room, for the room's lifetime (cleared when the last seat leaves).
- Measured in `tests/net.relay.session.test.ts`: largest client frame 3454 B, largest server frame 3480 B.

### 10.5 Security model (every client is untrusted; there are no accounts)
- **Server-enforced** (`cloud/room-core.ts`): who holds the host seat (clients cannot claim it); admin-only events and
  kicks; frame, payload and presence-key limits; rate limits; 16 seats; kick = close 4001 + ban of the client id (a
  reload of the kicked tab is refused again); a second tab with a copied client id is refused (4003); the WebSocket
  handshake is checked in the Worker (room code, `Upgrade`, subprotocol, Origin = the Worker's own hostname or
  localhost). Rooms carry no cookies or credentials, so cross-site WebSocket hijacking has nothing to steal; the Origin
  check only keeps other websites from using the relay as their backend (non-browser clients can forge it anyway).
- **Session-enforced** (every peer, identically): commands pass `sanitizeCommand` (integers, enums, own-property keys,
  ≤ 400 road tiles) before `applyCommand` (§9.2); presence is read through validators (`readHostClaim`, `readFollow`,
  `readQueue`, `readChatOutbox`) and free text through `cleanText`. In a relay room **host claims (`h`) count only from
  the relay's host seat**: anyone can write presence, and a forged claim with an early `since` would otherwise make the
  real host give way and lure everyone into a town nobody can send (regression test: "untrusted players cannot hijack
  the town" in `tests/net.relay.session.test.ts`). The UI reads the seat from `transport.adminPeer()`, not presence.
- **Trust boundary**: the seat holder is trusted with the town it hosts (it sends turns and snapshots) — a malicious
  host can only spoil its own shared town; followers can leave and keep a copy. Any player can issue any VALID command
  (that is co-op); griefers are kicked.
- `?relay=` is honoured only for localhost / LAN hosts or the page's own host (transport and UI probe), so a crafted
  invite link can neither send players to someone else's relay nor make the page contact a stranger's server.
- **Known gaps** (follow-ups): bans are per client id — a kicked player can return from a new tab or another browser
  (no per-IP ban or per-IP connection limit; `CF-Connecting-IP` in the Worker would allow one); the host seat cannot be
  handed over (a seat holder idling in the menu blocks hosting until they leave the room — a `{t:'give', peer}` frame
  would fix it); the room code is the only secret (generated codes: 6 characters of a 31-letter alphabet ≈ 8.9 · 10⁸);
  non-seat players' chat is relayed by the host from presence and can be spammed within the rate limits (kick).

### 10.6 UI (public rooms; `src/ui/coop/rooms.ts` pure helpers, `room-box.ts`, `menu-coop.ts`, `players.ts`, `controller.ts`)
- **Main menu "Play online"** — only on a plain http(s) page without `?room`/`?net` whose `/api/health` answers a JSON
  object within 2 s (never inside a Claude artifact; the Vite dev server's index.html fallback does not count):
  [Host an online game] reloads into `?room=<6 chars>` (from a running town: confirm, save to the autosave slot, then
  Continue in the room hosts it); [Join with code] takes a code or a pasted invite link.
- **In a relay room**: room card (code, [Copy invite link] — clipboard inside the click, else the link shown selected;
  Name field, max 24, stored in localStorage `exiles.nick`, applied with `net.setNickname`), "Anyone with the invite
  link can join.", "Waiting for <seat holder> to start a town", [Leave room] (reload without `?room`). Players window
  (J): room card, "· host seat" tag, ✖ remove (seat holder only, confirm → `net.kick`). Who-can-join texts depend on
  the room kind (relay: invite link; Claude: "People you invite by email (Share menu) can join.").
- **Terminal states** (`closeReason()` 'kicked' | 'room_full' | 'bad_request'; invalid `?room=` → no transport): the
  menu box shows the reason with [Play solo] (+ [Try again] when useful, + "Keep playing this town" while hosting or
  following); one danger toast; the net banner turns final ("… Press Esc for the menu.", no spinner). A relay that
  cannot be reached is not terminal (the transport keeps retrying): the menu says so after 8 s.
- **Toasts**: "Your town is shared — anyone with the invite link can join." + [Copy invite link]; guest → host
  "The host left — you are hosting the town now."; host → joining "Another player took over hosting while you were
  disconnected — following their town."

### 10.7 Local development & tests
- `npm run cf:dev` (= `vite build && wrangler dev`) → open **http://localhost:8787/?room=test** in TWO SEPARATE
  WINDOWS (a background tab gets no animation frames). The first window holds the host seat and hosts New Game; the
  second joins from the menu. `http://localhost:8787/` alone shows "Play online".
- Vite + relay: `npm run dev` and, in a second terminal, `npm run cf:dev`; then
  `http://localhost:5173/?room=test&relay=ws://localhost:8787` (the Worker accepts localhost origins; `/api/health`
  sends CORS headers, so `http://localhost:5173/?relay=http://localhost:8787` shows "Play online").
- `wrangler dev` keeps Durable Object state (bans) in `.wrangler/state`; delete that folder to reset. Use a new room
  code to start clean.
- Console: `__app.net.transportKind()` ('relay'), `__app.net.inviteLink()`, `__app.net.canKick()`,
  `__app.net.status()`, `__app.net.players()`, `__app.net.kick(peer)`, `__app.net.closeReason()`.
- Headless: `npx vitest run --maxWorkers=2 tests/cloud.room-core.test.ts tests/net.relay.transport.test.ts
  tests/net.relay.session.test.ts tests/ui.rooms.test.ts`. Types: `npm run typecheck:cloud`. Bundle check without
  deploying: `npx wrangler deploy --dry-run --outdir .wrangler-dry` (needs `dist/`; delete `.wrangler-dry` after).

### 10.8 Deploying (once per machine, then one command per release)
1. `npm install` (wrangler and `@cloudflare/workers-types` are dev dependencies).
2. `npx wrangler login` — once; it opens the browser to authorize wrangler for your Cloudflare account (a free account
   is enough: the `Room` class is SQLite-backed).
3. `npm run cf:deploy` (= `vite build && wrangler deploy`). The first deploy may ask you to pick a `workers.dev`
   subdomain. Wrangler prints the URL, e.g. `https://exiles.<your-subdomain>.workers.dev`.
4. Open it → main menu → **Play online** → **Host an online game** → **Copy invite link** → send the link. Friends open
   it and join from the menu.
- Updates: run `npm run cf:deploy` again. A deploy restarts running rooms: players reconnect by themselves, and the
  host seat may move to another player (the town then fails over as in §10.3).
- Logs: `npx wrangler tail`, or Workers Logs in the Cloudflare dashboard (observability is on).
- Custom domain: declared in `wrangler.jsonc` `routes` (`exiles.hylim.casa`, `custom_domain: true`; the zone lives on the
  same Cloudflare account), so `cf:deploy` keeps it attached. Live: https://exiles.hylim.casa (fallback
  https://exiles.destiny941120.workers.dev).
- The Claude artifact is published from the same `dist/` exactly as before (§9.7); it never contacts the relay.
