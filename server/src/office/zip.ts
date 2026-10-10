/**
 * Read entries from ZIP-based documents (docx, pptx, xlsx, odt) in-process with
 * JSZip — no `unzip` binary, so it works the same on Linux, macOS and Windows.
 */
import fs from 'node:fs';
import JSZip from 'jszip';

/** Text of every entry whose name matches, in natural order (slide2 before slide10). */
export async function zipTexts(abs: string, match: RegExp): Promise<{ name: string; text: string }[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(abs));
  const names = Object.keys(zip.files).filter((n) => match.test(n) && !zip.files[n].dir)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return Promise.all(names.map(async (name) => ({ name, text: await zip.files[name].async('string') })));
}
