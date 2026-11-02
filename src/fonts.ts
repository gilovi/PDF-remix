import fontkit from '@pdf-lib/fontkit';
import hebrewUrl from '@fontsource/heebo/files/heebo-hebrew-400-normal.woff?url';
import latinUrl from '@fontsource/heebo/files/heebo-latin-400-normal.woff?url';
import type { FontFiles } from './pdfOverlays';

const bytesOf = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The fonts for this document couldn’t be loaded.');
  return new Uint8Array(await response.arrayBuffer());
};

/** fontkit is large, so this whole module loads only when an output contains text. */
export async function loadFonts(): Promise<FontFiles> {
  const [hebrew, latin] = await Promise.all([bytesOf(hebrewUrl), bytesOf(latinUrl)]);
  return { fontkit, hebrew, latin };
}
