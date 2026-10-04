# PDF Remix

Static, client-only PDF page editor (Vite + TypeScript, pdf-lib, pdfjs-dist). Deployed to GitHub Pages by `.github/workflows/deploy.yml`.

- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run dev`.
- Pure logic (page-list ops, undo) lives in `src/model.ts` and the PDF assembly in `src/pdf.ts`. Both are unit-tested. `src/main.ts` is the DOM/UI layer.
- **Privacy invariant:** never add network calls, CDNs, analytics or third-party origins. The CSP lives in `vite.config.ts` and is checked by `src/build.test.ts`.
- `npm run assets` copies the pdf.js fonts, cmaps and wasm into `public/pdfjs/` (gitignored). It runs automatically before `dev` and `build`.
- Plans go in `docs/plans/`.
