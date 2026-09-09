// FR-2.11: emoji grid from the server (it never encodes the answer) plus the link.

export const GAME_URL = "https://lisecki.dev/mondo/";

export function shareText(grid) {
  return `${grid}\n${GAME_URL}`;
}

/** Copies, or hands off to the OS share sheet on phones. Resolves to "copied" | "shared" | "failed". */
export async function share(grid) {
  const text = shareText(grid);
  if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ text }); return "shared"; } catch { /* cancelled; fall through to copy */ }
  }
  try { await navigator.clipboard.writeText(text); return "copied"; } catch { return "failed"; }
}
