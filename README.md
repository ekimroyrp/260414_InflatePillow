# 260414_InflatePillow

260414_InflatePillow is a Vite + TypeScript + Three.js seam authoring tool for sketching stitched outlines on a base plane and inflating them into soft two-sided pillow forms. You can draw multiple outer seams, switch closed shapes into inner seam mode to add chamber lines, round outer and inner seams independently, inflate everything together with a pressure control, and press the inflated mesh to create squishy local dents and rebound ripples with optional foil-balloon shading.

## Features
- Multi-outline seam drawing workflow with click-to-place corners, Enter-to-finish support, and click-start closure for outer and closed inner seams.
- Closed shapes can be selected for inner seam authoring, letting you build chambered pillows from open or looped stitched paths.
- Separate Outer Seam Curvature and Inner Seam Curvature controls round and subdivide seam paths before meshing and inflation.
- Pressure and Subdivision controls let you drive the pillow state while refining the displayed mesh with render-side Loop subdivision plus Laplacian smoothing.
- Custom paired-sheet pillow solver inflates all closed outlines together, preserves stitched seams, and supports squishy press interaction with bounce and ripple response.
- Uniform adaptive triangulation, optional mesh wire overlay, seam curve visibility toggle, and imported fading base grid toggle for inspection.
- Foil Material mode adds reflective iridescent balloon shading, while matte mode keeps a softer non-foil look.
- Undo/redo editing history, OBJ/GLB/screenshot export tools, and a compact floating control panel styled after the reference projects.

## Getting Started
1. `npm install`
2. `npm run dev` to start Vite on `http://localhost:5173`
3. `npm run build` to emit a production bundle through `tsc` + Vite
4. `npm run preview` to inspect the built app locally

## Controls
- **Outer seams:** `LMB` draws seam points, clicking the first point closes the outline, and `Enter` closes the active outer seam when it is valid.
- **Inner seams:** click a closed shape to enter inner seam mode, then `LMB` inside the selected outline adds chamber seam points. Clicking the first chamber point closes a loop, while `Enter` ends the current chamber seam open.
- **Corner editing:** `LMB + Drag` on a seam corner moves it before inflation.
- **History:** `Undo` / `Redo` buttons step through seam edits, with `Ctrl+Z` for undo and `Ctrl+Y` for redo.
- **Simulation:** `Start` builds and runs inflation for every closed outline, `Pause` pauses the active inflated state, `Reset` returns to flat editable seams or clears drafts when nothing is inflated, and `Pressure` controls the inflation target.
- **Mesh detail:** `Subdivision` refines the displayed inflated surface with Loop subdivision and Laplacian smoothing without changing the core solver mesh.
- **Display:** `Seam Curves`, `Base Grid`, `Mesh Wires`, and `Foil Material` toggle seam visibility, the ground grid, wire overlay, and reflective balloon shading.
- **Interaction:** `LMB` on an inflated pillow pushes the mesh locally and releases into a rebound ripple.
- **Camera:** `Mouse Wheel` zooms, `MMB` pans, and `RMB` orbits.
- **Export:** `Export OBJ`, `Export GLB`, and `Export Screenshot` save the current mesh state or viewport image.

## Deployment
- **Local production preview:** `npm install`, then `npm run build` followed by `npm run preview` to inspect the compiled bundle.
- **Publish to GitHub Pages:** From a clean `main`, build with relative paths using `npm run build -- --base=./` or `npx vite build --base ./` after `tsc`. In a separate temp clone or worktree, create/update the `gh-pages` branch with the contents of `dist/`, keep root-relative deploy files minimal (`assets/`, `index.html`, `.nojekyll`, and any required static folders such as `env/`), commit, and `git push origin gh-pages`.
- **Live demo:** https://ekimroyrp.github.io/260414_InflatePillow/
