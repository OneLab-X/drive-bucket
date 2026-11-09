import { XMLParser } from 'fast-xml-parser';
import type { Readable } from 'node:stream';
import { HttpError, xmlEscape } from '../http/s3-error.js';

export const S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === 'Object' || name === 'Part',
  processEntities: true,
});

export type XmlNode = string | number | boolean | Date | null | undefined | XmlNode[] | { [k: string]: XmlNode };

function render(name: string, value: XmlNode): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => render(name, v)).join('');
  if (value instanceof Date) return `<${name}>${value.toISOString()}</${name}>`;
  if (typeof value === 'object') {
    return `<${name}>${Object.entries(value).map(([k, v]) => render(k, v)).join('')}</${name}>`;
  }
  return `<${name}>${xmlEscape(String(value))}</${name}>`;
}

/** Build an S3 XML document: `xml('ListBucketResult', {...})`. */
export function xml(root: string, body: Record<string, XmlNode>): string {
  const inner = Object.entries(body).map(([k, v]) => render(k, v)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${S3_NS}">${inner}</${root}>`;
}

/** Read a small XML request body (DeleteObjects, CompleteMultipartUpload). */
export async function readXmlBody(stream: Readable, maxBytes = 2 * 1024 * 1024): Promise<Record<string, any>> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    const b = Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > maxBytes) throw new HttpError(400, 'MaxMessageLengthExceeded', 'Your request was too big.');
    parts.push(b);
  }
  const text = Buffer.concat(parts).toString('utf8');
  if (!text.trim()) throw new HttpError(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.');
  try {
    return parser.parse(text, true) as Record<string, any>;
  } catch {
    throw new HttpError(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.');
  }
}
