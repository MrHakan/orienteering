# Environment materials

Surface textures are derived from Poly Haven's CC0 assets:

- [Grass Ground](https://polyhaven.com/a/grass_ground), Charlotte Baglioni.
- [Rock Boulder Dry](https://polyhaven.com/a/rock_boulder_dry), Dimitrios Savva and Rico Cilliers.
- [Brown Mud Rocks 01](https://polyhaven.com/a/brown_mud_rocks_01), Rob Tuytel.
- [Rocky Terrain 02](https://polyhaven.com/a/rocky_terrain_02), Amal Kumar.

[Poly Haven's license](https://polyhaven.com/license): CC0 1.0 public-domain dedication.
Full source metadata, physical sizes and atlas slots are in `materials.json`.

Two 2048×2048 WebP atlases pack four 1008×1008 material cells with eight-pixel
wrapped gutters. RGB stores diffuse color/OpenGL tangent normals; alpha stores
roughness/ambient occlusion respectively. Upload without premultiplying alpha.

`foliage-atlas.webp` is an original AI-generated botanical atlas created for this
project, 2048×2048 with alpha. Slots in row order: green meadow grass, dry meadow
grass, fern, leafy shrub, Scots pine, pine branch. Crossed textured cards and
branch layers provide depth; alpha testing provides terrain occlusion.

All files are served from this repository; rendering uses no external asset API.

`src/render/terrainTextures.js` defines five surface styles using these existing
atlases. Seeded world offsets and scales change the texture pattern; grass/soil
coverage, slope-dependent rock coverage and palettes distinguish meadow,
moorland, autumn, sandstone and alpine scree. The style stream uses the raw quiz
seed independently of terrain/distractor generation. Standard and HD shaders
share the palette and coverage settings; no extra texture downloads are needed.
