/**
 * Detect a file type from its first bytes. Uploaded Content-Type is client-controlled; when we
 * can recognize the bytes we trust them instead, so an HTML file can't be stored as image/png.
 */
export function sniff(head: Uint8Array): string | undefined {
  const b = head;
  const at = (i: number, ...bytes: number[]) => bytes.every((v, j) => b[i + j] === v);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand)) return 'video/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
  }
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (ascii(0, 'ID3') || at(0, 0xff, 0xfb)) return 'audio/mpeg';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
  const text = new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 64)).trimStart().toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<script')) return 'text/html';
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  return undefined;
}

export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
};

/** `image/*` style wildcard matching. */
export function typeAllowed(type: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((a) => a === type || (a.endsWith('/*') && type.startsWith(a.slice(0, -1))));
}
