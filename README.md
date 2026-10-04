# PDF Remix

Remove, reorder and combine PDF pages, privately, in your browser.

**Live app:** https://gilovi.github.io/PDF-remix/

## What it does

- **Selecting:** a click selects just that page; clicking it again deselects it. To pick several, Ctrl/Cmd-click to add pages, Shift-click to add a range, or drag a box. Start the box on empty space, or hold the mouse still on a page for a moment and then drag. You can also press **Select**, so each click adds or removes a page. It presses itself as soon as more than one page is selected, and clicking it again un-presses it. Clicking empty space clears the selection.
- **Remove pages:** click ✕ on a page, or select pages and click the red trash button. Removing more than one page asks for confirmation first.
- **Reorder:** drag pages. If several are selected, they move together. **Select all** and **Clear selection** sit above the pages.
- **Add pages from other PDFs:** click **Add PDF…**, or drag files onto the page. While you drag files in, the **Files** panel opens and shows a dotted frame. Select pages in the order you want; numbered badges show that order. Then drag them to the spot you want in your document. You can collapse the Files panel when you don't need it. On phones and tablets, where dragging between panels usually doesn't work, an **Add to end** button appears instead.
- **Preview:** double-click any page to enlarge it, or click **Preview** in the bar at the bottom to see the exact PDF that will be downloaded.
- **Download:** click **Download PDF** in the bottom bar. Your work and undo history stay as they are.
- **Undo/redo** with Ctrl+Z / Ctrl+Y.
- **On phones and tablets:** tap a page to select it. Tap **Select** to pick several, or long-press an unselected page and drag a box. Long-press a *selected* page, then drag it to move it, or to bring it in from the Files panel. The ◀ ▶ buttons move the selected pages one step earlier or later.

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
