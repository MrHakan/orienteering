# Where is your friend?

Choose **Where is your friend?** in Mode. The orange-jacketed, 1.80 m person is seen from your own observation point. Choose his map position at A, B or C.

- **Easy** marks your observation point as YOU on a local map. Use bearing, apparent size, elevation and the surrounding contours. Answer comparisons move the person while keeping the camera fixed.
- **Medium and above** leave your position unmarked until the answer. All three candidate targets have plausible observation points at the same range and bearing, with almost identical apparent body heights. Distance alone cannot eliminate a letter: match the skyline, slopes and hollows to infer where you stand and where your friend is.
- Higher levels search more viewpoints and choose more similar terrain. **Expert and Master** also match the target's landform group (for example, valley/re-entrant). Every wrong view still has a visible terrain difference.
- **Depth trap** tightens the elevation-angle tolerance from 0.5° to 0.25° at Medium and above. At Easy, it aligns the targets on a common bearing.
- **Zoom 3×** changes the lens while keeping the observer, heading and pitch fixed. The human remains a physical 1.80 m mesh.
- After answering, **YOU** marks the real observer. At Medium and above, **Friend at A/B/C** shows what you would see from the plausible observation point for each target. These remain observer views looking towards the person, never the person's own view. The map shows the observation point for the active comparison; the answer table describes the distinguishing skyline clue.
- **New positions** changes the observer and candidates on the same seeded terrain. Replay links record mode, challenge (`fc=depth-trap`), difficulty, variant and heading style. Letter scrambling preserves all world positions.
- Image and video exports use the same question rules: hidden observers remain hidden on the question map and appear on the answer map.
- **Video zoom:** 0–3 s at 1×; 3–5 s gradually zooms to 3×; 5–8 s holds at 3×; 8–10 s gradually returns to 1×. The last 3 seconds use the original view for the answer reveal. PNGs remain at 1×.

Example: `#seed=friend-demo&d=master&m=friend&fc=depth-trap`.

## Geometry and fairness

The person is a WebGL triangle mesh with a cap, head, torso, two arms, two legs and boots. His height is in metres, with no artificial scaling. The terrain's projection and depth buffer determine his appearance.

Placement and visibility sample the same planar triangles as the rendered ground. Every target and observation point must be on a walkable slope (≤26°), and the person must be visible at ankle, torso and head height.

At Medium and above:

- Each candidate's target/observer pair uses the same horizontal offset: range is 130–210 m and bearing is identical across all three.
- The elevation angle matches within 0.5° (0.25° for Depth trap). Apparent-height differences are limited to 0.015°, with the true body at least 0.45° tall.
- Targets are separated by at least 280 m. They lie on a fixed full-map frame, so its centre and scale cannot reveal the correct target or observer.
- Terrain descriptors compare the horizon and foreground at 33 bearings. Distractors must be similar enough to remain plausible, yet exceed the difficulty's ambiguity floor. Each wrong answer has a visible skyline difference of at least 1.0–1.4°, inside the wide scene.
- Multiple questions are ranked by terrain similarity before choosing from the hardest three. No question with failed visibility, matching or ambiguity checks is emitted.

Easy retains the introductory geometry: three distance bands, a local map containing all candidates and YOU, at least 45 m between targets, and at least 0.18° of projected difference.

`test/friend-quiz.test.js` covers all difficulties and both challenges, replay, variants, scrambling, map transforms, physical mesh dimensions, terrain occlusion, and hiding/revealing YOU in exports. A separate 15-question session checks that every letter admits the same distance and bearing with less than 1% apparent-height difference, while keeping a visible terrain clue.
