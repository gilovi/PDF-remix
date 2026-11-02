# PDF Remix

Static, client-only PDF page editor (Vite + TypeScript, pdf-lib, pdfjs-dist). Deployed to GitHub Pages by `.github/workflows/deploy.yml`.

- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run dev`.
- Pure, unit-tested logic: page-list ops and undo in `src/model.ts`, PDF assembly in `src/pdf.ts`, image-to-PDF conversion in `src/image.ts` (except its canvas re-encoding, which needs a browser), selection rules in `src/selection.ts`, keyboard shortcuts in `src/shortcuts.ts`, overlay items in `src/overlay.ts`, page coordinates in `src/coords.ts`, and Hebrew/English text layout in `src/textlayout.ts` (fontkit reverses RTL runs itself, so Hebrew runs must stay in typed order). zoom maths in `src/zoom.ts`, and item geometry in `src/overlayGeometry.ts`. `src/editor.ts` is the Fill & Sign dialog and `src/overlayView.ts` draws items on screen. `src/pdfOverlays.ts` draws overlays into the PDF; `src/fonts.ts` holds fontkit and the fonts and must only be imported dynamically. `src/main.ts` is the DOM/UI layer.
- **Privacy invariant:** never add network calls, CDNs, analytics or third-party origins. The CSP lives in `vite.config.ts` and is checked by `src/build.test.ts`.
- `npm run assets` copies the pdf.js fonts, cmaps and wasm into `public/pdfjs/` (gitignored). It runs automatically before `dev` and `build`.
- Plans go in `docs/plans/`.
