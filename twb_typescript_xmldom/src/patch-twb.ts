import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ensureElement, readXml, selectAll, selectOne, writeXml } from './xml.js';

type Config = {
  datasources?: Array<{
    name_in_workbook: string;
    project_path?: string;
  }>;
  renamed_fields?: Record<string, string>;
  parameters?: Record<string, {
    allowed_values?: string[];
    default_value?: string;
  }>;
  parameter_calcs?: Record<string, Record<string, string>>;
};

// Loads either a JSON or YAML config file from disk.
function loadConfig(filePath: string): Config {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    return yaml.load(raw) as Config;
  }
  return JSON.parse(raw) as Config;
}

// Escapes a string so it can be safely injected into an XPath literal.
function xpathLiteral(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;

  const parts = value.split('"').flatMap((part, index, arr) => {
    const out: string[] = [];
    if (part) out.push(`"${part}"`);
    if (index < arr.length - 1) out.push(`'"'`);
    return out;
  });

  return `concat(${parts.join(', ')})`;
}

// Updates repository-location path values for configured datasources.
function updateDatasourcePaths(doc: Document, config: Config): void {
  for (const ds of config.datasources ?? []) {
    const lit = xpathLiteral(ds.name_in_workbook);
    const nodes = selectAll<Element>(
      doc,
      `//datasource[@name=${lit} or @formatted-name=${lit}]//repository-location`
    );
    for (const node of nodes) {
      if (ds.project_path) node.setAttribute('path', ds.project_path);
    }
  }
}

// Rewrites simple renamed-field calculations so captions point at the configured source fields.
function updateRenamedFields(doc: Document, config: Config): void {
  for (const [friendlyName, targetField] of Object.entries(config.renamed_fields ?? {})) {
    const lit = xpathLiteral(friendlyName);
    const column = selectOne<Element>(
      doc,
      `//column[@caption=${lit} or @name=concat('[', ${lit}, ']')]`
    );
    if (!column) continue;
    const calc = ensureElement(doc, column, 'calculation');
    calc.setAttribute('formula', `[${targetField}]`);
    column.setAttribute('caption', friendlyName);
  }
}

// Replaces a parameter domain with a new ordered list of member values.
function replaceDomainValues(doc: Document, column: Element, values: string[]): void {
  const domain = selectOne<Element>(column, './/domain');
  if (!domain) return;
  while (domain.firstChild) domain.removeChild(domain.firstChild);
  for (const value of values) {
    const member = doc.createElement('member');
    member.setAttribute('value', value);
    member.setAttribute('alias', value);
    domain.appendChild(member);
  }
}

// Applies parameter member-list and default-value updates from config.
function updateParameters(doc: Document, config: Config): void {
  for (const [parameterName, param] of Object.entries(config.parameters ?? {})) {
    const lit = xpathLiteral(parameterName);
    const column = selectOne<Element>(
      doc,
      `//datasource[@name='Parameters']//column[@caption=${lit}]`
    );
    if (!column) continue;
    if (param.allowed_values?.length) replaceDomainValues(doc, column, param.allowed_values);
    if (param.default_value) column.setAttribute('value', param.default_value);
  }
}

// Builds a Tableau CASE formula from a label-to-expression mapping.
function buildCaseFormula(parameterName: string, mapping: Record<string, string>): string {
  const parts = [`CASE [Parameters].[${parameterName}]`];
  for (const [label, expr] of Object.entries(mapping)) {
    parts.push(`WHEN "${label}" THEN ${expr}`);
  }
  parts.push('END');
  return parts.join(' ');
}

// Rewrites parameter-driven calculated fields using config-provided CASE mappings.
function updateParameterCalcs(doc: Document, config: Config): void {
  for (const [calcName, mapping] of Object.entries(config.parameter_calcs ?? {})) {
    const lit = xpathLiteral(calcName);
    const column = selectOne<Element>(
      doc,
      `//column[@caption=${lit} or @name=concat('[', ${lit}, ']')]`
    );
    if (!column) continue;
    const calc = ensureElement(doc, column, 'calculation');
    calc.setAttribute('formula', buildCaseFormula(calcName, mapping));
  }
}

// Validates a few config invariants before the workbook is modified.
function validateConfig(config: Config): void {
  for (const [name, param] of Object.entries(config.parameters ?? {})) {
    if (param.default_value && param.allowed_values?.length && !param.allowed_values.includes(param.default_value)) {
      throw new Error(`Default value ${param.default_value} is not in allowed_values for ${name}`);
    }
  }
}

function main(): void {
  const [, , configPath, templatePath, outputPath] = process.argv;
  if (!configPath || !templatePath || !outputPath) {
    console.error('Usage: node dist/src/patch-twb.js <config.(json|yaml)> <template.twb> <output.twb>');
    process.exit(1);
  }

  const config = loadConfig(configPath);
  validateConfig(config);
  const doc = readXml(templatePath);

  updateDatasourcePaths(doc, config);
  updateRenamedFields(doc, config);
  updateParameters(doc, config);
  updateParameterCalcs(doc, config);

  writeXml(outputPath, doc);
  console.log(`Patched workbook written to ${path.resolve(outputPath)}`);
}

main();
