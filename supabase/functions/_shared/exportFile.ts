// The files a writer downloads: an export's MP4 and its MP3.
//
// A download link has to make the browser SAVE the file. Left alone, a browser
// plays an MP4 or MP3 it is sent to, in a tab — and the address it plays from
// is a signed one that stops working when its time is up. (Nov 2026: a writer
// opened the emailed link to a 3 h 35 min video; it began playing in the
// browser from an address good for ten minutes.) So every address handed out
// for an export carries a file name, which makes storage answer "this is a
// file to save", and lasts long enough for a large file on a slow line, a
// pause and a resume.

/** How long a download address works for. The emailed link itself never expires: it makes a new address per click. */
export const DOWNLOAD_LINK_SECONDS = 24 * 60 * 60;

/**
 * The name the file is saved under: the script's title, tidied. Only letters,
 * digits and hyphens — it travels in a URL, and has to be a legal file name on
 * every system.
 */
export function exportFileName(title: unknown, ext: "mp4" | "mp3"): string {
  const base = (typeof title === "string" ? title : "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80)
    .replace(/-+$/, "");
  return `${base || "table-read"}.${ext}`;
}

/** mp3 or mp4, by the stored file's own ending. */
export function exportKind(path: string): "mp4" | "mp3" {
  return /\.mp3$/i.test(path) ? "mp3" : "mp4";
}

/** The MP3 that is stored beside a video export (same name, different ending). */
export function mp3Beside(videoPath: string): string | null {
  return /\.mp4$/i.test(videoPath) ? videoPath.replace(/\.mp4$/i, ".mp3") : null;
}
