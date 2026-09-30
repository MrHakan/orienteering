# Where is your friend?

Choose **Where is your friend?** in Mode. YOU marks the observer on a local contour map. The orange-jacketed, 1.80 m person is standing somewhere else in the 3D view. Choose his map position at A, B or C.

- **Terrain spotting** puts the candidates at different distances and slightly different bearings.
- **Depth trap** puts all three on exactly the same bearing. Direction alone cannot choose a spot: compare the person's apparent size, elevation and the surrounding slopes and contours.
- **Zoom 3×** narrows the field of view while keeping the observer, heading and pitch fixed. It helps inspect a small person on a phone.
- After answering, **Friend at A/B/C** moves the person to each candidate. The camera stays at YOU, even for wrong answers.
- **New positions** changes the observer and the candidates on the same seeded terrain. Replay links record mode, challenge (`fc=depth-trap`), difficulty, variant and heading style. Letter scrambling preserves the person and observer.
- Image and video exports render the same person, observer and local map, with a friend-specific title and caption.
- **Video zoom:** 0–3 s at 1×; 3–5 s gradually zooms to 3×; 5–8 s holds at 3×; 8–10 s gradually returns to 1×. The last 3 seconds use the original view for the answer reveal. The preview follows the same timeline; PNGs remain at 1×. Only the lens changes, with smooth starts and stops.

Example: `#seed=friend-demo&d=medium&m=friend&fc=depth-trap`.

## Geometry and fairness

The person is a small WebGL triangle mesh with a cap, head, torso, two arms, two legs and boots. His height is in metres; he is never enlarged as a screen-space icon. He is drawn with the terrain's projection and depth buffer in both depth passes, so nearer ground can occlude him.

Placement and sightline checks sample the same planar triangles as the rendered ground. Every candidate must be inside the map, on a walkable slope (≤26°), 65–230 m from the observer, at least 45 m from another candidate, and visible at ankle, torso and head height. The true person must have an apparent angular height of at least 0.38°. Every wrong position must differ from the sighting by at least 0.18° in bearing, elevation or angular height. No question with failed visibility or ambiguity checks is emitted.

The map crop contains the observer and all three candidates with padding; its framing does not depend on which candidate is correct. Confidence uses these geometric checks and the existing terrain view quality. Distances, elevations and apparent heights are explained after answering. Generation logs contain no true-target coordinates or label.

`test/friend-quiz.test.js` checks all five difficulties and both challenges, replay, variants, scrambling, local map transforms, physical mesh dimensions and occlusion by a synthetic ridge.
