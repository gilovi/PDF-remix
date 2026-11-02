# Fill & Sign: plan

## Goal
Let the user annotate pages in the browser, then export them as part of the normal PDF output:
1. Text boxes in Hebrew, English or both.
2. Spaced numbers, for forms with one box per digit.
3. An X mark.
4. A signature, drawn or uploaded, and optionally saved locally for reuse.

Every item can be dragged, resized and deleted, and undo covers all of it. The page view can zoom in so that small fields can be filled accurately.

**Privacy stays a hard requirement:** no network calls, CDNs or third-party origins. Fonts are self-hosted, and passkeys are used without a server.

## Non-goals (first version)
- Cryptographic digital signatures (PAdES). This places a picture of a signature.
- Filling real PDF form fields. Items sit on top of the page.
- Syncing saved signatures between devices. The vault belongs to one browser profile, even when the passkey itself syncs.
- A Hebrew app interface. The interface stays in English; only the content supports Hebrew.
- Scripts other than Hebrew and basic Latin. Characters the fonts lack get a visible warning in the editor.

## What the spike established (2026-11-02)
`pdf-lib` + `@pdf-lib/fontkit` + `bidi-js` + Heebo was tested on 18 strings: mixed direction, IDs, dates, ₪, brackets, niqqud, email and percent.

| Approach | Result |
|---|---|
| Draw the string as typed | Pure Hebrew is correct; mixed text shows empty boxes, because each font file covers one script |
| Reorder with bidi, then `drawText` | Hebrew letters come out backwards, because fontkit also reverses RTL script. Niqqud throws (`reading 'xCoordinate'`) |
| Draw each character separately | Looks correct, but loses kerning and scrambles copied niqqud |
| **Logical runs placed in visual order** (Appendix A) | **Correct for all 18 strings** |

- Output was compared by eye with Chrome's layout of the same strings. pdf.js and MuPDF rendered it identically.
- Export of one mixed string also ran in headless Chrome under the app's exact CSP, with no violations. A text search of the minified `fontkit` and `bidi-js` builds found no `eval` or `new Function`.
- Pure Hebrew copies out in the right order. Mixed lines can extract in visual word order, which is an accepted limitation.
- `fontkit` is about 715 KB minified, so it must load lazily. The two Heebo files total 22 KB.

**Not yet verified:** the real Vite build, Acrobat, multi-line text and rotated pages. Phase 1 covers all of these except Acrobat, which is a manual check in Phase 2.

## Design

### Overlay model (`src/overlay.ts`, pure, unit-tested)
Items live on the page placement, like `rotation`, so `History` provides undo and redo for free. Removing a page removes its items, and undoing that restores them.

```ts
interface PageRef { /* existing fields */ overlays?: Overlay[] }

type Overlay = { id: string; x: number; y: number; angle: 0 | 90 | 180 | 270 } & (
  | { kind: 'text'; text: string; size: number }
  | { kind: 'comb'; digits: string; size: number; pitch: number }
  | { kind: 'mark'; w: number; h: number }
  | { kind: 'image'; assetId: string; w: number; h: number }
  | { kind: 'vector'; assetId: string; w: number; h: number } // added in Phase 3
);
```

- **Units:** PDF points, relative to the source page's crop box, in unrotated page space. Zoom therefore never changes stored geometry.
- **`angle`:** the page's total display rotation when the item was placed, so an item placed on a turned page reads upright. Rotating the page later turns its items with it.
- **Resize rules:** every kind keeps its proportions. Text changes `size`. Spaced numbers scale `size` and `pitch` together, and `pitch` also has its own buttons. All have minimum sizes.
- **Commits:** one `History` entry per finished gesture (drag end, resize end, text box blur), not per pointer move or keystroke.
- **Text:** line breaks are explicit (Enter), with no automatic wrapping. Each line gets its own bidi pass, and RTL lines align to the right of the box.
- **Spaced numbers:** digits only, always left to right, each centred in its slot.
- **Signature assets:** PNG bytes and vector path data are kept in an in-memory store by `assetId` (`src/signatures.ts`), outside `History`, so undo doesn't copy them. Removing a signature from the list keeps it there, as placed items still need it.

### Coordinates (`src/coords.ts`, pure, unit-tested)
`pageToView` and `viewToPage` convert between page points and on-screen pixels for any combination of the page's own rotation, the added rotation, crop box offset and zoom. A round trip must be exact for all four rotations.

### Text layout (`src/textlayout.ts`, pure, unit-tested)
Appendix A moved into TypeScript. It returns ordered runs of `{ text, font, level }`. Glyph coverage is passed in, so tests don't need font files.

### Export (`src/pdf.ts`)
`buildPdf` gains an assets argument and draws each placement's items after adding the page. Each placement is already a separate page copy, so duplicates stay independent.

`fontkit` and the fonts load through dynamic import only when an output contains text items, so ordinary exports stay as light as today.

### Fonts
Add `@fontsource/heebo` (OFL) and use its Hebrew and Latin files from our own origin. The same files back an `@font-face` with `unicode-range` in the editor, so on-screen text matches the export. Include the font licence in the build.

### Editor (`src/editor.ts`, plus pure helpers)
A full-screen dialog opened from a page card or the bottom bar, not added to `main.ts` beyond wiring.

- **Layers:** a canvas page underneath, with a DOM item layer on top.
- **Entry point:** the Fill & Sign button in the bottom bar only, with no per-page button.
- **Toolbar:** Hand, Text, Numbers, X, Signature, zoom controls, previous/next page, Done.
- **Sticky tools:** a chosen tool stays on, so each click on an empty spot adds another item, until its button is clicked again, Esc, or the Hand. A click outside a box being typed in only closes that box; the next click adds another. Existing items can still be clicked while a tool is on.
- **Hand:** selects and moves items, and dragging the empty page scrolls it.
- **Selected item:** one resize handle at the bottom-right corner, with a larger hit area on touch, and buttons on the item: Size − +, in discrete steps, Width − + for spaced numbers (also a Width slider in the status row), and × delete. The Delete key also works.
- **Shortcuts:** must not fire while typing in a box. The global keydown handler in `main.ts` needs the same early return it already has for other open dialogs. Undo inside a text box stays native; outside one it's the app's undo, using `shortcutFor` so the Hebrew layout works.
- **Thumbnails and lightbox:** a read-only, scaled version of the item layer, so filled pages are visible in the grid.

### Zoom (`src/zoom.ts`, pure, unit-tested, plus editor wiring)
- 50–400% and fit-to-width, through buttons, Ctrl+wheel and pinch.
- Zoom keeps the point under the cursor or fingers in place.
- During a gesture, scale with CSS; re-render the page when it settles.
- Cap the canvas at about 16 megapixels (iOS's limit is near this). Above the cap, CSS scales the last render, so extreme zoom softens but can't run out of memory.
- On touch, one finger on an item moves it and one finger on the page pans.

### Signatures (`src/signaturePad.ts`)
- Draw with pointer events, or upload an image.
- **Natural variable-width ink, not a uniform line:**
  - **Width source, per stroke:** real `PointerEvent.pressure` when `pointerType` is `pen` and the values actually vary, since some devices report a constant. Otherwise derive it from speed: fast is thin, slow is thick, with tapered ends. A mouse reports a fixed 0.5, and fingers usually give no real pressure.
  - **Capture:** read all points with `getCoalescedEvents()`, and smooth both the path and the width.
  - **Rendering:** a filled variable-width outline. `perfect-freehand` is recommended (MIT, small; confirm its licence and bundle size when adding it). It runs locally, so the CSP and privacy rules don't change.
- **Drawn signatures are vector outlines:**
  - Crop to the ink, then keep the variable-width filled outline as SVG path data, simplified to limit its size. When saved, it goes in the encrypted vault.
  - Each stroke is its own path, in one solid colour, so overlaps don't leave holes from the fill rule.
  - On screen, show it with `Path2D` or inline SVG, whichever works under the CSP.
  - In the PDF, draw it with `pdf-lib`'s `drawSvgPath` as true vector content.
- **Raw stroke points are never persisted.** They stay in memory only while drawing, to build the outline and to undo the last stroke on the pad, and are discarded on confirm. A saved signature's look must not change after app updates, and timing and pressure data is sensitive with no later use. The accepted trade-off is that old signatures can't be re-tuned; the user just signs again.
- **Uploaded signatures stay PNG,** with no tracing. Offer a "remove white background" threshold.
- Works for the current session without saving anything. Saving is a separate, optional choice.

### Hosting: move to Cloudflare Pages
**Why:** browser storage is per origin, and `gilovi.github.io` is shared by all the user's GitHub Pages sites, so any of them could read or use a stored signature. A `pdf-remix.pages.dev` project is its own origin.

**Do this before any passkey is created,** because passkeys are permanently tied to the domain. Moving to a custom domain later would orphan them.

- Connect the repo in the Cloudflare dashboard, with build `npm run build` and output `dist`. The user does this step.
- Add `public/_headers` to send the CSP as a real header too, with `frame-ancestors 'none'` (which the meta tag can't express). Extend `src/build.test.ts` to cover it.
- Keep the check job in `deploy.yml`, and remove its Pages deploy.
- Replace the GitHub Pages site with a static redirect page, so no copy of the app with vault code remains on the shared origin.
- Update `README.md` and `CLAUDE.md`, which both name GitHub Pages.

### Vault (`src/vault.ts`, unit-tested; `src/vaultStore.ts`, IndexedDB)
Envelope encryption with WebCrypto only:

- A random 256-bit data key encrypts the list of saved signatures with AES-GCM and a fresh IV on every write.
- The data key is stored only in wrapped form, once per unlock method:

```ts
type Wrap =
  | { kind: 'passphrase'; salt: Uint8Array; iterations: number; iv: Uint8Array; wrapped: Uint8Array }
  | { kind: 'passkey'; credentialId: Uint8Array; prfSalt: Uint8Array; label: string; iv: Uint8Array; wrapped: Uint8Array };
```

- **Passphrase (required when creating a vault):** at least 10 characters; PBKDF2-SHA-256 with 600,000 iterations and a random salt; iteration count stored so it can be raised later.
- **Passkeys (optional, any number):** PRF output goes through HKDF-SHA-256 to a wrapping key. Windows Hello and Google Password Manager can both be registered at once, and each is its own wrap.
- **Recovery:** none. A forgotten passphrase with no working passkey means deleting the vault and signing again.
- **Session:** the data key stays in memory only, until Lock or page close. Decrypted signatures are never written anywhere.
- **Controls:** delete one signature, remove a passkey, and delete the vault. The passphrase can't be removed, so it always remains as a way in.
- Call `navigator.storage.persist()` so the browser is less likely to evict the vault.

**What this defends against:** other sites, other origins, and someone copying the browser profile.

**What it doesn't defend against:** malicious code running on this origin while the vault is unlocked, malicious browser extensions, or a compromised device. The CSP and the small dependency list reduce the first risk but don't remove it.

### Passkeys (`src/passkey.ts`)
A thin WebAuthn wrapper. Parsing and error classification are pure and tested with recorded responses.

1. **Register:** `credentials.create` with `extensions: { prf: {} }`, `residentKey: 'required'` and `userVerification: 'required'`, under the app's own domain as `rpId`.
2. **Check:** if `prf.enabled` isn't true, don't store anything, and explain how to fix it (see below).
3. **Derive:** `credentials.get` with that credential and `prf.eval.first` set to a random stored salt. PRF results can't be relied on from `create`, so always do this second step. It may mean a second prompt.
4. **Unlock:** offer each registered passkey by label. Any failure falls back to the passphrase.

#### Google Password Manager
**Reported support, which Phase 6 must confirm:**
- Android: PRF works with Google Password Manager passkeys in Chrome, Edge and Samsung Internet.
- Desktop Chrome: PRF works only when the passkey is actually saved to Google Password Manager. Chrome's local profile authenticator lacks it.

**A web page can't choose the passkey provider.** The browser's dialog decides, and the user picks. There's one generic "Add passkey" action with no provider-specific path, so Google Password Manager works whenever the browser offers it and it passes the PRF check. That means:
- When Chrome silently saves to the local profile, or an extension such as a third-party password manager intercepts the request, `prf.enabled` comes back false. Show specific advice: turn on "Offer to save passkeys", pause the extension, try again.
- Tell the user a rejected attempt may leave an unused passkey in their manager. Use `PublicKeyCredential.signalUnknownCredential` where it's available to clean up.
- Label each passkey from its AAGUID when recognised, and let the user rename it. Whether `attestation: 'none'` keeps the AAGUID is a spike question.
- Say clearly that the synced passkey doesn't bring the signatures along: a new device needs its own vault.

**Why the passphrase stays mandatory:** a WebAuthn Level 3 co-editor warns against PRF-derived data encryption, because deleting a passkey destroys access to the data. Passkeys are also easy to delete or lose in a provider. Passkeys here are only a convenience unlock over a passphrase wrap, which removes that failure mode. Support is also still uneven across providers.

## Phases
Each phase ends with typecheck, lint and tests green, and code phases are test-first.

1. **Export core:** add the dependencies, then `overlay.ts`, `coords.ts`, `textlayout.ts` and `buildPdf` drawing. Confirm the real Vite build bundles `fontkit` lazily under the CSP. Render multi-line and rotated output and check it by eye.
2. **Editor:** dialog, placing, dragging, resizing, deleting, undo, zoom and thumbnails for text, spaced numbers and X. Check in the running app, on touch emulation, and in light and dark mode. Open an export in Acrobat. Check how existing form fields survive.
3. **Signatures, session only:** draw with variable-width ink, upload, crop, place. Usable with no storage at all. Add the `vector` overlay kind. The width logic is unit-tested, but the feel can't be verified automatically: the user tries it by hand with mouse, finger and pen if available, and width settings will likely need tuning. Also check, since it's unverified, that `drawSvgPath` renders the outline accurately with rotation, scale and page coordinates (it uses its own y-down convention), and what it does to PDF size.
4. **Hosting move:** the user connects Cloudflare; then the headers, workflow, redirect and docs. Needs explicit go-ahead, because it changes the public URL.
5. **Vault with passphrase:** crypto, IndexedDB and management UI.
6. **Passkey spike, hand-run on the real domain** (`spike-page` skill; results saved across reloads). Each run records `prf.enabled`, whether `get` returned PRF bytes, whether two `get` calls give identical bytes, and the AAGUID:
   | Client | Provider |
   |---|---|
   | Chrome on Windows | Google Password Manager |
   | Chrome on Windows | Windows Hello |
   | Edge on Windows | Windows Hello |
   | Chrome on Android | Google Password Manager |
   | Chrome on Windows, phone via QR code | Google Password Manager on the phone |
   | Second device after sync | Google Password Manager: same PRF bytes as the first device? |
7. **Passkeys in the vault:** only for combinations that passed. Anything that failed gets a clear message, not a broken button. If Google Password Manager fails on desktop, it ships for Android only, or waits; the passphrase path is unaffected.

## Acceptance criteria
**Layout and export**
- All Appendix B strings produce the expected run order, with Hebrew runs kept in typed order and brackets mirrored.
- Text never throws, including niqqud; missing glyphs are flagged in the editor.
- An export with items keeps its page count and order, and an export without items never loads `fontkit`.
- Items appear in the right place for all four rotations and a non-zero crop box origin.
- The same source page placed twice can hold different items.

**Editing**
- Every item type can be moved, resized within its rules, and deleted by button and by key.
- Undo and redo restore each finished gesture. Deleting a page and undoing brings its items back.
- Delete and Ctrl+Z inside a text box edit the text and don't touch the document.
- Item geometry is identical before and after zooming.
- Zooming keeps the point under the cursor in place, and the canvas never exceeds the cap.

**Vault**
- Encrypted data never contains the plaintext signature; a wrong passphrase or wrong PRF bytes fail cleanly.
- Every wrap unlocks the same data; removing a passkey leaves the passphrase working.
- Each write uses a fresh IV.
- A passkey with `prf.enabled` false is never stored as a wrap.
- Passkey and passphrase cancellation or failure never lose data.

**Privacy**
- The built bundle references no external origin, and the production CSP is unchanged or stricter.
- The whole flow works with the network blocked once the app has loaded.

## Open items
- Confirm the `pdf-remix` project name is free on Cloudflare; the domain must be settled before Phase 6.
- Existing form fields and PDFs with digital signatures: `buildPdf` copies pages rather than the whole form, and a rebuild invalidates digital signatures. Check in Phase 2, then decide whether to warn on load.

## Sources for passkey support
Mostly community reports, which is why Phase 6 exists.
- [Corbado: passkeys and PRF](https://www.corbado.com/blog/passkeys-prf-webauthn)
- [Authenticator support table](https://mera.category.xyz/authenticator-support/) and [passkeys and PRF](https://mera.category.xyz/concepts/passkeys-and-prf/)
- [Warning against PRF-derived data encryption](https://lilting.ch/en/articles/passkeys-prf-extension-encryption-risk)
- [1Password community: non-compliant PRF response](https://www.1password.community/developers-69/browser-extension-webauthn-prf-extension-not-spec-compliant-24672)
- [WebKit bug 311099](https://bugs.webkit.org/show_bug.cgi?id=311099)

## Appendix A: the layout that passed the spike
Spike code, kept here because it lived in a temporary folder. Rewrite it test-first in TypeScript.

```js
const isHebrew = (c) => /[֐-׿יִ-ﭏ]/.test(c);
const isMark = (c) => /[֑-ׇֽֿׁׂׅׄ]/.test(c);

function layoutRuns(text, bidi, has) {
  const { levels } = bidi.getEmbeddingLevels(text); // auto base direction (first strong)
  const logical = [];
  let off = 0, prevFont = null;
  for (const c of [...text]) {
    const level = levels[off]; // levels are per UTF-16 unit
    off += c.length;
    let font;
    if (isHebrew(c)) font = 'he';
    else if (has.la(c)) font = has.he(c) && prevFont === 'he' ? 'he' : 'la';
    else font = has.he(c) ? 'he' : 'la';
    const last = logical[logical.length - 1];
    // A mark must stay in its base letter's run.
    if (last && last.level === level && (last.font === font || isMark(c))) last.text += c;
    else logical.push({ text: c, level, font });
    prevFont = font;
  }
  // UAX#9 L2: from the highest level down, reverse each contiguous sequence at or above it.
  const out = logical.slice();
  let max = 0, minOdd = Infinity;
  for (const r of out) { max = Math.max(max, r.level); if (r.level % 2) minOdd = Math.min(minOdd, r.level); }
  for (let lv = max; lv >= minOdd; lv--) {
    for (let i = 0; i < out.length; i++) {
      if (out[i].level < lv) continue;
      let j = i;
      while (j + 1 < out.length && out[j + 1].level >= lv) j++;
      const seg = out.slice(i, j + 1).reverse();
      out.splice(i, seg.length, ...seg);
      i = j;
    }
  }
  return out.map((r) => {
    let t = r.text;
    if (r.level % 2) {
      t = [...t].map((c) => bidi.getMirroredCharacter(c) ?? c).join('');
      // fontkit only reverses text it recognises as RTL script; do neutral-only runs ourselves.
      if (![...t].some(isHebrew)) t = [...t].reverse().join('');
    }
    return { text: t, font: r.font, level: r.level };
  });
}
```

Draw the runs left to right, advancing `x` by `font.widthOfTextAtSize(run.text, size)`. Embed both fonts with `{ subset: true }`.

## Appendix B: test strings
All of these passed in the spike:

```
שלום עולם
מנצפך ךםןףץ
Hello world
שלום Hello עולם
Hello שלום world
מספר 12345 בלבד
ת.ז. 123-456-789
תאריך: 12/03/2026
שם (פרטי) ומשפחה
סכום: ₪1,250.50
טלפון 050-1234567
שָׁלוֹם
Name (שם) here
האם זה נכון?!
שלום, Hello (world) 123.
בְּרֵאשִׁית and more
מייל: gil@example.com
הנחה של 15% בלבד
```
