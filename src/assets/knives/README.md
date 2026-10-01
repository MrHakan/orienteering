# Knife source clips

These clips were supplied by the project owner for the bunny-hop trail mode.

- `butterfly.mp4`: attachment `videoplayback-1.mp4`, H.264, 1280 × 720, 30 fps, 35.6 s.
- `default.mp4`: attachment `videoplayback-2.mp4`, H.264, 1280 × 720, 60 fps, 8.333 s.
- `classic.mp4`: attachment `videoplayback-3.mp4`, cropped from 1920 × 1080 to 1440 × 1080 to remove the black 240-pixel sidebars; H.264, 30 fps, 2.667 s. Green remains in the asset and is removed at runtime.

All three are re-encoded with H.264 keyframes every 0.5 s and fast-start metadata to keep timeline seeking inexpensive; content, frame rate and duration are preserved.

The game renders the original hands and blade together. No mesh generation, artificial recolouring, character substitution or baked terrain is used. Source timings live in `src/render/knifeClips.js`. Relative URLs keep assets in the same versioned release as the module graph on Pages.
