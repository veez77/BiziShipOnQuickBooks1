import { describe, expect, it } from 'vitest';
import {
  NoteTooLongError,
  hasLinkLine,
  linkLine,
  linkUrl,
  removeLinkLines,
  upsertLinkLine,
} from '../src/providers/quickbooks/link.js';

const BASE = 'https://app.biziship.ai';
const A = '8c1f0a52-3d5e-4a57-9a53-2b1a7a3c0001';
const B = '8c1f0a52-3d5e-4a57-9a53-2b1a7a3c0002';

describe('QuickBooks shipment link memo lines', () => {
  it('builds the deep link from the shipment UUID only', () => {
    expect(linkUrl(BASE + '/', A)).toBe(`https://app.biziship.ai/shipments/${A}`);
    expect(linkLine(BASE, A)).toBe(`BiziShip shipment: https://app.biziship.ai/shipments/${A}`);
  });

  it('writes into an empty memo', () => {
    expect(upsertLinkLine(undefined, linkLine(BASE, A))).toBe(linkLine(BASE, A));
    expect(upsertLinkLine('   ', linkLine(BASE, A))).toBe(linkLine(BASE, A));
  });

  it('preserves existing text and appends on a new line', () => {
    const out = upsertLinkLine('Customer called about delivery\n', linkLine(BASE, A));
    expect(out).toBe(`Customer called about delivery\n${linkLine(BASE, A)}`);
  });

  it('is idempotent: re-running never duplicates the line', () => {
    const once = upsertLinkLine('note', linkLine(BASE, A));
    expect(upsertLinkLine(once, linkLine(BASE, A))).toBe(once);
  });

  it('adds one line per shipment', () => {
    const two = upsertLinkLine(upsertLinkLine('note', linkLine(BASE, A)), linkLine(BASE, B));
    expect(two.split('\n')).toEqual(['note', linkLine(BASE, A), linkLine(BASE, B)]);
  });

  it('refuses to exceed the QuickBooks memo limit instead of truncating', () => {
    expect(() => upsertLinkLine('x'.repeat(3990), linkLine(BASE, A))).toThrow(NoteTooLongError);
  });

  it('removes only BiziShip lines (cleanup)', () => {
    const note = `keep me\n${linkLine(BASE, A)}\nand me\n${linkLine(BASE, B)}`;
    expect(removeLinkLines(note)).toBe('keep me\nand me');
    expect(hasLinkLine(note)).toBe(true);
    expect(hasLinkLine(removeLinkLines(note))).toBe(false);
  });
});
