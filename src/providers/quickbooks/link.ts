/**
 * The only thing the Hub writes into a QuickBooks document: one line per BiziShip shipment, in the
 * document's internal memo. These helpers are pure so the rules (preserve existing text, never
 * duplicate, one line per shipment) are unit-tested without touching QuickBooks.
 */

export const LINK_LABEL = 'BiziShip shipment: ';

/** QuickBooks limits: PrivateNote 4000 characters, CustomerMemo 1000. */
export const PRIVATE_NOTE_MAX = 4000;

export class NoteTooLongError extends Error {
  constructor(readonly max: number) {
    super(`The memo would exceed ${max} characters`);
    this.name = 'NoteTooLongError';
  }
}

export function linkUrl(appBaseUrl: string, shipmentId: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/shipments/${encodeURIComponent(shipmentId)}`;
}

export function linkLine(appBaseUrl: string, shipmentId: string): string {
  return `${LINK_LABEL}${linkUrl(appBaseUrl, shipmentId)}`;
}

const isLinkLine = (line: string) => line.trimStart().startsWith(LINK_LABEL);

/** Adds the line unless that exact line is already present. Existing text is preserved. */
export function upsertLinkLine(note: string | undefined, line: string, max = PRIVATE_NOTE_MAX): string {
  const current = note ?? '';
  const lines = current.split(/\r?\n/);
  if (lines.some((l) => l.trim() === line)) return current;
  const next = current.trim() === '' ? line : `${current.replace(/\s+$/, '')}\n${line}`;
  if (next.length > max) throw new NoteTooLongError(max);
  return next;
}

/** Removes every BiziShip link line (used by the sandbox cleanup), keeping all other text. */
export function removeLinkLines(note: string | undefined): string {
  return (note ?? '')
    .split(/\r?\n/)
    .filter((l) => !isLinkLine(l))
    .join('\n')
    .replace(/\s+$/, '');
}

export function hasLinkLine(note: string | undefined): boolean {
  return (note ?? '').split(/\r?\n/).some(isLinkLine);
}
