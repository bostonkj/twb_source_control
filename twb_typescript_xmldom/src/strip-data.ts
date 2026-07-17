import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXml, selectAll, writeXml } from './xml.js';

// Removes each node in a list from its parent and returns the removal count.
function removeNodes(nodes: Node[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
      count += 1;
    }
  }
  return count;
}

// Redacts sensitive connection attributes while leaving the workbook structure intact.
function sanitizeConnections(doc: Document): number {
  let updates = 0;
  for (const conn of selectAll<Element>(doc, '//connection')) {
    for (const attrName of ['server', 'port', 'dbname', 'username', 'odbc-connect-string-extras', 'service']) {
      if (conn.hasAttribute(attrName)) {
        conn.setAttribute(attrName, 'REDACTED');
        updates += 1;
      }
    }
    for (const attrName of ['authentication', 'class', 'schema']) {
      if (conn.hasAttribute(attrName) && conn.getAttribute(attrName)?.includes('oauth')) {
        conn.setAttribute(attrName, 'REDACTED');
        updates += 1;
      }
    }
  }
  return updates;
}

export function stripAndSanitize(doc: Document): any {

  const removed = {
    repositoryLocation: removeNodes(selectAll<Node>(doc, '//repository-location')),
    metadataRecords: removeNodes(selectAll<Node>(doc, '//metadata-records')),
    semanticValues: removeNodes(selectAll<Node>(doc, '//semantic-values')),
    extracts: removeNodes(selectAll<Node>(doc, '//extract')),
    relationMetadata: removeNodes(selectAll<Node>(doc, '//relation/metadata-records')),
    connectionCustomizations: removeNodes(selectAll<Node>(doc, '//connection-customization')),
  };
  const sanitizedConnections = sanitizeConnections(doc);
  return sanitizedConnections;
}

function main(): void {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node strip-data.js <workbook.twb> [output.twb]');
    process.exit(1);
  }

  const resolvedOutput =
    outputPath ??
    path.join(path.dirname(inputPath), `${path.basename(inputPath, '.twb')}_stripped.twb`);

  const doc = readXml(inputPath);
  const sanitizedConnections = stripAndSanitize(doc);
  writeXml(resolvedOutput, doc);
  console.log(`Sanitized ${sanitizedConnections} connection attribute(s)`);
  console.log(`Stripped workbook written to ${resolvedOutput}`);
}

// Run main() only when executed directly (not when imported by server.ts).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}