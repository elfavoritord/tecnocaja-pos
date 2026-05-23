'use strict';

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const INVALID_XML_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripInvalidXmlChars(value) {
  return String(value ?? '').replace(INVALID_XML_RE, '');
}

function sanitizeXmlText(value) {
  return escapeXml(stripInvalidXmlChars(value));
}

function parseXml(xml) {
  return new DOMParser().parseFromString(String(xml || ''), 'application/xml');
}

function serializeXml(document) {
  return new XMLSerializer().serializeToString(document);
}

function isSignatureElement(node) {
  return node?.nodeType === 1
    && String(node.localName || node.nodeName || '').toLowerCase() === 'signature'
    && (!node.namespaceURI || node.namespaceURI === 'http://www.w3.org/2000/09/xmldsig#');
}

function isNamespaceAttribute(attribute) {
  const name = String(attribute?.nodeName || '');
  return name === 'xmlns' || name.startsWith('xmlns:');
}

function namespaceSortKey(attribute) {
  const name = String(attribute?.nodeName || '');
  return name === 'xmlns' ? '' : name.slice('xmlns:'.length);
}

function compareCanonicalAttributes(a, b) {
  const aNs = isNamespaceAttribute(a);
  const bNs = isNamespaceAttribute(b);
  if (aNs !== bNs) return aNs ? -1 : 1;
  const aKey = aNs ? namespaceSortKey(a) : String(a.nodeName || '');
  const bKey = bNs ? namespaceSortKey(b) : String(b.nodeName || '');
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function escapeCanonicalText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

function escapeCanonicalAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

function canonicalizeNode(node, options = {}) {
  if (!node) return '';
  switch (node.nodeType) {
    case 9:
      return canonicalizeNode(node.documentElement, options);
    case 1: {
      if (options.excludeSignature && isSignatureElement(node)) return '';
      const attributes = [];
      for (let index = 0; index < node.attributes.length; index += 1) {
        attributes.push(node.attributes.item(index));
      }
      attributes.sort(compareCanonicalAttributes);
      let xml = `<${node.nodeName}`;
      for (const attribute of attributes) {
        xml += ` ${attribute.nodeName}="${escapeCanonicalAttr(attribute.nodeValue)}"`;
      }
      xml += '>';
      for (let child = node.firstChild; child; child = child.nextSibling) {
        xml += canonicalizeNode(child, options);
      }
      xml += `</${node.nodeName}>`;
      return xml;
    }
    case 3:
    case 4:
      return escapeCanonicalText(node.data);
    case 7:
      return node.data ? `<?${node.target} ${node.data}?>` : `<?${node.target}?>`;
    default:
      return '';
  }
}

function firstElementByTagName(document, tagName) {
  const nodes = document.getElementsByTagName(tagName);
  return nodes?.[0] || null;
}

module.exports = {
  canonicalizeNode,
  escapeXml,
  firstElementByTagName,
  parseXml,
  sanitizeXmlText,
  serializeXml,
  stripInvalidXmlChars,
};
