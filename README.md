# Where Are You? — Procedural Orienteering Terrain Quiz

A browser quiz in the style of classic "Where are you?" contour-map puzzles. You get a first-person view of the terrain and the heading you're facing, plus a contour map with 3–4 marked points. Pick the one you're standing on.

Terrain and questions are procedural and reproducible from a seed: `#seed=kx7p-2m9q&d=hard`.

![screenshot](docs/screenshot.png)

## Run

No dependencies and no build step. Serve the folder over HTTP (module workers don't load from `file://`):

```bash
npm start            # http://localhost:8080
npm test             # engine tests (node:test)
node scripts/generate.mjs <seed> [easy|medium|hard|expert]   # dump one quiz as JSON
node scripts/batch.mjs 10                                     # pass-rate / timing stats
```

## GitHub Pages

The site is fully static and uses relative paths only, so it works from a sub-path like `https://<user>.github.io/orienteering/`. `.github/workflows/pages.yml` runs the engine and browser checks on the assembled site, then deploys successful pushes to `main`.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Alternatively pick "Deploy from a branch" → `main` / `(root)`, which also works because there is no build step.

## Instagram export

**Export for Instagram** (in the Question panel) opens a live preview:

- **Formats:** Reels/Story 9:16 (1080×1920) and Post 4:5 (1080×1350).
- **Question image / Answer image (PNG):** for a carousel post, or a question plus answer pair.
- **15 s video:** animated weather, any combination of **wind** (bands of grass sweeping downwind, faster clouds), **rain** (falling streaks, wet overcast light), **clouds** (a moving cloud deck and cloud shadows drifting over the terrain) and **fog** (visibility down to ~1.5 km). A countdown bar runs under the scene; optionally the last 3 s reveal the answer and the view wedge on the map.
- **Frame:** handle/footer text, caption ("You are at A, B or C, facing north."), bearing tape.

Weather is purely visual and never changes the terrain. Position puzzles keep their fixed viewpoint, friend videos follow the zoom sequence, and Bunny-hop trails follows the same terrain-selected run as the page.

Videos are encoded frame by frame with WebCodecs and muxed into MP4 by a small built-in muxer (`src/export/mp4.js`). The output is always exactly 60 fps and 15.0 s (900 frames), however fast the machine renders; H.264 uses level 4.2, which 1080×1920 at 60 fps requires. In Chrome, Edge and Safari the codec is **H.264**, which is what Instagram expects. Browsers without an H.264 encoder fall back to VP9 (or real-time MediaRecorder WebM), and the dialog warns that the file needs converting before upload. On phones, the **Share…** button hands the file to the system share sheet, which includes Instagram.

## Seasonal Easter eggs

Two decorative, code-drawn animations are layered onto **exported** frames (the Instagram video, the PNGs, the export preview). The normal page, the quiz, the seed, the options, the answer and everything saved are untouched: the layer only receives the plan, the quiz seed, the export layout and the engine's skyline.

| Event | When | What |
|---|---|---|
| **Winter** | Dec 21 – Jan 6 | Subtle layered snowfall for the whole render. On **Dec 24–25** Santa's sleigh with eight reindeer flies across the sky from 10.0 s to 14.4 s and is gone before the last frame. |
| **May the Fourth** | May 4 | Starfield, Star Destroyers, a TIE patrol, and a Death Star whose superlaser charges from 6.4 s and explodes at 11.0 s (one brief flash). TIE fighters fly out of the blast. Everything fades before the end. |

The Death Star is a shaded sphere with a superlaser dish, an equatorial trench and restrained surface detail; each Star Destroyer is a wedge with a bridge tower; each TIE fighter has a cockpit, struts and twin hexagonal wings. The sleigh has Santa, a gift sack, reins, runners and antlers. All of it is drawn with Canvas 2D in `src/easter/models/`; there are no assets, downloads, CDNs, API calls or audio.

**Configuration** (`src/easter/config.js`): the winter window, the Santa days, the May 4 date and `timeZone` (an IANA zone such as `Europe/Istanbul`; `null` uses the local zone of whoever renders). The project had no publishing time zone before, so this is where it is set. The day is decided **once per render**, when the export dialog opens, and never per frame.

**Choosing it in the export dialog.** **Export for Instagram → Easter egg → Seasonal animation** offers *Automatic (by date)*, *None*, *Winter snow*, *Winter + Santa's sleigh* and *May the Fourth*. The preview updates at once and a line under the menu says what will be rendered. *Automatic* is the default and follows the date (or a preview link). A forced choice applies whatever the date is. Only *None* is remembered between visits; a forced event is not, so a Santa video cannot sneak into a July export. The menu is locked while a video is being recorded, so one video never mixes two events.

**Preview any event on any date** with query parameters (before the `#`), which *Automatic* honours:

```
?easterEgg=winter                     snow, on any date
?easterEgg=santa                      winter with the sleigh (Dec 24)
?easterEgg=may4
?easterEgg=off                        disable, even on an event day
?easterDate=2026-12-25                pick the event by date (also combinable with easterEgg)
?reducedMotion=1                      force the reduced-motion version (0 forces it off)
```

Open **Export for Instagram**; the dialog previews the 15 s loop with the event. `scripts/easter-models.html` shows every model at large size. `scripts/easter-harness.html` renders any single frame at an explicit time (`?easterEgg=may4&t=11.4`), and `scripts/render-easter-frames.mjs` renders sample frames and audits them (needs Playwright; it fails if the layer changes any pixel of protected content, or of the terrain on May 4, or if the first/last frame differs from the ordinary render).

**Where it may draw.** Sky objects (sleigh, ships, stars, flash) are clipped to the part of the 3D view above the engine's computed skyline (5 px margin) and below the compass tape, so they can disappear behind hills but never cover the terrain clue. Snow is clipped to unprotected areas: it never falls on the title, tape, countdown bar, map and markers, caption or handle. It does fall, faintly, on the terrain image (under 1.1 % of its pixels at 30–50 % opacity) and outside the scene. Pixel audits confirm this (see below).

**Timing and determinism.** Every frame is an analytic function of `elapsedSeconds`, the seeded generator (`quiz seed # event # date`) and the layout, so a frame can be reproduced exactly (and video is encoded frame by frame). There is no `Math.random`, `Date.now` or network use in the drawing code, and a test enforces it. A global envelope fades the layer in over 0.8 s and out by 14.9 s, is exactly zero on the first and last frame, and the layer then issues no draw calls at all: the last frame equals the ordinary render pixel for pixel. With **reduced motion** (the system setting, or `?reducedMotion=1`) snow is frozen, Santa or the fleet appear as a still fade, and there is no explosion or flash. The flash is a single pulse (peak 0.6, about 0.4 s), well below the 3-per-second guideline.

**Answer.** The layer never receives the options or the answer and draws the same picture for a scrambled quiz. It adds nothing that points at a choice. (The export's existing "Reveal answer in the last 3 s" option is unchanged and still applies.)

## Friend location mode

**Where is your friend?** shows a small 3D person from your own viewpoint. Choose **Point — A / B / C** or **Grid — cell reference** to answer. Grid supports 4 × 4, 6 × 6, 8 × 8 and 16 × 16: tap or type the friend's cell, then check; the answer shows his exact position and your observation point. Easy marks where you stand as YOU. Medium and above hide the observer and give each A/B/C target a plausible observation point with the same range, bearing and apparent body size. Match the skyline and intervening slopes to locate him. Expert and Master also use similar target landforms; **Depth trap** tightens the elevation-angle match. **Zoom 3×** helps inspect the sighting. After answering, YOU is revealed and Point comparisons show each possible observer view. See [the friend mode guide](docs/friend-mode.md).

In Friend mode, **Friend character → Conquest** adds a slow-motion arrival using the supplied transparent artwork. After the first 3 seconds and the normal zoom, Conquest descends from above while the view follows him, then returns for the answer. Selection works with Point, Grid, replay links (`fs=conquest`) and PNG/video exports. **Replay arrival** repeats the scene.

## Sniper mode

**Sniper — which hold?** You lie prone (eye 0.45 m) facing a given heading; your position is not marked. For 5 seconds you observe the landscape over your 3D rifle (lit, with scope, rail and bipod) and a red spot over an enemy sniper, who lies prone in a ghillie suit on the slope (it shows *where*, never how far). The rifle then rises and the last 10 seconds are through the scope: the hold settles, then drifts down and up the reticle with breathing and tremor, so the target passes over every mark. The sway is the same for every question and never hints at the answer.

Question: which bullet-drop mark puts the round on the enemy's **head**? Options are consecutive 100 m marks (3 on Easy/Medium, 4 on Hard/Expert, 5 on Master, which always includes the straight-line-range trap when it differs). Keys 3–9 and 0 (1000 m) answer.

- **Ballistics** (`src/engine/sniper.js`): 820 m/s, quadratic drag, 5 cm sight height, zeroed at 100 m. Each scope mark is the hold that hits at that range on flat ground, so the BDC marks spread out with range exactly as drawn. The answer is the mark whose simulated trajectory passes within the head (±12 cm); every other option misses it by at least 30 cm.
- **Height difference**: gravity only acts across the horizontal distance (rifleman's rule), so up- and downhill shots use the horizontal range, not the straight-line range. Harder levels prefer larger slopes (≥ 2–6°).
- **How to solve it**: find yourself and the target on the contour map from the heading and the terrain, then measure the map (horizontal) distance; or range the enemy's 0.50 m shoulders with the mil stadia (metres = 500 ÷ mils — that is the straight-line range, so correct it for the slope).
- **Optional crosswind call** (Wind → Crosswind call, `wind=1` in links): a steady wind is shown as speed and from-direction (the grass and rain drift with it), with the rifle's wind card — windage hold in mil per 1 m/s of full crosswind for 300–1000 m. The drift is Didion's relation (crosswind × (time of flight − range ÷ muzzle velocity)) on the simulated trajectory; the wind is drawn so the exact hold falls on a 0.5 mil stadia tick. Options pair scope marks with windage holds — including holding with the wind instead of into it — and exactly one pair hits the head. Plain quizzes are unchanged when the option is off.
- **Scope**: the circle spans ±12 mil; horizontal stadia are numbered 2/4/6/8 mil, vertical marks 2–10 (×100 m) with wind wings. The live view and exports share one sampler (`sniperFrame`), so the 15 s Reels video is exactly the 5 s overview + 10 s scope sequence. After answering, the map shows YOU, the ENEMY and the line of fire with its length, and the explanation lists each mark's impact.

## Bunny-hop trails

**Mode → Bunny-hop trails** (`&m=trail`) plays a 24-second first-person run (about 407 m) over changing slopes. Routes need at least 6 m of ground relief and a sustained slope/grade change; selection rewards ridge-side and valley passages. The 4×4 grid uses 36 seconds on the standard terrain to reach at least three cells without changing the speed ceiling. Choose which map trail you followed: **A red, B green or C cyan**. All three have the same shape, speed and steering; their moving terrain views are matched pairwise so the skyline and nearby slopes decide the answer. After answering, replay each route or compare the specific time and bearing that rules it out.

**Find by → Grid — finish cell** adds 4×4, 6×6, 8×8 and 16×16 cell answers. Watch the run and identify where it ends; the question map has no route markers. The answer reveals the finish cell and actual run. Grid links use `&m=trail&ta=grid&g=6`. A/B/C routes now span both map axes, with starts at least 500 m apart on the standard 2 km terrain.

Choose **CS 1.6 / CS:GO style** movement and the supplied **CS 1.6 Classic, CS:GO Default or Butterfly** green-screen clips. A WebGL chroma-key pass removes the background and green edge spill; hands and knives come entirely from the footage. Choose either hand and three sizes. **Space** pauses/resumes, **F** replays the clip’s knife animation, and the scrubber replays any moment. All three coloured map traces advance with the same playback clock without exposing the answer. Reduced-motion preferences start the run paused. Appearance persists locally and travels in shared links without changing the question.

Videos play the complete run and freeze at its endpoint for the final 3-second answer reveal: normally 27 seconds, or 39 seconds for a 4×4 finish grid. Both export formats and PNGs use the same camera sampler. [The trail guide](docs/trail-mode.md) explains movement, matching and validation.

## Core principle

There is exactly **one** elevation model per quiz (`TerrainModel`). The WebGL scene, the contour map, the skyline analysis and the distractor search all read `getElevation()` from that model. Even the lowland beyond the map edge is part of the model, so the analysis sees what the renderer draws.

## Pipeline

```
seed ─► SeedManager (named, independent sfc32 streams)
     ─► TerrainGenerator
          worlds.js           world recipe: archetype weights, noise, erosion, extras
          LandformGenerator   2–5 compatible archetypes → primitives
                              (elliptical Gaussian hills/knolls, spline ridges with
                               varying width/amplitude, spurs, re-entrants,
                               drainage-following valleys, saddles, plateaus, basins)
          DomainWarp          so the primitives aren't mathematically perfect
          FractalNoise        1000/500/250/100/40 m octaves, scaled to a 20–35 % share
          ErosionProcessor    flow-accumulation channel carving, thermal pass,
                              despiking, unintended closed depressions resolved
          DrainageSimulator   priority-flood + D8 + flow accumulation
     ─► TerrainModel          getElevation/Slope/Aspect/Curvature/FlowAccumulation,
                              getSkyline, getTerrainSignature, getContours
     ─► ContourGenerator      oriented Marching Squares (higher ground on the left),
                              interval chosen from relief + map scale (2/5/10/20 m)
     ─► TerrainAnalyzer       summits/knolls, saddles, depressions, ridge/valley masks,
                              distance fields, landform classification, TerrainSignature
     ─► ViewpointGenerator    ~250 positions × 4–8 headings, 360° ray sweep per position,
                              quality = skyline + landmarks + variation + ridge/valley +
                              foreground + orientation identifiability − occlusion;
                              weighted random pick from the top pool
     ─► QuizCandidateGenerator distractors whose view (same heading and FOV) differs
                              from the true view by a difficulty-specific band, weighted
                              by TerrainSignature similarity
     ─► QuizValidator         rejects spikes, broken contours, empty or blocked views,
                              views that depend on off-map terrain, ambiguous or
                              impossible distractors and points that are too close;
                              computes a confidence score. Failure → next viewpoint →
                              next terrain.
```

The view comparison (`descriptorDistance`) uses only what's inside the field of view: the horizon angle plus terrain angles at 40/120/350 m for each column. That means the difference between the answer and each distractor can always be seen in the scene.

## World types

The **World** selector picks the terrain recipe. Map size (2 km × 2 km), quiz modes and difficulties are unchanged; validation and answer explanations work the same on every world.

| World | Landscape | Own landforms |
|---|---|---|
| **Classic** (default) | Mixed hills, ridges, valleys and hollows | — |
| **Alpine** | High relief, sharper arêtes, rugged mid-scale noise | Cirque bowls cut into ridge flanks |
| **Karst** | Limestone plateau, little surface drainage | Steep cone hills (fengcong), fields of closed dolines |
| **Glacial** | Smooth, ice-moulded ground, broad U-valleys | Drumlin swarms aligned with the ice flow (blunt up-ice end), sinuous eskers, kettle holes |
| **Canyon** | Stepped benches from resistant rock beds | Mesas and buttes, one deep winding gorge following the drainage |
| **Dunes** | Sand sea, almost no erosion | Asymmetric transverse dune crests (gentle stoss, steep lee) on giant draa ridges |

**Auto** chooses a world from the seed (`world-v1|seed`), so a shared `w=auto` link reproduces it. In Auto texture mode a world with a natural surface uses it (alpine scree, mossy karst, glacial meadow, desert sand); an explicit texture still wins.

Classic is byte-for-byte the original generator, so old links and saved quizzes keep their terrain: links carry `w=<world>` only for other worlds. New worlds use their own terrain stream and model seed (`…#<world>`), tune the archetype mix, noise spectrum, domain warp and erosion (`src/engine/worlds.js`), and add their landforms in `LandformGenerator`. The chosen world is remembered locally for new quizzes.

## Difficulty

| | heading | options | distractor similarity | terrain | map |
|---|---|---|---|---|---|
| Easy | N/E/S/W | 3 | clearly different | 2–3 large systems | north-up |
| Medium | 8 compass points | 3 | partly similar | 3–4 systems | north-up |
| Hard | exact bearing | 4 | highly plausible | more spurs/re-entrants | may be rotated |
| Expert | exact bearing | 4 | subtle | 4–5 systems, more drainage, occlusion allowed | may be rotated |

| **Master** | exact bearing | 3 | hardest valid of ~36 fully evaluated questions | 4–5 systems, max complexity | may be rotated |

**Master (brain-burner)** does not stop at the first valid question. It fully evaluates about 36 viewpoints on the terrain (candidate view descriptors are cached per heading, so this takes only ~2–3 s) and scores each valid question for *puzzle hardness*:
- distractor views close to the ambiguity limit;
- similar terrain signatures and landform types;
- similar elevations;
- options spread across the map, so "the one in the middle" gives nothing away.

Distractors are searched by similarity across the **whole map**. Distance is only a hard constraint, never a similarity term, because neighbouring points always look alike, and treating closeness as similarity lines every option up on one slope. The rules:
- at least 500 m from the true position;
- at least 380 m between options;
- no two options on the **same landform**: `TerrainAnalyzer.sameFeature` rejects a pair when the straight line between them crosses no drainage channel and no dip or rise of 6 m (one hillside, one valley floor).

The similarity score weights the view descriptor at 55 %, horizon profile 20 %, slope 15 % and elevation 10 %, scaled by how similar the skyline depths are. Master then keeps the viewpoint whose distant "twins" come closest. Other difficulties use the same rules with 360–420 m spacing.

Solvability is enforced: every distractor must differ from the true view by at least 1.6° somewhere on the skyline. The answer screen names that **key difference** ("088°: skyline 2.1° lower"). The final question is drawn at random from the three hardest.

**Heading style** (the *Heading* control, `&h=` in the link) overrides the difficulty default in any "Where are you?" game, Master included:
- `exact`: exact bearing ("FACING 067°");
- `intercardinal`: 8 fixed directions (N, NE, E…);
- `cardinal`: 4 directions.

The terrain stays the same; only the chosen viewpoint and heading change.

### "Which way are you facing?" mode

`Mode → Which way are you facing?` (`&m=facing`) marks your position and asks
which of eight directions you face. Compare the skyline and contours around
the marked point; this mode uses the ordinary terrain view.

### Sun & watch difficulty

Select **Difficulty → Sun & watch** in Where are you?, Look-alikes, Grid method or
Where is your friend? In point questions, A/B/C remain three separate locations.
Their views match at three different bearings, at least 90° apart. All three
pairs are checked at full ray
resolution, and all six wrong-location/observed-bearing combinations must differ
by at least 3.4° RMS. Inferring the bearing from the clock and sun therefore
helps eliminate the similar-looking wrong locations.

The clip lasts **15 seconds**. Location questions lower the camera at 2 seconds
and show a readable analog wristwatch for three seconds (2.5–5.5 s), then raise
the head at the original bearing. The camera slowly turns directly toward the
sun, holds it in the centre, and smoothly retraces the turn to the original view
at 15 s. The sun's world position is independent of the camera: it can start to
either side, diagonally ahead or behind.
Replay, pause, Space and the timeline repeat or inspect the sequence.
A **FROM START** readout shows the current relative turn as **RIGHT 136°** or
**LEFT 45°**, counting back to **START 0°** when the original view is restored.
It remains visible while reading the watch, pausing or replaying, and appears
in both image and video exports. It gives no absolute compass bearing.

Friend questions first zoom from 3–5 s. One second after completing the zoom,
the camera lowers at 6 s and shows the watch for three seconds (6.5–9.5 s), then
raises the head toward the friend. From 10.2–12.3 s the camera slowly turns to
the sun, holds it until 12.9 s, then returns to the friend by 15 s. Both point
and grid answers (including 6×6) work. Classic
friends wave at zoom; Conquest's entrance lands before the wrist is raised.

No absolute heading text, compass tape, tutorial, skyline overlay or pre-answer
question diagnostics are shown. The clock and sun provide the physical scene;
the game does not explain how to interpret them. The answer and comparisons
appear after the player submits a location.

Grid method keeps cell-centre answers for 4×4, 6×6, 8×8 and 16×16. The same
15-second watch and sun sequence replaces the visible compass. Every other cell
is checked at the starting bearing; Lost compass additionally checks all eight
directions. Grid links retain `d=sun-watch`, for example
`#seed=grid-check&d=sun-watch&m=grid&g=6`.

The seeded watch uses simulated local solar time, an equinox and **0° latitude
(the equator)** by default. The morning sun is due east (090°); the afternoon
sun is due west (270°). Its height still follows the time: at 14:15 it is 56.25°
above the horizon, setting at 18:00. Exact noon is never selected because the
sun is at the zenith and has no horizontal bearing.
**Developer mode → Sun/watch latitude → Apply & regenerate** changes latitude
from 80° south to 80° north; **40** restores the northern mid-latitude model.
The `sunLat` override travels in shared links (`&dev=sunLat:40`), saved developer
settings and exports. Resetting defaults or disabling developer mode restores
the equator. Latitude changes only the physical sky, keeping the qualified
terrain, observer, friend and answer fixed.
[40° north sun-path diagram](src/assets/guides/sun-path-40-north.png)
shows directions and elevation through the equinox day.
Morning and afternoon times are drawn independently of the correct answer.
Solar azimuth/elevation drive both the visible sun and terrain illumination;
the generator checks that the sun clears the skyline. The camera sequence never
moves the observer or changes the answer. The original difficulty presets keep
their regular heading displays and cameras. Video exports use the identical
15-second sequence, including camera movement during the final reveal; PNG
exports capture a single frame. Reduced-motion preferences start the sequence
paused so the player can start it manually.

### Look-alikes (A / B / C)

`Mode → Look-alikes` (`&m=lookalike`) finds three distant map positions whose views **all resemble each other**. It compares A–B, A–C and B–C using skyline shape, foreground terrain and depth; the worst pair drives the selection. Each pair must still have a visible distinguishing detail. The points occupy separate landforms and form a spread-out triangle. Exactly three options are used at every difficulty.

Choose **Facing direction** to fix N, NE, E, SE, S, SW, W or NW (`&dir=NW`), or leave it automatic. **New positions** visits every compass direction once per eight automatic variants. Each search evaluates all eight headings, reusing 360° sweeps to shortlist matches and re-casting finalists at full resolution. The direction and all three points reproduce from a shared link. Scrambling, answer comparison views and image/video exports also work in this mode.

The view-difference limit ranges from 3.8° on Easy to 2.3° on Master. If eight terrain attempts cannot find a fair triple, generation asks for another seed instead of returning an ambiguous question. [Selection plan and validation](docs/lookalike-mode.md) describe the algorithm and its limits. CLI example: `node scripts/generate.mjs coverage master lookalike NW`.

**Scramble letters** (`S`, or `&s=N` in the link) leaves every point where it is and moves only the letters. Each press is a derangement, so every point gets a new letter, and it is reproducible from the seed. It works before answering and carries into exports.

**New positions** (`P`, or `&v=N` in the link) keeps the seed's terrain and draws a new observer position, heading and set of options. `v=0` is always the original question.

A rotated map is only a display transform. The north arrow always shows true north and the coordinates never rotate. Every preset lives in `src/engine/difficulty.js`.

## Answer explanations and automation

After answering, **Why this answer?** explains the matching skyline and contour
profile in English. **Why not the other answers?** gives a measured difference for
each A/B/C choice. Grid mode shows the three closest-looking wrong cells plus your
submitted cell if it is different, and lets you compare their views. Lost-compass
comparisons use each wrong cell's closest-looking heading. Sun & watch explanations
also check the direction inferred from solar time and the observed turn to the sun.
Friend explanations compare the person from the observer's viewpoint; friend-grid
comparisons use qualified person positions inside cells, rather than cell centres.
Trail explanations identify a replay time and skyline difference, or an invalid run.

Every generated quiz includes an `explanation` object, so CLI JSON and worker/API
consumers can use the same reasoning without an external AI service. It contains
`version`, `language`, `source`, `kind`, `correct` (summary and evidence),
`closestLabels`, and `alternatives` (plausibility, reasons and comparison metrics).
Each evidence entry has a stable `type`, English `text`, and numeric `data`; signed
differences mean **candidate minus the shown view**. Bearings are true north; map
rotation does not change them. Scrambling remaps explanation labels with the points.

**Download explanation JSON** on the answer screen exports the seed, mode,
difficulty, variant, scramble number, submitted answer and full explanation,
including all grid alternatives. For example:

```sh
node scripts/generate.mjs grid-check medium grid > quiz.json
```

Explanations are shown only after answering. They describe the generated terrain
and sightlines; an inconclusive comparison or low-confidence question is marked
explicitly instead of inventing a reason to reject an answer.

## Environment

The **Environment** panel controls the live scene: clear skies, passing clouds,
overcast, light drizzle, rain, rainstorms, morning mist, snowfall and golden hour.
Choose calm air, a light breeze or a strong breeze independently. Wind has smooth
gusts, bends vegetation and changes the direction of rain and drifting snow;
clouds cast moving shadows. Snow also settles visually on flatter ground.

**HD terrain texture** uses local 2K atlases of CC0 scanned grass, rock, soil and
rocky meadow surfaces. Slope-dependent blending, world-space cliff projection,
normal/roughness/AO maps and terrain shadows keep detail visible at several
distances. **Foliage** adds textured meadow grasses, ferns, leafy shrubs and pine
trees, with dense nearby ground cover and anchored wind motion. **Nature** adds
irregular boulders, ferns, wildflowers and distant birds. Vegetation is seeded from
the terrain, rests on the rendered ground, and uses the terrain depth buffer. All three are optional
and off by default. These settings never modify elevations, contours or answers.

Foliage and Nature each have an independent **Light / Moderate / Heavy** density
selector. Light keeps a sparse subset of the seeded placements; Moderate preserves
the original amount; Heavy adds another seeded layer. Nature density also controls
the bird flock size. Changing one category keeps the other category's placement
unchanged. Density choices are remembered locally, survive toggling a category off,
and carry into the export dialog, where they can be adjusted for PNGs and videos.

**Terrain texture → Auto — by seed** chooses one of five surface styles:
Green meadow, Mossy moorland, Autumn grassland, Desert sandstone or Alpine scree.
Each has its own ground/rock palette, soil and rock coverage, and detail scale.
The quiz seed also sets the texture pattern's world offset and scale variation.
The same seed keeps its style across difficulty changes, new positions and
terrain retries. Styles work with both standard shading and **HD terrain texture**;
HD adds the existing scanned color, normal and roughness detail.

Choose a style manually to override Auto. The selection is remembered locally,
and the export dialog starts with the scene's choice. Auto reproduces the same
style in live play, shared seed links, PNGs and videos.

HD and plant assets load only when selected; exports wait for all selected
materials before capturing a frame. Ground cover streams in bounded, seeded world
cells, so replaying or seeking a clip restores the same plants. Plants are purely
decorative and never hide the clue: they draw only over rendered terrain, so the
skyline stays the exact terrain silhouette used by validation and answer
explanations, and nothing is drawn within 3 m of the observer. Surface asset
sources and licenses are recorded in `src/assets/environment/README.md`. The export
dialog uses a smaller scene preview; PNG/video captures restore native resolution.

Preferences are remembered locally. Opening Export copies the current scene's
environment; the dialog can adjust it for that image/video. Live views and exports
share the same WebGL effects, seeded vegetation and frame-time animation. Ambient
animation stops while the tab is hidden or the export dialog is open. Reduced-motion
preferences freeze ambient animation in the game; video exports remain animated.

## Developer mode

The **Developer** panel (sidebar) overrides the difficulty's thresholds without touching the defaults. The overrides are:
- distances: true point to distractor, and between options;
- the same-landform rejection;
- the view-difference band (min / target / max);
- the number of distractors;
- minimum view quality and minimum confidence;
- Master's visible-cue minimum and the number of viewpoints it searches;
- "Which way?" direction margins.

**Show computed skyline** draws the engine's ray-marched horizon, the one the quiz is validated against, as a dashed line over the 3D view. On a correctly rendering device it sits exactly on the rendered skyline. Empty fields show the current default in grey. **Apply & regenerate** rebuilds the question on the same terrain. Overrides go into the link as `&dev=minTrue:900,minSep:700`, and opening such a link switches developer mode on. Engine API: `generate({ ..., tuning: { minTrue: 900 } })`. The keys are defined in `TUNABLES` in `src/engine/difficulty.js`.

## Map conventions

Contours are extracted from the final heightmap. Every fifth contour is an index contour and gets elevation labels, with the top of each number facing uphill. Closed depressions get tick marks pointing downhill. Because the segments are oriented, a clockwise closed loop is a depression.

## Extending with new quiz modes

`TerrainAnalyzer.classify(x, y)` returns `summit | knoll | saddle | ridge | spur | valley | reentrant | depression | slope | flat`, and the model exposes slope, aspect, flow accumulation and skylines. Modes like "which point is a saddle?", "steepest slope" or "direction of travel" can reuse the same generator, validator structure and map renderer.

## Layout

```
src/engine/   terrain engine (no DOM, runs in Node and in a Web Worker)
src/render/   webglTerrain.js (first-person scene), mapRenderer.js, compassTape.js
src/ui/       app.js (controller), worker.js
src/export/   composer.js (social frame + weather), recorder.js (WebCodecs/MediaRecorder), mp4.js (muxer)
src/easter/   seasonal Easter eggs: config, schedule (dates/preview), stage (allowed areas), winter, may4, models/
scripts/      dev server, CLI generator, batch stats, debug PNG
test/         node:test suite
```

## Grid method

The Mode menu includes 4 × 4, 6 × 6, 8 × 8 and 16 × 16 grids with references such as A1,
B3 and P16. Tap a cell or enter its code, then check your answer. The **Lost
compass** challenge hides the heading and requires terrain-based orientation.
See [the grid guide](docs/grid-mode.md) for controls, generation and export details.
