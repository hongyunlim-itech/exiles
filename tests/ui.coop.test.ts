import { describe, expect, it } from 'vitest';
import type { Command } from '../src/net/types';
import { pendingKeyFor, rejectionText } from '../src/ui/coop/describe';
import { idleLabel } from '../src/ui/coop/players';
import { PendingValues, pendingKey } from '../src/ui/pending';
import { placeDialogX, TOAST_COLUMN_RIGHT_REM, uiRemPx } from '../src/ui/scale';

describe('PendingValues (co-op optimistic UI values)', () => {
  it('shows the requested value until the game reports it', () => {
    let now = 0;
    const p = new PendingValues(() => now);
    expect(p.get('k', 2)).toBe(2); // nothing pending
    p.set('k', 3);
    expect(p.get('k', 2)).toBe(3);
    expect(p.isPending('k', 2)).toBe(true);
    now = 500;
    expect(p.get('k', 3)).toBe(3); // applied → entry dropped
    expect(p.size).toBe(0);
    expect(p.get('k', 2)).toBe(2);
  });

  it('expires when the host never applies it (e.g. rejected or dropped)', () => {
    let now = 0;
    const p = new PendingValues(() => now);
    p.set('paused', true, 1000);
    expect(p.get('paused', false)).toBe(true);
    now = 1001;
    expect(p.get('paused', false)).toBe(false);
    expect(p.isPending('paused', false)).toBe(false);
  });

  it('delete and clear drop entries', () => {
    const p = new PendingValues(() => 0);
    p.set('a', 1);
    p.set('b', 'x');
    p.delete('a');
    expect(p.get('a', 0)).toBe(0);
    expect(p.get('b', 'y')).toBe('x');
    p.clear();
    expect(p.get('b', 'y')).toBe('y');
  });
});

describe('co-op command descriptions', () => {
  it('describes rejected commands with the host reason', () => {
    const place: Command = { op: 'place', type: 'woodenHouse', x: 1, z: 2, rot: 0 };
    expect(rejectionText(place, 'Blocked by a building')).toMatch(/^Couldn't build the .+: blocked by a building$/);
    expect(rejectionText({ op: 'trade', give: {}, take: [] }, '')).toBe('The merchant refused the trade.');
    expect(rejectionText({ op: 'speed', speed: 5 }, 'Only the host')).toBe("Couldn't change the game speed: only the host");
  });

  it('maps commands to the pending keys the UI set', () => {
    expect(pendingKeyFor({ op: 'workers', id: 7, n: 2 })).toBe(pendingKey.workers(7));
    expect(pendingKeyFor({ op: 'builders', n: 3 })).toBe(pendingKey.builders());
    expect(pendingKeyFor({ op: 'pause', id: 4, paused: true })).toBe(pendingKey.paused(4));
    expect(pendingKeyFor({ op: 'crop', id: 4, choice: 'wheat' })).toBe(pendingKey.crop(4));
    expect(pendingKeyFor({ op: 'requestMerchant', kind: null })).toBe(pendingKey.merchant());
    expect(pendingKeyFor({ op: 'demolish', id: 4 })).toBeNull();
  });

  it('formats idle times', () => {
    expect(idleLabel(45_000)).toBe('idle 45s');
    expect(idleLabel(5 * 60_000)).toBe('idle 5 min');
  });
});

describe('dialog placement vs the toast column', () => {
  const RESOLUTIONS: [number, number][] = [
    [1280, 720], [1280, 800], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1680, 1050], [1920, 1080],
    [1920, 1200], [2048, 1152], [2560, 1080], [2560, 1440],
  ];
  // trade (92rem) and nomads (40rem) dialogs
  for (const [vw, vh] of RESOLUTIONS) {
    it(`never overlaps the toasts at ${vw}x${vh}`, () => {
      const rem = uiRemPx(vw, vh);
      const toastRight = TOAST_COLUMN_RIGHT_REM * rem;
      for (const widthRem of [92, 40]) {
        const { x, width } = placeDialogX(vw, widthRem * rem, rem);
        expect(x).toBeGreaterThanOrEqual(toastRight);
        expect(x + width).toBeLessThanOrEqual(vw);
        // no meaningful squeeze inside the supported range
        expect(width).toBeGreaterThanOrEqual(widthRem * rem - 2);
      }
    });
  }

  it('stays centred when there is room', () => {
    const rem = uiRemPx(2560, 1440);
    const w = 40 * rem;
    const { x } = placeDialogX(2560, w, rem);
    expect(x).toBeCloseTo((2560 - w) / 2);
  });
});
