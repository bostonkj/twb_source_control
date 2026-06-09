import fs from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import xpath from 'xpath';

export function readXml(filePath: string): Document {
  const xml = fs.readFileSync(filePath, 'utf8');
  const doc = new DOMParser({
    locator: {},
    errorHandler: {
      warning: () => {},
      error: (msg) => {
        throw new Error(`XML parse error: ${msg}`);
      },
      fatalError: (msg) => {
        throw new Error(`XML fatal parse error: ${msg}`);
      }
    }
  }).parseFromString(xml, 'application/xml');

  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    throw new Error(`XML parse error: ${parserError.textContent ?? 'unknown parser error'}`);
  }

  return doc;
}

export function writeXml(filePath: string, doc: Document): void {
  const xml = new XMLSerializer().serializeToString(doc);
  fs.writeFileSync(filePath, xml, 'utf8');
}

export function selectAll<T extends Node>(node: Node, expr: string): T[] {
  return xpath.select(expr, node) as T[];
}

export function selectOne<T extends Node>(node: Node, expr: string): T | null {
  return (xpath.select1(expr, node) as T | undefined) ?? null;
}

export function attr(node: Node | null, name: string): string {
  if (!node || node.nodeType !== 1) return '';
  return ((node as Element).getAttribute(name) ?? '').trim();
}

export function ensureElement(doc: Document, parent: Element, tagName: string): Element {
  const existing = Array.from(parent.childNodes).find(
    (child) => child.nodeType === 1 && (child as Element).tagName === tagName
  ) as Element | undefined;

  if (existing) return existing;
  const el = doc.createElement(tagName);
  parent.appendChild(el);
  return el;
}
