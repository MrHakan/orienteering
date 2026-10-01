# Grid method

Choose **Grid method** in the Mode menu, then select **4 × 4**, **6 × 6**, **8 × 8** or
**16 × 16**. Difficulty still controls the terrain, field of view, heading style,
map rotation and the minimum view difference between answers.

## Finding your cell

Rows run north to south: A, B, C, D, up to P for the largest grid. Columns run west
to east: 1, 2, 3, 4, up to 16. The north row is A1, A2, A3, A4… and the next row
starts B1. References stay attached to the terrain when the map rotates. Use
the north arrow to orient a rotated map, or enable **Always north-up**.

The camera stands at the **centre of a cell**, at normal eye height above the
ground. Match the first-person terrain to the contour map, then:

1. Tap a cell, or type a code such as `B3` or `P16`.
2. Review the highlighted selection.
3. Press **Check cell** (or Enter in the input).

Tapping only selects; it does not submit. The text input also provides a keyboard
alternative to the canvas and makes 16 × 16 practical on a small phone.
All grid sizes use row and column headers, keeping cell interiors clear of codes
so the contours stay readable. A single instruction between the view and map
explains the cell reference. Selection highlights the cell and shows its code in
the answer input.

The result highlights the true cell green and a wrong choice red. The view cone
shows the true camera's field of view. Compare the true origin, your chosen cell
and the closest-looking wrong cell using the result buttons. The result does not
create a table or button for every cell.

## Surprise challenge: Lost compass

Choose **Lost compass — surprise challenge** in the Grid challenge menu.
The heading text, arrow, bearing tape and developer skyline overlay are hidden
until answering. The Question panel also hides the bearing. The camera faces one
of the eight compass directions. Infer its orientation from ridge shapes,
foreground slopes and the contours, then submit your cell as usual.

Scoring asks for the cell. Inferring the direction is part of finding it; there
is no second direction answer. After answering, the true bearing is revealed.
Wrong-cell comparison buttons show the direction at that cell that most closely
matches the original view.

## How generation works

The engine uses the existing seeded terrain model and contour validation.
Possible origins are the exact cell centres. It scores walkable origins for
view quality, skyline structure, visible landforms, occlusion and how much of the
view depends on terrain outside the mapped area.

For each promising origin, it compares 49-column view descriptors containing the
skyline and foreground probes at 40, 120 and 350 metres against **every other
cell centre**. Standard mode compares the same heading. Lost compass compares
all eight headings at every other centre and retains the closest match. A
question must meet both a view-difference floor and a confidence floor. If none
qualify, another terrain attempt is made; if the search is exhausted, generation
fails explicitly and the player can choose a new seed.

Master searches more origins and selects from the hardest valid questions. Grid
size changes the number of possible origins, independently of terrain difficulty.
This is a sampled visual comparison rather than a proof that no two continuous
positions on the terrain could look alike; the cell-centre rule makes the tested
answer set finite and explicit.

## Replay and export

Grid links add `m=grid&g=4|6|8|16` to the hash. Lost compass adds
`gc=lost-compass`. Standard heading overrides use the existing `h` field. Seed,
difficulty, position variant and developer tuning continue to travel in links.
Cell references cannot be scrambled. **New positions** keeps the seed and draws
another camera question.

Examples:

- `#seed=grid-check&d=medium&m=grid&g=8`
- `#seed=grid-check&d=medium&m=grid&g=16&gc=lost-compass`

PNG and video exports use the same grid and give a short instruction such as
“Find your cell: A1–P16.” They do not list 256 options. Question frames hide the
origin; answer frames highlight the true cell. Lost compass exports also hide
the heading and tape before the reveal, even when the export tape setting is on.

## Validation

`npm test` includes coordinate boundaries, input validation, rotated pointer
selection, all three grid sizes with both challenges, deterministic replay,
fixed references across variants, heading overrides, all-direction comparison,
short captions and refusal to emit an unvalidated question.
