/**
 * Pure layout math shared by the UI and its tests: the rem scale for a viewport and the horizontal placement of
 * centred dialogs (trade, nomads) so they never cover the toast column at the top-left.
 */

/** Toast column (hud.css `.toasts`): left 1rem, width 38rem → right edge at 39rem. */
export const TOAST_COLUMN_RIGHT_REM = 39;

/** 1rem in px for a viewport: 10px at ~1280×720, up to 12.4px at 1440p+, never below 8.2px. */
export function uiRemPx(width: number, height: number): number {
  const w = width || 1280;
  const hgt = height || 720;
  const byHeight = 0.8 + 0.2 * (hgt / 720);
  const byWidth = w / 1340;
  const scale = Math.max(0.82, Math.min(1.24, byHeight, byWidth));
  return 10 * scale;
}

/**
 * Left edge and width (px) of a dialog of natural width `w` in a viewport `vw` wide: centred, but never left of the toast
 * column (`toastRight` px) plus a 1rem gap, and narrowed to fit when needed. When not even a 36rem dialog fits beside the
 * column (very narrow windows), it stays centred at full width.
 */
export function placeDialogX(vw: number, w: number, rem: number, toastRight = TOAST_COLUMN_RIGHT_REM * rem): { x: number; width: number } {
  let x = (vw - w) / 2;
  let width = w;
  const left = toastRight + rem;
  const avail = vw - left - rem;
  if (avail >= Math.min(w, 36 * rem)) {
    if (x < left) x = left;
    if (x + width > vw - rem) width = Math.floor(vw - rem - x);
  }
  return { x, width };
}
