import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { attr, ensureElement, readXml, selectAll, selectOne, writeXml } from './xml.js';
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

// ─── Passthrough alias resolution ─────────────────────────────────────────────

/**
 * Some fields are pure passthrough wrappers of another field — e.g. a
 * "Filter 1" quick-filter field whose entire formula is just
 * `[Calculation_598415825521487872]` (itself a renamed dimension). Formulas
 * elsewhere in the workbook (like the "Select Dimension" parameter dispatch)
 * sometimes reference the raw wrapped field directly instead of going
 * through the friendlier wrapper, which is what actually gets used in
 * user-facing filters. Preferring the wrapper avoids two different fields
 * silently representing "the same" dimension in different places.
 *
 * Builds a map from a raw field's internal name to the name of a column
 * that passes through to it (formula === "[rawName]"). When more than one
 * such wrapper exists, prefers one defined in a datasource that isn't a
 * "(copy)" duplicate, since those tend to be the ones worksheets actually
 * use — falls back to the first one found otherwise.
 *
 * Only considers wrapping an opaque, auto-generated "Calculation_XXXXX" name
 * — never an already-readable field like "Spend" or "Impressions". Almost
 * every plain metric field has its own "Platform - Spend"-style renamed_fields
 * wrapper (that's the whole point of renamed_fields), and those wrappers are
 * simple passthroughs too. Without this restriction, every clean field
 * reference in every KPI formula got silently rerouted through its renamed
 * wrapper's internal id — e.g. "Primary KPI Contribution"'s "[Spend]" turning
 * into "[Calculation_0157526077595648]" (the id behind "Platform - Spend").
 * That's not what "avoid the raw calculation" was about — it was specifically
 * about cryptic ids like Custom Dim 1/2/3 that have no readable name at all.
 */
function buildPassthroughAliasMap(doc: Document): Map<string, string> {
  const candidatesByRawName = new Map<string, Array<{ name: string; isCopy: boolean }>>();

  for (const col of selectAll<Element>(doc, '//column[calculation]')) {
    const calc = selectOne<Element>(col, './calculation');
    const formula = attr(calc, 'formula');
    const match = formula.match(/^\[([^\]]+)\]$/);
    if (!match) continue;

    const rawName = match[1];
    if (!/^Calculation_\d+$/.test(rawName)) continue;

    const ownName = attr(col, 'name').replace(/^\[|\]$/g, '');
    if (!ownName || ownName === rawName) continue;

    let ds: Node | null = col;
    while (ds && (ds as Element).nodeName !== 'datasource') ds = ds.parentNode;
    const dsName = ds ? attr(ds as Element, 'name') : '';

    const list = candidatesByRawName.get(rawName) ?? [];
    list.push({ name: ownName, isCopy: /\(copy\)/.test(dsName) });
    candidatesByRawName.set(rawName, list);
  }

  const aliasMap = new Map<string, string>();
  for (const [rawName, candidates] of candidatesByRawName) {
    const preferred = candidates.find((c) => !c.isCopy) ?? candidates[0];
    aliasMap.set(rawName, preferred.name);
  }
  return aliasMap;
}

// Rewrites any [FieldName] reference in a formula to its passthrough alias,
// if one exists. Leaves everything else untouched.
function applyAliasSubstitution(formula: string, aliasMap: Map<string, string>): string {
  return formula.replace(/\[([^\]]+)\]/g, (whole, ref: string) => {
    const alias = aliasMap.get(ref);
    return alias ? `[${alias}]` : whole;
  });
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
  for (const [targetField, friendlyName] of Object.entries(config.renamed_fields ?? {})) {
    // Match on the underlying calculation formula (a stable identifier that
    // exists in the blank template) rather than on the desired friendly name
    // (which doesn't exist yet — that was the bug: this used to search for a
    // column already captioned/named as the NEW display name, so it never
    // found anything and silently no-opped).
    const formulaLit = xpathLiteral(`[${targetField}]`);
    const columns = selectAll<Element>(
      doc,
      `//column[calculation[@formula=${formulaLit}]]`
    );
    // A field can be duplicated across more than one datasource (e.g. a
    // "(copy)" datasource) and cached again per-worksheet under
    // datasource-dependencies. Update every instance, not just the first,
    // so the rename shows up no matter which copy a worksheet reads from.
    for (const column of columns) {
      const calc = ensureElement(doc, column, 'calculation');
      calc.setAttribute('class', 'tableau');
      calc.setAttribute('formula', `[${targetField}]`);
      column.setAttribute('caption', friendlyName);
    }
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

// dispatchExpr is the full "[Parameters].[X]" expression this CASE switches
// on — NOT necessarily derived from the calc's own name (see the caller).
function buildCaseFormula(dispatchExpr: string, mapping: Record<string, string>): string {
  const parts = [`CASE ${dispatchExpr}`];
  for (const [label, expr] of Object.entries(mapping)) {
    parts.push(`WHEN "${label}" THEN ${expr}`);
  }
  parts.push('END');
  return parts.join(' ');
}

// Extracts the "[Parameters].[X]" a column's existing CASE formula dispatches
// on, if it has one.
function extractDispatchExpr(formula: string): string | null {
  return formula.match(/^CASE\s+(\[Parameters\]\.\[[^\]]+\])/)?.[1] ?? null;
}

function updateParameterCalcs(doc: Document, config: Config): void {
  const aliasMap = buildPassthroughAliasMap(doc);
  for (const [calcName, mapping] of Object.entries(config.parameter_calcs ?? {})) {
    const lit = xpathLiteral(calcName);
    // Calculated fields can appear more than once: once in the "live"
    // datasource (or a duplicated "(copy)" datasource) and again cached
    // per-worksheet under datasource-dependencies. selectOne only patched
    // the first hit, leaving other copies stale — update every match.
    const columns = selectAll<Element>(
      doc,
      `//column[@caption=${lit} or @name=concat('[', ${lit}, ']')]`
    );
    if (!columns.length) continue;

    // Prefer each option's passthrough alias (e.g. a "Filter 1" field) over
    // a raw calculation reference, wherever one exists.
    const resolvedMapping: Record<string, string> = {};
    for (const [label, expr] of Object.entries(mapping)) {
      resolvedMapping[label] = applyAliasSubstitution(expr, aliasMap);
    }

    for (const column of columns) {
      // Some columns captioned/named the same as a parameter_calcs key are
      // actually the raw *parameter* itself (its value lives in a `value`
      // attribute, no `<calculation>` at all) rather than a calculated field
      // dispatching on it. Bolting a fabricated CASE calculation onto a
      // plain parameter would corrupt it, so only touch columns that are
      // already genuine calculated fields.
      const existingCalc = selectOne<Element>(column, './calculation');
      if (!existingCalc) continue;

      // Numbered-KPI (and dimension-selector) variants — "KPI 1 LY", "KPI 1
      // Previous Period", "Plan KPI 1", "Primary KPI Contribution", each
      // duplicated "Select Dimension (copy)_..." parameter — all dispatch on
      // whatever base parameter the template already wired them to, which is
      // very often NOT the same as the calc's own caption/name (e.g. "KPI 1
      // LY" dispatches on "[Parameters].[KPI 1]", and "Primary KPI
      // Contribution" dispatches on an internal id like "[Parameters].[KPI 4
      // (copy)_...]"). Rebuilding the header from calcName pointed these at a
      // parameter that doesn't exist, breaking the field. Instead, read
      // whatever this specific column already dispatches on and keep it —
      // only the WHEN/THEN body is meant to change.
      const existingFormula = attr(existingCalc, 'formula');
      const dispatchExpr = extractDispatchExpr(existingFormula) ?? `[Parameters].[${calcName}]`;
      existingCalc.setAttribute('formula', buildCaseFormula(dispatchExpr, resolvedMapping));
    }
  }
}

// Updates non-trivial calculated field formulas.
function updateCalculatedFields(doc: Document, config: Config): void {
  const aliasMap = buildPassthroughAliasMap(doc);
  for (const [fieldName, formula] of Object.entries(config.calculated_fields ?? {})) {
    const lit = xpathLiteral(fieldName);
    // Same duplicate-column concern as updateParameterCalcs above.
    const columns = selectAll<Element>(
      doc,
      `//column[@caption=${lit} or @name=concat('[', ${lit}, ']')]`
    );
    if (!columns.length) continue;

    const resolvedFormula = applyAliasSubstitution(formula, aliasMap);
    for (const column of columns) {
      const calc = ensureElement(doc, column, 'calculation');
      calc.setAttribute('formula', resolvedFormula);
    }
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
