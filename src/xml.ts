import { DOMParser, XMLSerializer, onWarningStopParsing } from '@xmldom/xmldom';
import type { Document, Element, Node } from '@xmldom/xmldom';
import { CliError, NS, isPodcast, xmlChars } from './core.ts';

export type { Document, Element, Node };
export function parseXml(xml: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new CliError('XML_DTD', 'DTD и объявления сущностей не поддерживаются.', 1);
  if (!xmlChars(xml)) throw new CliError('XML_CHAR', 'Недопустимый символ XML.', 1);
  try {
    const doc = new DOMParser({ onError: onWarningStopParsing }).parseFromString(xml, 'application/xml');
    const stack: [Node, number][] = [[doc, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop()!;
      if (depth > 64) throw new Error('Глубина XML больше 64.');
      // xmldom may decode forbidden numeric references without reporting a parse error.
      if (node.nodeValue !== null && !xmlChars(node.nodeValue)) throw new Error('Недопустимая числовая ссылка на символ XML.');
      if (node.nodeType === 1 && Array.from((node as Element).attributes).some(attr => !xmlChars(attr.value))) throw new Error('Недопустимый символ в атрибуте XML.');
      for (let child = node.firstChild; child; child = child.nextSibling) stack.push([child, depth + 1]);
    }
    return doc;
  } catch (e) { throw new CliError('XML_PARSE', `Некорректный XML: ${e instanceof Error ? e.message : String(e)}`, 1); }
}
export function children(node: Node): Element[] {
  return Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1);
}
export function select(node: Node, name: string, ns = ''): Element[] {
  return children(node).filter(el => el.localName === name && (ns === NS.podcast ? isPodcast(el.namespaceURI) : (el.namespaceURI ?? '') === ns));
}
export const textOf = (node: Node, name: string, ns = ''): string => select(node, name, ns)[0]?.textContent?.trim() ?? '';
export function channelOf(doc: Document): Element {
  const root = doc.documentElement;
  if (!root || root.tagName !== 'rss' || root.namespaceURI || root.getAttribute('version') !== '2.0' || select(root, 'channel').length !== 1) {
    throw new CliError('RSS_ROOT', 'Ожидается RSS 2.0 с одним элементом channel без namespace.', 1);
  }
  return select(root, 'channel')[0]!;
}
export function append(parent: Element, name: string, text?: string, attrs: Record<string, string> = {}): Element {
  const doc = parent.ownerDocument!;
  const [prefix, local] = name.includes(':') ? name.split(':') : ['', name];
  const ns = prefix && prefix !== 'rss' ? NS[prefix as keyof typeof NS] : '';
  if (prefix && prefix !== 'rss' && !ns) throw new CliError('XML_NAMESPACE', `Неизвестный namespace: ${prefix}`);
  const el = doc.createElementNS(ns || null, prefix === 'rss' ? local! : name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.appendChild(doc.createTextNode(text));
  parent.appendChild(el);
  return el;
}
export const serialize = (doc: Document): string => new XMLSerializer().serializeToString(doc).replace(/\s*$/, '') + '\n';
