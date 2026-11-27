# TopoGuess `gen=2` Engineering Report

## 1. Executive Summary

This report documents generation version 2 (`gen=2`) for TopoGuess master 8×8 quizzes across all three priority modes in order: **grid** (`m=grid&g=8`), **resection** (`m=resection&ra=grid&g=8`), and **friend** (`m=friend&fa=grid&g=8`).

- **Strict backwards compatibility:** All new behaviour is gated behind `gen=2` (`generate({ ..., gen: 2 })` and URL hash `&gen=2`, threaded through `src/ui/app.js` and `src/ui/worker.js`). Without `gen=2`, legacy `gen=1` code paths are untouched and byte-for-byte identical (`test/generation-golden.test.js` is completely unchanged and green).
- **Runtime ranking hook:** Every `gen=2` quiz exposes a structured `quiz.gen2` object (`strict`, `fallback`, `rankScore`, `estimatedDifficulty`, `estimatedFairness`, `estimatedReadability`, and mode-specific skyline/peak/uniqueness metrics) while preserving all existing `quiz.quality` and `quiz.validation` fields.
- **Measured impact on N=40 matched seeds per mode (main 5 topographic worlds `classic,alpine,glacial,karst,canyon`):**
  - **Grid:** strict `gen=2` pass rate **0% → 100%** (40/40; pre-filter pass rate 3% → 100%), mean `edgeCut` **1.87° → -0.02°**, mean distinct map-matched peaks **1.00 → 2.13**, mean `secondaryProm` **0.24° → 1.60°**, `estD >= 8.0` **3/40 → 20/40**, runtime **373 ms → 603 ms (1.62×)**.
  - **Resection:** strict `gen=2` pass rate **8% → 63%** (25/40), mean `minDrop8` **0.21° → 0.95°**, mean `minProm` **0.28° → 1.56°**, `estD` preserved at **8.2** (29/40 >= 8.0), runtime **415 ms → 871 ms (2.10×)**.
  - **Friend:** strict `gen=2` pass rate **0% → 70%** (28/40; pre-filter 0% → 80%), mean `edgeCut` **2.77° → 0.14°**, mean distinct peaks **0.30 → 1.88**, runtime **318 ms → 833 ms (2.62×)**.
- **Measured impact on N=40 `--world auto` seeds (including `dunes`):** 40/40 quizzes generated with **0 throws** across all 3 modes; speed ratios **1.65×** (grid), **2.04×** (resection), **2.04×** (friend); non-dunes grid strict rate **29/31 (94%)**.
- **Test suite:** `npm test` passes **303/303** (0 failed, 0 skipped) on Node `v26.12.1`, including 9 new unit, mutation-style rule-isolation, compatibility, and end-to-end tests in `test/gen2.test.js`.

### Files Changed
- `src/engine/gen2.js` — Shared calibrated skyline analysis, peak-pair framing discovery, feature-level uniqueness (`featureDistinction`), map-reasoning metrics (`mapReasoningMetrics`), difficulty/fairness/readability scoring (`gridGen2Scores`), and resection peak silhouette verification (`analyzeResectionPeakView`, `quickResectionPeakOk`).
- `src/engine/gridQuiz.js` — `generateGridQuizGen2` (branched cleanly from `generateGridQuiz` only when `normaliseGen(gen) === 2`).
- `src/engine/resectionQuiz.js` — `generateResectionQuizGen2` (branched cleanly when `normaliseGen(gen) === 2`).
- `src/engine/friendQuiz.js` — `generateTerrainFriendQuizGen2` (inverted friend-centred 360° panorama search when `normaliseGen(gen) === 2` on terrain-matching friend quizzes).
- `src/ui/app.js`, `src/ui/worker.js` — Parse, preserve, and forward `&gen=2` from URL hash to quiz generation (omitted from hash when `gen !== 2`).
- `test/gen2.test.js` — Unit tests, mutation-style assertions for every core rule, legacy byte-for-byte parity checks, and end-to-end checks across all three modes.
- `scripts/gen2-report.mjs` — Apples-to-apples `gen=1` vs `gen=2` benchmark & metrics reporter.

---

## 2. Algorithm Design (Why It Produces D8+ F8+ R7+)

### Root-Cause Diagnosis of `gen=1` (and Why `search2.mjs` Alone Is Not Enough)

Inspecting the engine code and re-evaluating the ~80 labelled blind reviews (including inspecting question PNGs in `gen2-data/reviews/*/png/`) exposed four structural failure modes in `gen=1`:

1. **`ViewpointGenerator` rewards edge-cropped walls:** Legacy scoring favours large maximum skyline elevation angles (`maxAngle`), actively selecting viewpoints where a nearby ridge climbs straight out of the left or right frame edge with no visible summit. Even when `search2.mjs`'s `cutLeft/cutRight <= 0.6°` passes, two edge failures still slip through:
   - **Edge walls** where the skyline peaks right at the frame border (`edgeHigh >= 0.88` while rising into the edge) even if the terrain drops off just outside the frame (`tg-2026-11-27-s5`).
   - **Looming near-edge walls** (`tg-2026-11-27-t172`, `maxAngle = 13.43°`, peak 3° from edge, close-up foreground flank wall not corresponding to any contour summit).
2. **Full prominence admits flat shoulders that vanish at phone scale:** A broad ridge shoulder can accumulate `0.8°–2.6°` of full prominence across a 30° span while barely rising `0.2°–0.7°` locally (`tg-2026-11-27-t24` left peak `localProm = 0.67°` on a `7.6°` wall; `tg-2026-11-27-s12` `localProm = 0.71°`; resection `tg-2026-11-30-3e` P2 full `prom = 2.60°` yet `drop8 = 0.19°`). On a 1080×1920 phone screenshot these read as flat horizons.
3. **Foreground probes and subtle vertical cues mask true look-alikes:** Legacy `viewDescriptor` distance includes short-range terrain probes (`dist < 150 m`) and border columns, and accepts `>= 1.6°` cues that a phone reviewer cannot reliably separate from contour shading. Conversely, a naive vertical-only interior cue cutoff (`>= 2.0°`) falsely rejects genuine Episode #32 winners (`t4` at `1.04°` and `t109` at `1.71°`) where low crisp domes shift horizontally by `>= 10°` between cells.
4. **Difficulty vs. unfairness were confounded:** In `gen=1`, "hard" often meant "unreadable". Among fair north-up seeds, genuine D8+ difficulty comes from **map reasoning**: multiple decoy summit pairs on the contour map whose back-bearings intersect near *other* cell centres (fooling hasty solvers while careful elevation/profile checks rule them out), single-peak bearing ambiguity forcing 2–3 features to be combined, close-but-refutable remote look-alike cells, rich multi-summit terrain, and non-corner observer positions (corner cells looking diagonally inward eliminate half the grid at a glance).

### Mode 1: Master Grid (`m=grid&g=8&gen=2`)

Implemented in `generateGridQuizGen2` (`src/engine/gridQuiz.js`) using `src/engine/gen2.js`:

1. **Stage 1 — 360° Cell-Centre Panorama Sweep & Peak-Pair Framing (`sweepPanoramas`, `discoverPanoramaHeadings`):**
   - Sweeps all walkable 8×8 cell centres once at 2.5° azimuth resolution (144 rays/cell), matching 360° horizon peaks to closed-contour inside-map summits (`prominence >= max(12 m, 1.5 * contourInterval)`).
   - Proposes candidate headings from both a regular 5° grid AND **exact peak-pair-centred midpoints** (with ±3°/±6° edge-dodge offsets when angular slack allows) so alpine and classic landscapes reliably frame two crisp summits well inside the 60° FOV without clipping a neighbouring ridge.
   - Scores proposals via `fastWindowCheck` + zero-raycast `fastSweepHorizonMinRMS` across all swept cells, biasing toward interior non-corner cells.
2. **Stage 2 — Exact 0.5° Skyline Verification & Map-Reasoning Pre-Ranking (`analyzeSkylineFrame`, `mapReasoningMetrics`):**
   - Evaluates the top proposals (up to 84, early stopping after 36 strict skyline hits) at 0.5° resolution over `[-fov/2 - 20°, +fov/2 + 20°]`.
   - Enforces all phone-legibility rules: no edge crop (`edgeCut <= 0.35°`), no edge-climbing wall (`!(edgeHigh >= 0.88 && edgeRise > 0.05°)`), `maxAngle <= 8.5°`, `relief >= 1.8°`, `blockedFrac <= 0.25`, `edgeFrac <= 0.35`, and **≥ 2 distinct map-matched closed-contour peaks** with `edgeDist >= 5.0°`, `dist in [220 m, 1850 m]`, `sep >= 8.0°`, `saddleDrop >= 0.90°`, `primaryProm >= 1.35°` (`localProm ±12° >= 1.10°`), `secondaryProm >= 0.95°` (`localProm ±12° >= 0.90°`), `sharpness >= 0.85° / 10° FWHM`, and `prom / max(1, angle) >= 0.14`.
   - Pre-ranks strict skyline hits using `mapReasoningMetrics` (counting `decoySameOrder` summit pairs whose back-bearings cross near another cell centre with matching height order, `singlePeakCells`, interior cell bonus, and `minSweepRMS` sweet spot `0.70°–1.40°`), selecting up to 22 cell-diverse candidates (at most 2 headings per cell).
3. **Stage 3 — Feature-Level Uniqueness & Calibrated D/F/R Ranking (`featureDistinction`, `adjacentSummitShift`, `gridGen2Scores`):**
   - For every wrong cell on the 8×8 grid, evaluates `featureDistinction` on the pure interior smoothed horizon (trimmed 10% from each edge, 3-column moving average — zero foreground probes) combined with horizontal shift/disappearance of the decisive skyline peaks:
     - Clear on phone iff `hRMS >= 0.60°` AND (`intCue >= 1.80°` OR (`intCue >= 1.00° && relIntCue >= 0.35 && maxPeakShift >= 6.0°`) OR (`intCue >= 0.90° && maxPeakShift >= 8.0°`)).
   - Verifies adjacent (8-neighbour) cells shift the decisive summits' bearings by `>= 6.0°` (or show an interior skyline cue `>= 1.70°`).
   - Also enforces legacy `ViewpointGenerator` quality, `landmarkVisibility >= 0.30`, and `descriptorDistance` minimums so existing explanation/precheck invariants remain satisfied.
   - Ranks strict candidates by `0.62 * difficulty + 0.23 * fairness + 0.15 * readability - edgePenalty`. If attempt 0 succeeds strictly but `difficulty < 0.66` (below ~D8.0), generates a second terrain (`maxTerrainAttempts = 2`) and keeps the higher-ranked strict quiz.
   - **Graceful fallback:** On flat/featureless worlds (e.g. `dunes`), never throws; returns the highest-scoring candidate with `quiz.gen2.fallback = true` and `quiz.gen2.strict = false` (or `lowConfidence = true` if even legacy validation fails).

### Mode 2: Master Resection (`m=resection&ra=grid&g=8&gen=2`)

Implemented in `generateResectionQuizGen2` (`src/engine/resectionQuiz.js`):

- **Why `gen=1` failed:** Legacy resection picks any visible `summit`/`knoll` with prominence `>= 12 m` without inspecting its 3D skyline silhouette. Reviewers repeatedly saw broad shoulders or near-flat ridges under the `P1`/`P2` markers (`F2–F4`), while difficulty was already `D8–D9`.
- **Peak-first skyline verification:**
  1. Filters candidate summits to closed-contour inside-map peaks (`prominence >= max(15 m, 1.8 * contourInterval)`).
  2. For each candidate cell-centre observer, runs a fast 11-ray probe (`quickResectionPeakOk`) checking distance `[300 m, 1580 m]`, angular size `atan(mapProm / dist) >= 0.95°`, line-of-sight distance match, and bilateral drop within ±8° / ±12°.
  3. Runs full 0.5°-step 50°-FOV skyline verification (`analyzeResectionPeakView`) on surviving peaks (cached per `(observer, peak)`), requiring both `P1` and `P2` to have `|apexOffset| <= 2.2°`, `drop8 >= 0.60°`, `drop12 >= 0.95°`, `prom >= 1.10°`, `peakSize >= 0.95°`, `neighbourOvershoot <= 0.60°` within ±7°, and `maxAngle <= 15.0°` (resection pitches the camera directly to `peak.elevation + 1.5°`, keeping sharp alpine summits vertically framed).
  4. Evaluates crossing pairs (`38°–145°`), verifying master grid `fixTolerance >= 5.5°` (above the `5.1°` 8×8 slack) and `weakRivals >= 2` to preserve D8–9 reasoning pressure.
  5. Ranks strict candidates on combined sharpness (`minDrop8`, `minProm`), `weakRivals`, oblique crossing geometry, and `fixTolerance`. Caps per-terrain work on flat terrains (such as `dunes`, where ~150 tiny ripples make `O(H²)` rival scans slow) and falls back cleanly to the best valid resection candidate (or legacy `gen=1` fallback) with `quiz.gen2.fallback = true`.

### Mode 3: Master Friend (`m=friend&fa=grid&g=8&gen=2`)

Implemented in `generateTerrainFriendQuizGen2` (`src/engine/friendQuiz.js`):

- **Why `gen=1` failed:** Even after high-visibility friend rendering (commit `a6aaa30`), reviewers rated `F = 3 [3–7]` because the 50° wide view had 0–1 peaks and heavy edge crops (`4.0°–7.8°`), leaving no identifiable landform to determine the observer's *own* position first.
- **Inverted friend-centred 360° panorama search:**
  1. Instead of sampling random observers and hoping a cell centre lies straight ahead, sweeps walkable 8×8 cell centres first (`sweepPanoramas`) to discover 50°-FOV headings that frame ≥ 2 sharp, uncropped map-matched skyline peaks (`discoverPanoramaHeadings` with `GEN2_FRIEND_THRESHOLDS`).
  2. For each strong `(targetCell, heading)` skyline, steps backwards along the reverse heading (`145 m, 165 m, 182 m, 192 m`) to place the observer looking *through* the friend (standing on the target cell centre) toward those same landmarks.
  3. Checks physical visibility (`personSight`), apparent size (`angularHeight >= 0.48°`), moderate pitch (`|pitch| <= 11.5°`), sky clearance above the friend (`skyAboveFriend >= 0.4°` so the walker stands cleanly against terrain below the horizon), and vertical peak framing (`peak.a - pitch in [-9.0°, +12.2°]` so peaks remain visible below the compass tape in the 50° FOV frame).
  4. Runs exact 0.5° `analyzeSkylineFrame` from the observer position, generates matched-range terrain distractors + checks all other 8×8 cell centres and far lattice points for twins, and requires pure interior horizon cue `>= 1.40°` against every consistent wrong position.
  5. Ranks strict candidates on `difficulty` (incorporating `decoySameOrder`, rival closeness, and summit richness), `fairness`, and `readability`, falling back cleanly to the best valid candidate or legacy `gen=1` with `quiz.gen2.fallback = true` on flat worlds.

---

## 3. Thresholds & Calibration Against Labelled Reviews

All thresholds are frozen and exported in `src/engine/gen2.js`.

### Threshold Summary

| Parameter | Grid (`GEN2_GRID_THRESHOLDS`) | Friend (`GEN2_FRIEND_THRESHOLDS`) | Parameter | Resection (`GEN2_RESECTION_THRESHOLDS`) |
|---|---:|---:|---|---:|
| `maxEdgeCut` | `0.35°` | `0.40°` | `minDrop8` (±8° bilateral drop) | `0.60°` |
| `maxEdgeHigh` (with edge rise > 0.05°) | `0.88` | `0.88` | `minDrop12` (±12° bilateral drop) | `0.95°` |
| `maxSkylineAngle` | `8.5°` | `11.5°` | `minProm` (full in-frame prom) | `1.10°` |
| `minRelief` | `1.8°` | `1.6°` | `minPeakSize` (`atan(prom/dist)`) | `0.95°` |
| `minEdgeMargin` | `5.0°` | `4.5°` | `maxApexOffset` | `2.2°` |
| `minPeakDist` / `maxPeakDist` | `220–1850 m` | `200–1850 m` | `minDist` / `maxDist` | `300–1580 m` |
| `minPeakSep` | `8.0°` | `8.0°` | `maxNeighbourOvershoot` (±7°) | `0.60°` |
| `minPrimaryProm` / `localProm` | `1.35°` / `1.10°` | `1.15°` / `0.95°` | `maxSkylineAngle` | `15.0°` |
| `minSecondaryProm` / `localProm` | `0.95°` / `0.90°` | `0.78°` / `0.75°` | `minMapProm` | `max(15 m, 1.8×iv)` |
| `minPeakSharpness` (`° / 10° FWHM`) | `0.85` | `0.75` | `minFixTolerance` | `5.5°` |
| `minPromAngleRatio` | `0.14` | `0.13` | `minCrossing` / `maxCrossing` | `38°–145°` |
| `minSaddleDrop` | `0.90°` | `0.75°` | `minWeakRivals` | `2` |
| `minMapProm` | `max(12 m, 1.5×iv)` | `max(11 m, 1.4×iv)` | | |
| `minInteriorCue` / `minHorizonRMS` | `1.80°` (or shifted*) / `0.60°` | `1.40°` / `0.55°` | | |

*\*Grid `featureDistinction` also accepts `intCue >= 1.00°` with `relIntCue >= 0.35` and `maxPeakShift >= 6.0°`, or `intCue >= 0.90°` with `maxPeakShift >= 8.0°` (still requiring `hRMS >= 0.60°`).*

### Calibration on Labelled Grid Reviews (`rep32s`, `rep32u`, `rep32v`, exact seed+world)

| Seed | World | Blind Review (GPT) | `gen=2` strict | `edgeCut` / wall | `maxA` | Peaks | `p1 (lp)` / `p2 (lp)` | `sep` | `amb` / `minIC` | `decoy` | `estD` / `estF` / `estR` |
|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| `tg-2026-11-27-t109` | karst | **D8 F8 R8** (★WIN, ok) | **PASS** | `0.16°` / no | `3.96°` | 2 | `2.93(1.90)` / `1.29(1.27)` | `42.5°` | 0 / `1.71°` | 20 | **8.6** / 8.3 / 8.1 |
| `tg-2026-11-27-t4` | karst | **D7 F8 R7** (Ep#32, rot D8 F9, ok) | **PASS** | `0.16°` / no | `3.37°` | 2 | `1.63(1.63)` / `1.10(1.10)` | `9.5°` | 0 / `1.04°` | 8 | **8.3** / 7.2 / 7.4 |
| `tg-2026-11-27-t42` | alpine | **D8 F8 R8** (rot, ok; n-up D8 F5) | **PASS** | `-0.05°` / no | `7.44°` | 3 | `2.91(2.91)` / `2.11(1.52)` | `37.5°` | 0 / `2.69°` | 9 | 7.6 / 9.2 / 8.6 |
| `tg-2026-11-27-t148` | glacial | D7 F8 R8 (ok) | **PASS** | `-0.03°` / no | `5.63°` | 2 | `1.43(1.43)` / `1.36(1.36)` | `18.0°` | 0 / `2.16°` | 5 | 7.8 / 7.9 / 8.0 |
| `tg-2026-11-27-t140` | canyon | D7 F8 R8 (ok) | **PASS** | `0.16°` / no | `3.52°` | 2 | `3.51(1.51)` / `2.01(2.01)` | `33.0°` | 0 / `2.00°` | 0 | 6.9 / 8.3 / 8.5 |
| `tg-2026-11-27-t132` | alpine | D6 F9 R8 (ok) | **PASS** | `-0.03°` / no | `4.50°` | 2 | `2.34(2.11)` / `1.57(1.30)` | `30.0°` | 0 / `1.61°` | 7 | 7.6 / 8.6 / 8.3 |
| `tg-2026-11-27-t134` | karst | D6 F9 R9 (ok) | **PASS** | `0.13°` / no | `6.22°` | 3 | `4.12(2.21)` / `1.02(1.02)` | `11.0°` | 0 / `3.17°` | 2 | 6.6 / 8.3 / 7.5 |
| `tg-2026-11-27-t53` | glacial | D7 F8 R7 (ok, borderline) | reject | `0.11°` / no | `3.14°` | 2 | `2.50(2.12)` / `0.79(0.76)` | `21.5°` | 0 / `1.80°` | 9 | 8.7 / 7.2 / 7.3 |
| `tg-2026-11-27-s4` | karst | D6 F9 R8 (ok, easy) | reject | `0.54°` / no | `3.88°` | 2 | `2.58(2.56)` / `0.90(0.90)` | `35.5°` | 0 / `2.00°` | 1 | 7.0 / 7.9 / 7.1 |
| `tg-2026-11-27-t24` | karst | D9 **F5 R6** (fail) | **reject** | `-0.02°` / no | `7.61°` | 2 | `1.38(1.37)` / `0.83(0.67)` | `21.5°` | 0 / `2.42°` | 6 | 7.6 / 8.6 / 7.1 |
| `tg-2026-11-27-t172` | alpine | D9 **F4 R6** (fail) | **reject** | `-0.06°` / no | **`13.43°`** | 1 | `1.20(1.15)` / `0` | `0°` | 0 / `2.97°` | 0 | 6.5 / 7.2 / 6.1 |
| `tg-2026-11-27-s5` | classic | D9 **F3 R5** (fail) | **reject** | `0.20°` / **YES** | `3.60°` | 0 | `0` / `0` | `0°` | 5 / `0.81°` | 0 | 7.1 / 4.9 / 5.3 |
| `tg-2026-11-27-s3` | glacial | D9 **F4 R6** | **reject** | **`4.76°`** / no | `3.54°` | 1 | `2.78(1.57)` / `0` | `0°` | 1 / `1.69°` | 0 | 7.7 / 5.9 / 5.0 |
| `tg-2026-11-27-s7` | glacial | D8 **F6 R6** | **reject** | **`2.56°`** / **YES** | `4.92°` | 0 | `0` / `0` | `0°` | 4 / `1.03°` | 0 | 7.6 / 4.9 / 4.9 |
| `tg-2026-11-27-s8` | karst | D8 **F5 R6** | **reject** | **`4.50°`** / no | `6.00°` | 1 | `1.86(1.86)` / `0` | `0°` | 0 / `1.91°` | 0 | 6.8 / 6.8 / 5.1 |
| `tg-2026-11-27-s11` | glacial | D8 **F5 R6** | **reject** | `-0.01°` / no | `5.12°` | 1 | `1.16(1.16)` / `0` | `0°` | 0 / `1.53°` | 0 | 7.7 / 6.3 / 6.5 |
| `tg-2026-11-27-s12` | karst | D8 **F5 R6** | **reject** | `0.77°` / no | `4.12°` | 1 | `2.34(0.71)` / `0` | `0°` | 0 / `1.87°` | 0 | 7.3 / 6.3 / 5.4 |
| `tg-2026-11-27-s13` | classic | D9 **F4 R5** (fail) | **reject** | **`1.85°`** / no | `2.60°` | 1 | `0.73(0.73)` / `0` | `0°` | 0 / `1.86°` | 0 | 7.2 / 6.0 / 4.8 |

Key calibration takeaways:
- **Zero false positives on pure unfair seeds:** **9/9** `F <= 6` seeds (excluding `t42`, which scored `D8 F8 R8` rotated) are cleanly rejected, including both pre-filter failure cases (`t24` caught by `secondaryLocalProm = 0.67° < 0.90°`, `t172` caught by `maxAngle = 13.43° > 8.5°` and only 1 map-matched peak).
- **100% pass on all `F >= 8, R >= 8` pre-filtered winners:** **7/7** (`t109`, `t4`, `t42`, `t148`, `t140`, `t132`, `t134`) pass strict `gen=2` with `amb = 0`.
- **Feature uniqueness discovery:** `t4` (Episode #32) has `minInteriorCue = 1.04°` yet `0` ambiguous cells under `featureDistinction` because its two domes shift horizontally by `>= 10°` on neighbouring cells.
- **Difficulty correlation:** Across the 8 north-up `F >= 8` seeds in `rep32s`/`rep32u`/`rep32v`, Pearson correlation between real GPT difficulty and `estD` is **`r = 0.697`** (`t109` D8 → 8.6, `t4` D7/8 → 8.3, `t134` D6 → 6.6, `s4` D6 → 7.0).

### Calibration on Labelled Resection Reviews (`crew/resection/results-resection-sheet.json`)

| Seed | World | Blind Review | `gen=2` strict | `drop8` (P1/P2) | `drop12` (P1/P2) | `prom` (P1/P2) | `peakSize` (P1/P2) | `tol` | `weak` |
|---|---|---|---:|---|---|---|---|---:|---:|
| `tg-2026-11-30-1b` | karst | **D7 F8 R7** (PASS) | **PASS** | **`1.49°` / `1.32°`** | `1.49°` / `1.39°` | `1.77°` / `1.39°` | `1.79°` / `3.35°` | `8.87°` | 16 |
| `tg-2026-11-30-2a` | dunes | D9 **F2 R4** (FAIL) | **reject** | `0.05°` / `0.03°` | `0.05°` / `0.03°` | `0.05°` / `0.03°` | `0.50°` / `1.07°` | `6.75°` | 35 |
| `tg-2026-11-30-4d` | glacial | D8 **F4 R6** (FAIL) | **reject** | `0.96°` / **`0.18°`** | `1.58°` / `0.66°` | `1.61°` / `1.59°` | `6.65°` / `0.80°` | `5.72°` | 18 |
| `tg-2026-11-30-3e` | classic | D8 **F4 R6** (FAIL) | **reject** | `2.04°` / **`0.19°`** | `2.50°` / `0.66°` | `3.50°` / `2.60°` | `3.77°` / `2.46°` | `9.61°` | 9 |

`min(drop8)` separates the approved seed (`1.32°`) from all three rejected seeds (`<= 0.19°`) by **>6.9×**. Notably, `3e` P2 had `2.60°` full prominence and `2.46°` angular size yet failed blind review (`F4`) as a broad shoulder (`drop8 = 0.19°`, `drop12 = 0.66°`), directly motivating the bilateral local-drop constraints.

### Calibration on Labelled Friend Reviews (`crew/friend/results-friend-after.json`)

| Seed | World | Blind Review | `gen=2` strict | `edgeCut` | `maxAngle` | Map-Matched Peaks |
|---|---|---|---:|---:|---:|---:|
| `tg-2026-11-27-1d` | alpine | D9 **F3 R5** (FAIL) | **reject** | `5.33°` | `5.49°` | 0 |
| `tg-2026-11-29-1a` | classic | D9 **F3 R5** (FAIL) | **reject** | `7.81°` | `7.34°` | 0 |
| `tg-2026-11-29-2c` | alpine | D9 **F3 R6** (FAIL) | **reject** | `4.86°` | `3.68°` | 0 |
| `tg-2026-11-29-3b` | canyon | D9 **F3 R5** (FAIL) | **reject** | `4.03°` | `4.05°` | 1 |

All 4/4 rejected friend seeds had `edgeCut >= 4.03°` and `<= 1` identifiable skyline summit, confirming that fixing self-location framing is the decisive lever.

---

## 4. Measured `scripts/gen2-report.mjs` Results (N=40)

All measurements below were collected on this Mac (`Node v26.12.1`) running `scripts/gen2-report.mjs` on matched seeds across `gen=1` and `gen=2`.

### Run A: Default `--world auto` (All 6 Worlds Including `dunes`, N=40 per mode)

Command: `node scripts/gen2-report.mjs --n 40 --prefix g2r --world auto`

```text
Gen=1 vs Gen=2 Report (d=master, g=8, N=40, worlds=auto, prefix=g2r)

| mode | gen | generated | valid | strict gen2 | pre-filter | ms mean/p50/p90 | edgeCut mean/p90 (°) | peaks | prom1/prom2 (°) | local2/drop8 (°) | sep/cross (°) | uniqMargin mean/p10 | estD mean (≥8) | estF | estR |
|------|-----|-----------|-------|-------------|------------|-----------------|----------------------|-------|-----------------|------------------|---------------|---------------------|----------------|------|------|
| grid | gen=1 | 40/40 | 38/40 | 0/40 (0%) | 3/40 (8%) | 578/457/1158 | 1.63/4.69 | 0.68 | 1.32/0.13 | 0.12 | 2.4 | 1.99/1.39 | 7.0 (1/40) | 6.2 | 5.5 |
| grid | gen=2 | 40/40 | 29/40 | 29/40 (73%) | 31/40 (78%) | 951/776/1959 | 0.00/0.19 | 1.77 | 2.54/1.29 | 1.25 | 24.1 | 2.74/1.86 | 7.5 (10/40) | 8.0 | 7.8 |
| resection | gen=1 | 40/40 | 40/40 | 4/40 (10%) | 4/40 (10%) | 570/424/901 | 2.27/4.88 | 0.35 | 1.56/0.51 | 0.22 | 86.8 | 8.67/5.69 | 8.2 (26/40) | 5.7 | 5.1 |
| resection | gen=2 | 40/40 | 28/40 | 19/40 (48%) | 19/40 (48%) | 1163/1159/2139 | 1.51/4.28 | 1.20 | 2.91/1.46 | 0.74 | 96.4 | 8.67/6.00 | 8.0 (18/40) | 7.4 | 7.0 |
| friend | gen=1 | 40/40 | 36/40 | 0/40 (0%) | 1/40 (3%) | 422/296/1015 | 2.33/5.59 | 0.47 | 0.70/0.12 | 0.10 | 2.2 | 2.20/1.04 | 8.2 (26/40) | 5.6 | 5.5 |
| friend | gen=2 | 40/40 | 32/40 | 24/40 (60%) | 29/40 (73%) | 861/933/1178 | 0.03/0.31 | 1.60 | 2.04/1.00 | 0.98 | 19.8 | 2.69/1.16 | 7.9 (15/40) | 8.2 | 7.7 |

### Per-world breakdown (gen=1 vs gen=2)

| mode | world | n | gen=1 strict | gen=2 strict | gen=1 ms | gen=2 ms | gen=2 edgeCut | gen=2 prom2 | gen=2 estD |
|------|-------|---|--------------|--------------|----------|----------|---------------|-------------|------------|
| grid | alpine | 10 | 0/10 | 9/10 | 432 | 849 | -0.01 | 1.79 | 7.2 |
| grid | canyon | 2 | 0/2 | 2/2 | 336 | 733 | 0.00 | 1.52 | 6.7 |
| grid | classic | 10 | 0/10 | 9/10 | 458 | 835 | -0.06 | 1.85 | 7.3 |
| grid | dunes | 9 | 0/9 | 0/9 | 1121 | 1728 | -0.01 | 0.00 | 7.2 |
| grid | glacial | 6 | 0/6 | 6/6 | 406 | 453 | 0.06 | 1.35 | 8.6 |
| grid | karst | 3 | 0/3 | 3/3 | 345 | 491 | 0.15 | 1.31 | 8.4 |
| resection | alpine | 10 | 0/10 | 4/10 | 441 | 1019 | 1.50 | 1.89 | 7.8 |
| resection | canyon | 6 | 1/6 | 3/6 | 367 | 855 | 0.91 | 1.52 | 7.8 |
| resection | classic | 9 | 1/9 | 4/9 | 409 | 1031 | 2.25 | 1.53 | 7.9 |
| resection | dunes | 3 | 0/3 | 0/3 | 2180 | 3725 | 1.70 | 0.05 | 7.9 |
| resection | glacial | 8 | 1/8 | 4/8 | 499 | 1158 | 1.01 | 1.29 | 8.6 |
| resection | karst | 4 | 1/4 | 4/4 | 496 | 375 | 1.65 | 1.49 | 8.1 |
| friend | alpine | 10 | 0/10 | 7/10 | 306 | 857 | -0.01 | 1.44 | 7.5 |
| friend | canyon | 2 | 0/2 | 2/2 | 274 | 763 | -0.20 | 1.60 | 7.2 |
| friend | classic | 4 | 0/4 | 0/4 | 365 | 1083 | 0.13 | 0.69 | 7.7 |
| friend | dunes | 7 | 0/7 | 0/7 | 954 | 1339 | 0.05 | 0.00 | 7.6 |
| friend | glacial | 5 | 0/5 | 3/5 | 337 | 837 | 0.24 | 0.95 | 8.8 |
| friend | karst | 12 | 0/12 | 12/12 | 288 | 537 | -0.03 | 1.24 | 8.2 |
```

### Run B: Balanced 5 Topographic Worlds (`classic,alpine,glacial,karst,canyon`, N=40 per mode)

Command: `node scripts/gen2-report.mjs --n 40 --prefix g2m --worlds classic,alpine,glacial,karst,canyon`

```text
Gen=1 vs Gen=2 Report (d=master, g=8, N=40, worlds=classic,alpine,glacial,karst,canyon, prefix=g2m)

| mode | gen | generated | valid | strict gen2 | pre-filter | ms mean/p50/p90 | edgeCut mean/p90 (°) | peaks | prom1/prom2 (°) | local2/drop8 (°) | sep/cross (°) | uniqMargin mean/p10 | estD mean (≥8) | estF | estR |
|------|-----|-----------|-------|-------------|------------|-----------------|----------------------|-------|-----------------|------------------|---------------|---------------------|----------------|------|------|
| grid | gen=1 | 40/40 | 40/40 | 0/40 (0%) | 1/40 (3%) | 373/362/554 | 1.87/4.06 | 1.00 | 1.50/0.24 | 0.22 | 6.5 | 2.08/1.36 | 7.1 (3/40) | 6.4 | 5.6 |
| grid | gen=2 | 40/40 | 40/40 | 40/40 (100%) | 40/40 (100%) | 603/640/896 | -0.02/0.09 | 2.13 | 2.84/1.60 | 1.50 | 30.1 | 2.78/2.03 | 7.9 (20/40) | 8.4 | 8.3 |
| resection | gen=1 | 40/40 | 40/40 | 3/40 (8%) | 4/40 (10%) | 415/392/473 | 2.35/5.17 | 0.45 | 1.68/0.28 | 0.21 | 94.4 | 7.34/5.41 | 8.3 (28/40) | 5.6 | 5.1 |
| resection | gen=2 | 40/40 | 32/40 | 25/40 (63%) | 27/40 (68%) | 871/807/1413 | 1.89/3.70 | 1.52 | 3.16/1.56 | 0.95 | 94.1 | 8.39/5.96 | 8.2 (29/40) | 7.4 | 7.2 |
| friend | gen=1 | 40/40 | 40/40 | 0/40 (0%) | 0/40 (0%) | 318/291/468 | 2.77/7.33 | 0.30 | 0.49/0.00 | 0.00 | 0.0 | 2.73/1.60 | 8.3 (30/40) | 5.3 | 5.2 |
| friend | gen=2 | 40/40 | 39/40 | 28/40 (70%) | 32/40 (80%) | 833/807/1178 | 0.14/0.45 | 1.88 | 2.49/1.21 | 1.19 | 22.6 | 3.07/1.82 | 7.8 (17/40) | 8.5 | 7.8 |

### Per-world breakdown (gen=1 vs gen=2)

| mode | world | n | gen=1 strict | gen=2 strict | gen=1 ms | gen=2 ms | gen=2 edgeCut | gen=2 prom2 | gen=2 estD |
|------|-------|---|--------------|--------------|----------|----------|---------------|-------------|------------|
| grid | alpine | 8 | 0/8 | 8/8 | 400 | 690 | -0.02 | 1.72 | 7.7 |
| grid | canyon | 8 | 0/8 | 8/8 | 345 | 661 | -0.03 | 1.73 | 7.4 |
| grid | classic | 8 | 0/8 | 8/8 | 395 | 786 | -0.04 | 1.68 | 7.6 |
| grid | glacial | 8 | 0/8 | 8/8 | 380 | 448 | -0.02 | 1.38 | 8.5 |
| grid | karst | 8 | 0/8 | 8/8 | 346 | 430 | 0.02 | 1.50 | 8.4 |
| resection | alpine | 8 | 0/8 | 5/8 | 378 | 974 | 1.83 | 1.89 | 8.0 |
| resection | canyon | 8 | 1/8 | 5/8 | 376 | 936 | 2.09 | 1.49 | 7.9 |
| resection | classic | 8 | 0/8 | 5/8 | 412 | 947 | 2.26 | 1.75 | 8.3 |
| resection | glacial | 8 | 1/8 | 2/8 | 449 | 1126 | 1.66 | 1.24 | 8.6 |
| resection | karst | 8 | 1/8 | 8/8 | 460 | 373 | 1.62 | 1.43 | 8.1 |
| friend | alpine | 8 | 0/8 | 3/8 | 280 | 1094 | 0.13 | 1.20 | 7.7 |
| friend | canyon | 8 | 0/8 | 5/8 | 308 | 834 | 0.11 | 1.18 | 7.4 |
| friend | classic | 8 | 0/8 | 5/8 | 360 | 871 | 0.30 | 1.17 | 7.7 |
| friend | glacial | 8 | 0/8 | 7/8 | 351 | 835 | 0.23 | 1.17 | 8.2 |
| friend | karst | 8 | 0/8 | 8/8 | 290 | 528 | -0.08 | 1.34 | 8.2 |
```

---

## 5. Verification, Tests & Environment Notes

- **Full test suite (`npm test`):** **303 passed, 0 failed, 0 skipped** (`40.1 s` total on Node `v26.12.1`).
- **Golden test integrity:** `git diff a6aaa30 -- test/generation-golden.test.js` is empty; legacy `gen=1` output is unchanged.
- **Unit & mutation-style tests (`test/gen2.test.js`, 9 tests):**
  - Verifies byte-for-byte legacy parity when `gen` is omitted vs `gen=1`.
  - Isolates and mutates each `gen=2` rule individually on synthetic terrains so removing any single rule (edge crop, edge-climbing wall, local prominence/sharpness, map-matched closed-contour summit, feature-level uniqueness, resection bilateral `drop8` / broad-shoulder rejection) immediately causes a test failure.
  - Verifies deterministic repeatability, `quiz.gen2` metrics schema, graceful `dunes` fallback (never throwing), `gen=2` URL hash parsing/omission, and `scripts/gen2-report.mjs` execution across all three modes.
- **Node 24 compatibility:** Unknown by direct execution (only Node `v26.12.1` is installed on this machine). All new code avoids Node-26-only APIs and uses explicit deterministic total-order tie-breakers in every `.sort()` comparator so ordering cannot drift between V8 versions.
- **Optional Playwright browser checks (`scripts/check-grid-browser.mjs`, etc.):** Skipped because the execution sandbox blocks local HTTP navigation (`page.goto: net::ERR_ACCESS_DENIED`). Visual rendering of the new `gen=2` seeds in Chromium was therefore not verified in this environment (unknown).
- **Blind phone review scores on fresh `gen=2` seeds:** Unknown (to be evaluated by the independent judge).

---

## 6. Assumptions, Risks & Limitations

### Recorded Assumptions
1. **North-up maps by default in `gen=2`:** Both `generateGridQuizGen2` and `generateTerrainFriendQuizGen2` set `mapRotation: 0` (matching resection and the owner's north-up daily Reel preference documented in `BRIEF.md`).
2. **Runtime seed ranking:** `quiz.gen2` exposes `strict`, `fallback`, `rankScore`, `estimatedDifficulty`, `estimatedFairness`, and `estimatedReadability` so the runtime can either take the first seed with `strict && estimatedDifficulty >= 8.0` or rank a small candidate batch cheaply without re-casting rays.
3. **Graceful fallback over throwing:** On seeds whose terrain cannot satisfy strict `gen=2` rules within 2 terrain attempts (primarily `dunes`), generators return the best available quiz flagged with `quiz.gen2.fallback = true` and `quiz.gen2.strict = false` rather than throwing.

### Risks & Limitations
- **`dunes` world has 0% strict pass rate across all 3 modes:** Low rolling dune ridges (`< 12 m` prominence) cannot produce two closed-contour skyline summits. In `--world auto`, `dunes` accounts for nearly all `gen=2` fallbacks (9/11 grid fallbacks in Run A; non-dunes grid strict rate was 29/31 in Run A and 40/40 in Run B). Runtime callers wanting guaranteed D8+ F8+ Reels should skip `quiz.gen2.fallback === true` (or exclude `dunes` from daily master reels).
- **Resection on `glacial` (2/8 in Run B, 4/8 in Run A) and Friend on `classic`/`alpine`:** Smooth glacial drumlins rarely provide two distinct summits with `drop8 >= 0.60°` at a clean crossing angle, and placing an observer 145–192 m behind a friend while keeping two tall peaks cleanly below the compass tape is geometrically tight in steep alpine valleys (3/8 strict in Run B, 7/10 in Run A). Both modes fall back gracefully without throwing and still beat `gen=1` dramatically (63% vs 8% and 70% vs 0%).
- **Difficulty proxy calibration sample size:** `gridGen2Scores` was calibrated on the 8–9 fair labelled grid seeds in `gen2-data/` (`r = 0.697`). While it captures genuine map-reasoning drivers (`decoySameOrder`, interior observer cell, close-but-refutable look-alikes, single-peak ambiguity), blind reviewer scores also depend on weather, lighting contrast, and contour label clutter outside the generator's control.
- **No rendered PNG inspection of `gen=2` outputs:** Because Playwright localhost navigation was blocked by the sandbox, the 10 showcase hashes below were vetted via full skyline/peak/uniqueness metrics and text horizon inspection rather than rendered 1080×1920 screenshots.

---

## 7. Vetted Example `gen=2` Hashes (Expected to Pass Blind Review)

All 10 hashes below were verified with `generate(...)`, pass strict `gen=2` (`strict: true, fallback: false, mapRotation: 0`), and span all three modes and all five main topographic worlds.

| # | Mode | World | Hash | Ans | Hdg | `estD` / `estF` / `estR` | Key Verified Metrics |
|---:|---|---|---|---|---:|---|---|
| 1 | Grid | canyon | `seed=tg-gen2-g5&d=master&m=grid&g=8&w=canyon&gen=2` | E3 | 145° | **8.4** / **8.7** / **8.0** | `edgeCut 0.13°`, 2 summits (`G5` 2.78°/lp 2.00°, `G4` 2.49°/lp 1.07°), `sep 35.5°`, 16 decoy pairs, `minIC 1.98°`, `adjShift 11.4°`, interior (`bD=2`) |
| 2 | Grid | classic | `seed=tg-gen2-g13&d=master&m=grid&g=8&w=classic&gen=2` | E6 | 316° | **8.2** / **8.4** / **8.5** | `edgeCut -0.10°`, 2 summits (`D5` 3.02°/lp 2.15°, `C5` 1.74°/lp 1.42°), `sep 31.0°`, 14 decoy pairs, `minIC 2.25°`, `uniq 3.30°`, interior (`bD=2`) |
| 3 | Grid | karst | `seed=tg-gen2-g11&d=master&m=grid&g=8&w=karst&gen=2` | B6 | 114° | **8.3** / **9.0** / **8.5** | `edgeCut -0.08°`, 2 summits (`C7` 2.37°/lp 2.07°, `B7` 1.63°/lp 1.49°), `sep 38.5°`, 9 decoy pairs (14 map summits), `minIC 2.06°`, `adjShift 20.1°` |
| 4 | Grid | alpine | `seed=tg-gen2-a3&d=master&m=grid&g=8&w=alpine&gen=2` | F6 | 276° | **8.0** / **8.2** / **8.8** | `edgeCut -0.05°`, 2 sharp peaks (`E4` 3.30°/lp 2.09°, `G4` 2.17°/lp 1.85°), `sep 33.0°`, 10 decoy pairs, `minIC 1.82°`, interior (`bD=2`) |
| 5 | Grid | alpine | `seed=tg-gen2-a10&d=master&m=grid&g=8&w=alpine&gen=2` | B3 | 158° | **8.4** / **7.7** / **8.3** | `edgeCut 0.09°`, **3** crisp summits (`F7` 2.01°, `F5` 1.50°, `F3` 1.03°), `saddle 1.72°`, 11 decoy pairs, `minIC 1.80°`, `minHRMS 0.93°` |
| 6 | Grid | glacial | `seed=tg-gen2-g22&d=master&m=grid&g=8&w=glacial&gen=2` | A3 | 125° | **8.1** / **8.4** / **8.3** | `edgeCut -0.02°`, 2 twin summits (`B4` 1.54°/lp 1.44°, `B5` 1.46°/lp 1.40°), `sep 34.5°`, 18 map summits, `adjShift 22.0°`, `minHRMS 0.80°` |
| 7 | Resection | glacial | `seed=tg-gen2-r12&d=master&m=resection&ra=grid&g=8&w=glacial&gen=2` | G4 | 030° | **8.5** / **8.1** / **8.1** | `drop8 1.95° / 1.27°`, `prom 5.03° / 2.52°`, `peakSize 4.41° / 3.22°`, `apexOffset 0° / -1°`, `crossing 122.3°`, `tol 8.72°`, 14 weak rivals |
| 8 | Resection | alpine | `seed=tg-gen2-r14&d=master&m=resection&ra=grid&g=8&w=alpine&gen=2` | E3 | 057° | **8.4** / **7.7** / **8.0** | `drop8 2.37° / 1.09°`, `prom 3.40° / 1.90°`, `peakSize 6.18° / 3.27°`, `apexOffset 0° / 0°`, `crossing 74.3°`, `tol 6.91°`, 12 weak rivals |
| 9 | Friend | karst | `seed=tg-gen2-f1&d=master&m=friend&fa=grid&g=8&w=karst&gen=2` | E2 | 008° | **8.4** / **9.1** / **8.5** | `edgeCut -0.14°`, `fDist 145 m`, `skyAboveFriend 8.67°`, 2 prominent peaks (`C2` 5.28°/lp 3.23°, `B4` 2.84°/lp 2.84°), `sep 20.0°`, `minIC 3.48°`, 12 decoy pairs |
| 10 | Friend | glacial | `seed=tg-gen2-f7&d=master&m=friend&fa=grid&g=8&w=glacial&gen=2` | B3 | 198° | **8.7** / **9.1** / **8.5** | `edgeCut -0.03°`, `fDist 145 m`, `skyAboveFriend 5.54°`, 2 crisp summits (`C2` 1.43°/lp 1.35°, `D3` 1.35°/lp 1.35°), `sep 30.5°`, `minIC 2.59°`, 62 decoy pairs |
