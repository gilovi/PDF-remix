# PDF Remix

Remove, reorder and combine PDF pages, privately, in your browser.

**Live app:** https://gilovi.github.io/PDF-remix/

## What it does

- **Remove pages:** click ✕ on a page, or select pages and press Delete.
- **Reorder:** drag pages, or select some and use **Move to position**. Multi-page selections move together.
- **Add pages from other PDFs:** use **Add PDF…**, or drop files onto the page. In the **Files** panel, click pages in the order you want them, then choose where to insert them and click **Insert**. You can also drag them into the document.
- **Preview:** double-click any page to enlarge it, or click **Preview** to see the PDF that will be downloaded.
- **Download** the new PDF.
- **Undo/redo** with Ctrl+Z / Ctrl+Y.

## Privacy

Your files never leave your device:

- There's no server, only static files on GitHub Pages. PDFs are read, rendered ([pdf.js](https://mozilla.github.io/pdf.js/)) and assembled ([pdf-lib](https://pdf-lib.js.org/)) in memory in the page.
- The page ships a strict **Content-Security-Policy** (`connect-src 'self'`, `form-action 'none'`, and no third-party origins). The browser itself blocks the app from sending data anywhere, even by mistake.
- No analytics, cookies, CDNs or external fonts. All pdf.js assets are self-hosted.
- Closing the tab discards everything.

## Development

```bash
npm install
npm run dev        # local dev server
npm run typecheck
npm run lint
npm test
npm run build      # production build into dist/ (includes the CSP)
```

Every push to `main` runs typecheck, lint, tests and the build, then deploys to GitHub Pages (`.github/workflows/deploy.yml`).
