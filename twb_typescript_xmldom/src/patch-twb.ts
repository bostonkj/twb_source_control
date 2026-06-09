import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ensureElement, readXml, selectAll, selectOne, writeXml } from './xml.js';
import { type WorkbookName, detectWorkbook } from './extract-config.js';

// ─── Config type ──────────────────────────────────────────────────────────────

type ColorPalette = { name: string; type: string; colors: string[] };

type Config = {
  workbook?: WorkbookName;
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
  calculated_fields?: Record<string, string>;
  color_palettes?: ColorPalette[];
};

// ─── Config loader ────────────────────────────────────────────────────────────

function loadConfig(filePath: string): Config {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    return yaml.load(raw) as Config;
  }
  return JSON.parse(raw) as Config;
}

// ─── Shared utilities ─────────────────────────────────────────────────────────

// Escapes a string so it can be safely injected into an XPath expression.
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

// ─── Shared patch operations ──────────────────────────────────────────────────

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

function buildCaseFormula(parameterName: string, mapping: Record<string, string>): string {
  const parts = [`CASE [Parameters].[${parameterName}]`];
  for (const [label, expr] of Object.entries(mapping)) {
    parts.push(`WHEN "${label}" THEN ${expr}`);
  }
  parts.push('END');
  return parts.join(' ');
}

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

// Updates non-trivial calculated field formulas.
function updateCalculatedFields(doc: Document, config: Config): void {
  for (const [fieldName, formula] of Object.entries(config.calculated_fields ?? {})) {
    const lit = xpathLiteral(fieldName);
    const column = selectOne<Element>(
      doc,
      `//column[@caption=${lit} or @name=concat('[', ${lit}, ']')]`
    );
    if (!column) continue;
    const calc = ensureElement(doc, column, 'calculation');
    calc.setAttribute('formula', formula);
  }
}

// Replaces color palette hex values in the workbook preferences block.
// Only updates palettes that already exist in the template; does not create new ones.
function updateColorPalettes(doc: Document, config: Config): void {
  for (const palette of config.color_palettes ?? []) {
    const lit = xpathLiteral(palette.name);
    const paletteEl = selectOne<Element>(
      doc,
      `//preferences/color-palette[@name=${lit}]`
    );
    if (!paletteEl) continue;

    // Replace all <color> children
    const existingColors = selectAll<Element>(paletteEl, './color');
    for (const c of existingColors) {
      paletteEl.removeChild(c);
    }
    for (const hex of palette.colors) {
      const colorEl = doc.createElement('color');
      colorEl.textContent = hex;
      paletteEl.appendChild(colorEl);
    }
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateConfig(config: Config): void {
  for (const [name, param] of Object.entries(config.parameters ?? {})) {
    if (
      param.default_value &&
      param.allowed_values?.length &&
      !param.allowed_values.includes(param.default_value)
    ) {
      throw new Error(
        `Default value "${param.default_value}" is not in allowed_values for parameter "${name}"`
      );
    }
  }
}

// ─── Workbook-specific patch dispatchers ─────────────────────────────────────

// Applies the full patch suite for all workbooks. Each workbook type shares
// the same operations; add workbook-specific overrides inside these functions
// if divergence is needed in future.

function patchDailyDiagnostics(doc: Document, config: Config): void {
  updateDatasourcePaths(doc, config);
  updateRenamedFields(doc, config);
  updateParameters(doc, config);
  updateParameterCalcs(doc, config);
  updateCalculatedFields(doc, config);
  updateColorPalettes(doc, config);
}

function patchExecutiveSummary(doc: Document, config: Config): void {
  updateDatasourcePaths(doc, config);
  updateRenamedFields(doc, config);
  updateParameters(doc, config);
  updateParameterCalcs(doc, config);
  updateCalculatedFields(doc, config);
  updateColorPalettes(doc, config);
}

function patchWeeklyCrossChannel(doc: Document, config: Config): void {
  updateDatasourcePaths(doc, config);
  updateRenamedFields(doc, config);
  updateParameters(doc, config);
  updateParameterCalcs(doc, config);
  updateCalculatedFields(doc, config);
  updateColorPalettes(doc, config);
}

// ─── Router ───────────────────────────────────────────────────────────────────

function applyPatch(doc: Document, config: Config): WorkbookName {
  // Prefer the workbook declared in the config, but fall back to detecting
  // it from the template's sheet names so configs without the field still work.
  const workbook: WorkbookName = config.workbook ?? detectWorkbook(doc);

  switch (workbook) {
    case 'daily_diagnostics':
      patchDailyDiagnostics(doc, config);
      break;
    case 'executive_summary':
      patchExecutiveSummary(doc, config);
      break;
    case 'weekly_cross_channel':
      patchWeeklyCrossChannel(doc, config);
      break;
    default:
      throw new Error(`Unknown workbook type: "${workbook}"`);
  }

  return workbook;
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

export function patchWorkbook(doc: Document, config: Config): any {
  validateConfig(config);
  const workbook = applyPatch(doc, config);
  return workbook;
}

function main(): void {

}
