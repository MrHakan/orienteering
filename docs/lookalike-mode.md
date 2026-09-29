# Look-alikes: selection and validation

The puzzle shows one view and three map positions, A/B/C. All three positions
must produce a similar scene when facing the same compass direction. The
correct point is selected only after the triple passes validation, so selection
does not favour a central point or a point that resembles both distractors.

## Search

1. Build the existing seeded terrain without changing its generator. Sample
   walkable positions across an 18 × 18 jittered grid.
2. Cast one 360° sweep per position and score N, NE, E, SE, S, SW, W and NW.
   Reuse these rays for 13-column approximate descriptors. Reject views that
   are blocked, depend on ground beyond the map, or lack recognisable features.
3. For each heading, build a compatibility graph. An edge requires similar
   skyline angles, foreground angles at 40/120/350 m, skyline depths and ridge
   shapes at two angular scales. Prominent peaks and notches must have a
   counterpart within 14% of the frame width, in both directions: a central
   summit cannot match an empty ramp or a summit outside the frame. Absolute
   angles remain unchanged; no rotation,
   reflection, profile alignment or rescaling hides real differences.
4. Enforce geographical constraints on every edge. Both points must be at least
   the larger of the preset's distance thresholds apart (with a 350 m floor),
   and on different continuous landforms. Similar elevation and slope keep
   terrain colours and shading comparable. Reject nearly collinear triples.
5. Enumerate graph triangles through adjacency intersections. Minimise
   `0.7 × worst pair cost + 0.2 × mean cost + 0.1 × pair-cost range`. Keep at most
   48 triples per heading; the worst pair matters more than a flattering mean.
   If that shortlist has no exact match for the requested heading, extend it
   to at most 192 triples before regenerating terrain. Other headings retain
   the smaller budget.
6. Re-cast every shortlisted vertex at the engine's full 33-column resolution.
   Check all three pairs again, including a minimum visible skyline cue. Pick
   among the three best passing triples for the requested heading, then choose
   the true observer and shuffle A/B/C using separate seeded streams.
7. Run the shared question validator. A failed search retries up to eight seeded
   terrain attempts, then gives an explicit generation error. It never returns
   two options, an indistinguishable triple or a different mode as a fallback.

The maximum pairwise view difference ranges from 3.8° RMS on Easy to 2.3° on
Master. Depth comparisons use the mean absolute log ratio, capped at 0.95;
this prevents one view of a distant skyline matching a close wall merely
because their outlines resemble each other. The answer screen retains the
existing per-option comparison views and names the distinguishing skyline cue.

## Eight directions and replay

The default direction follows a seed-shuffled eight-direction cycle: variants
0–7 visit each direction once, and variant 8 starts the next cycle. An explicit
direction fixes the heading across variants. Every search evaluates all eight
directions, including wraparound at north. Links carry `m=lookalike`, optionally
`dir=NW`, and the existing seed, difficulty, variant, scramble and tuning fields.
As in the other modes, the same terrain attempt has the same heightmap; a retry
can move to a different terrain attempt if the requested heading has no fair
triple. Terrain is never edited to manufacture twins.

## Verification

- Synthetic graph tests reject two independent matches without a third edge
  and prefer a balanced triple over one containing an easy outlier.
- Descriptor tests reject identical views and large depth mismatches.
- Real terrain tests independently re-cast A/B/C in all eight directions and
  verify all three visual and geographical relationships.
- All five difficulties, seeded replay, automatic direction coverage,
  scrambling, captions and explicit failure are covered by the Node suite.
- Browser checks cover worker generation, direction selection, shared links,
  answering, comparison views, mobile layout and exported frames.

Similarity is measured from terrain geometry and view descriptors, not a
pixel-perfect copy. Texture variation remains a feature of the existing
renderer. The player still needs to examine the contours and visible cues.
