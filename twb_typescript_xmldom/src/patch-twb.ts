import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * Maps opaque auto-generated "Calculation_XXXXX" names to a readable
 * passthrough wrapper column (one whose formula is exactly "[rawName]"),
 * preferring wrappers outside "(copy)" datasources. Only cryptic ids are
 * aliased — readable fields like "Spend" are left alone, otherwise every KPI
 * formula gets rerouted through its renamed wrapper's internal id.
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

// Rewrites [FieldName] references to their passthrough aliases, if any.
function applyAliasSubstitution(formula: string, aliasMap: Map<string, string>): string {
  return formula.replace(/\[([^\]]+)\]/g, (whole, ref: string) => {
    const alias = aliasMap.get(ref);
    return alias ? `[${alias}]` : whole;
  });
}

// ─── KPI dispatch resolution ───────────────────────────────────────────────────

// Maps parameter captions to internal names via the Parameters datasource —
// reliable ground truth even if calc formulas were corrupted by an earlier patch run.
function buildParameterCaptionMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of selectAll<Element>(doc, "//datasource[@name='Parameters']//column[@caption]")) {
    const caption = attr(col, 'caption');
    const name = attr(col, 'name');
    if (caption && name) map.set(caption, name);
  }
  return map;
}

// Numbered KPI params ("KPI 1", ...) and Primary/Secondary in any wording
// (e.g. WCC's "Primary  KPI TY").
function isKpiBaseCaption(caption: string): boolean {
  return /^KPI\s+\d+$/.test(caption) || /\bPrimary\b/.test(caption) || /\bSecondary\b/.test(caption);
}

// Prefixes a KPI variant name may carry (e.g. "Plan KPI 1" → base "KPI 1").
const KPI_VARIANT_PREFIXES = ['Plan ', '%-Str '];

/**
 * Resolves the "[Parameters].[X]" dispatch expression for a KPI-family calc
 * (variants like "KPI 1 LY" or "Primary KPI Label" dispatch on their base KPI
 * parameter, which may be a cryptic internal id). Returns null for anything
 * not clearly tied to a KPI base so the caller preserves the column's
 * existing dispatch instead.
 */
function resolveKpiDispatch(calcName: string, paramCaptions: Map<string, string>): string | null {
  const kpiBaseCaptions = [...paramCaptions.keys()].filter(isKpiBaseCaption);
  if (!kpiBaseCaptions.length) return null;

  const candidates = [calcName];
  for (const prefix of KPI_VARIANT_PREFIXES) {
    if (calcName.startsWith(prefix)) candidates.push(calcName.slice(prefix.length));
  }

  let best: string | null = null;
  for (const candidate of candidates) {
    for (const base of kpiBaseCaptions) {
      if (candidate === base) {
        if (!best || base.length > best.length) best = base;
        continue;
      }
      if (candidate.startsWith(base) && /^[\s(]/.test(candidate[base.length] ?? ' ')) {
        if (!best || base.length > best.length) best = base;
      }
    }
  }
  if (!best) return null;

  const internalName = paramCaptions.get(best);
  return internalName ? `[Parameters].${internalName}` : null;
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
    // Match on the underlying formula (exists in a blank template) — the
    // friendly name doesn't exist yet, so searching for it would no-op.
    const formulaLit = xpathLiteral(`[${targetField}]`);
    const columns = selectAll<Element>(
      doc,
      `//column[calculation[@formula=${formulaLit}]]`
    );
    // Update every duplicate ("(copy)" datasources, per-worksheet caches).
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

// dispatchExpr is the full "[Parameters].[X]" this CASE switches on.
function buildCaseFormula(dispatchExpr: string, mapping: Record<string, string>): string {
  const parts = [`CASE ${dispatchExpr}`];
  for (const [label, expr] of Object.entries(mapping)) {
    parts.push(`WHEN "${label}" THEN ${expr}`);
  }
  parts.push('END');
  return parts.join(' ');
}

// Extracts the "[Parameters].[X]" an existing CASE formula dispatches on.
function extractDispatchExpr(formula: string): string | null {
  return formula.match(/^CASE\s+(\[Parameters\]\.\[[^\]]+\])/)?.[1] ?? null;
}

function updateParameterCalcs(doc: Document, config: Config): void {
  const aliasMap = buildPassthroughAliasMap(doc);
  const paramCaptions = buildParameterCaptionMap(doc);
  for (const [calcName, mapping] of Object.entries(config.parameter_calcs ?? {})) {
    const lit = xpathLiteral(calcName);
    // Calcs can be duplicated (copy datasources, per-worksheet caches) — update every match.
    const columns = selectAll<Element>(
      doc,
      `//column[@caption=${lit} or @name=concat('[', ${lit}, ']')]`
    );
    if (!columns.length) continue;

    // Prefer passthrough aliases over raw calculation references.
    const resolvedMapping: Record<string, string> = {};
    for (const [label, expr] of Object.entries(mapping)) {
      resolvedMapping[label] = applyAliasSubstitution(expr, aliasMap);
    }

    for (const column of columns) {
      // Skip columns that are the raw parameter itself (no <calculation>) —
      // bolting a CASE calc onto a plain parameter would corrupt it.
      const existingCalc = selectOne<Element>(column, './calculation');
      if (!existingCalc) continue;

      // KPI-family calcs dispatch on their base KPI parameter, derived from
      // the Parameters datasource rather than the column's existing formula
      // (which may be corrupted from an older patch run). Non-KPI calcs
      // (e.g. "Select Dimension") keep their existing dispatch — only the
      // WHEN/THEN body changes.
      const existingFormula = attr(existingCalc, 'formula');
      const dispatchExpr =
        resolveKpiDispatch(calcName, paramCaptions) ??
        extractDispatchExpr(existingFormula) ??
        `[Parameters].[${calcName}]`;
      existingCalc.setAttribute('formula', buildCaseFormula(dispatchExpr, resolvedMapping));
    }
  }
}

// Updates non-trivial calculated field formulas.
function updateCalculatedFields(doc: Document, config: Config): void {
  const aliasMap = buildPassthroughAliasMap(doc);
  for (const [fieldName, formula] of Object.entries(config.calculated_fields ?? {})) {
    const lit = xpathLiteral(fieldName);
    // Same duplicate-column handling as updateParameterCalcs.
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

// Replaces hex values in palettes that already exist in the template.
function updateColorPalettes(doc: Document, config: Config): void {
  for (const palette of config.color_palettes ?? []) {
    const lit = xpathLiteral(palette.name);
    const paletteEl = selectOne<Element>(
      doc,
      `//preferences/color-palette[@name=${lit}]`
    );
    if (!paletteEl) continue;

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

// All workbook types share the same operations; add per-type overrides here if needed.

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
  // Prefer the config's declared workbook; fall back to sheet-name detection.
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
  const [configPath, templatePath, outputPath] = process.argv.slice(2);
  if (!configPath || !templatePath) {
    console.error('Usage: node patch-twb.js <config.json|yaml> <template.twb> [output.twb]');
    process.exit(1);
  }

  const resolvedOutput =
    outputPath ??
    path.join(path.dirname(templatePath), `${path.basename(templatePath, '.twb')}_patched.twb`);

  const rawConfig = fs.readFileSync(configPath, 'utf8');
  const config = /\.ya?ml$/i.test(configPath)
    ? (yaml.load(rawConfig) as Config)
    : (JSON.parse(rawConfig) as Config);

  const doc = readXml(templatePath);
  patchWorkbook(doc, config);
  writeXml(resolvedOutput, doc);
  console.log(`Patched workbook written to ${resolvedOutput}`);
}

// Run main() only when executed directly (not when imported by server.ts).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
