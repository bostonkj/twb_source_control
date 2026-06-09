import fs from 'node:fs';
import path from 'node:path';
import { attr, readXml, selectAll, selectOne } from './xml.js';

// ─── Workbook identity ────────────────────────────────────────────────────────

export type WorkbookName =
  | 'daily_diagnostics'
  | 'executive_summary'
  | 'weekly_cross_channel';

// Maps a TWB file path to its canonical workbook name by inspecting
// unique sheet names that exist in each workbook.
export function detectWorkbook(doc: Document): WorkbookName {
  const sheets = selectAll<Element>(doc, '//worksheet')
    .map((ws) => attr(ws, 'name'))
    .filter(Boolean);

  const sheetSet = new Set(sheets);

  if (sheetSet.has('Channel Contribution') && sheetSet.has('Channel Trends')) {
    return 'daily_diagnostics';
  }
  if (sheetSet.has('Contribution Type (LY)') && sheetSet.has('Funnel Stage (Trend)')) {
    return 'executive_summary';
  }
  if (sheetSet.has('Icon Date Range') && sheetSet.has('Icon Funnel Stage')) {
    return 'weekly_cross_channel';
  }

  throw new Error(
    'Could not identify workbook. Expected one of: Daily Diagnostics, Executive Summary, Weekly Cross Channel.'
  );
}

// ─── Shared extraction helpers ────────────────────────────────────────────────

type Datasource = { name_in_workbook: string; project_path: string };
type Parameters = Record<string, { allowed_values: string[]; default_value: string }>;
type ParameterCalcs = Record<string, Record<string, string>>;
type RenamedFields = Record<string, string>;
type CalculatedFields = Record<string, string>;
type ColorPalette = { name: string; type: string; colors: string[] };

// Collects unique datasource names and their repository-location paths.
// Datasources that appear multiple times keep only their first non-empty path.
function extractDatasources(doc: Document): Datasource[] {
  const seen = new Map<string, string>();

  for (const ds of selectAll<Element>(doc, '//datasource')) {
    const name = attr(ds, 'name') || attr(ds, 'formatted-name');
    if (!name) continue;
    const repo = selectOne<Element>(ds, './/repository-location');
    const projectPath = attr(repo, 'path');
    if (!seen.has(name) || (projectPath && !seen.get(name))) {
      seen.set(name, projectPath);
    }
  }

  return Array.from(seen.entries()).map(([name_in_workbook, project_path]) => ({
    name_in_workbook,
    project_path,
  }));
}

// Extracts simple renamed-field formulas of the form [SomeField].
function extractRenamedFields(doc: Document): RenamedFields {
  const out: RenamedFields = {};
  for (const col of selectAll<Element>(doc, '//column[@caption]')) {
    const caption = attr(col, 'caption');
    if (!caption) continue;
    const calc = selectOne<Element>(col, './calculation');
    const formula = attr(calc, 'formula');
    const match = formula.match(/^\[([^\]]+)\]$/);
    if (match && caption !== match[1]) {
      out[caption] = match[1];
    }
  }
  return out;
}

// Extracts parameter defaults and visible member lists from the Parameters datasource.
function extractParameters(doc: Document): Parameters {
  const out: Parameters = {};
  for (const col of selectAll<Element>(doc, "//datasource[@name='Parameters']//column[@caption]")) {
    const name = attr(col, 'caption');
    const defaultValue = attr(col, 'value');
    const allowedValues = selectAll<Element>(col, './/domain/member')
      .map((m) => attr(m, 'alias') || attr(m, 'value'))
      .filter(Boolean);
    if (name) {
      out[name] = { allowed_values: allowedValues, default_value: defaultValue };
    }
  }
  return out;
}

// Extracts CASE-based parameter calculations into label-to-expression mappings.
function extractParameterCalcs(doc: Document): ParameterCalcs {
  const out: ParameterCalcs = {};
  const targets = selectAll<Element>(
    doc,
    "//column[@caption and calculation[contains(@formula, 'CASE [Parameters].[')]]"
  );
  for (const col of targets) {
    const name = attr(col, 'caption');
    const formula = attr(selectOne<Element>(col, './calculation'), 'formula');
    if (!name || !formula) continue;
    const mapping: Record<string, string> = {};
    const regex = /WHEN\s+"([^"]+)"\s+THEN\s+(.+?)(?=\s+WHEN\s+"|\s+END$)/g;
    for (const match of formula.matchAll(regex)) {
      mapping[match[1]] = match[2].trim();
    }
    if (Object.keys(mapping).length) out[name] = mapping;
  }
  return out;
}

// Extracts all non-trivial calculated fields: excludes simple renames ([Field]),
// CASE parameter dispatchers, and bare parameter default values.
function extractCalculatedFields(doc: Document): CalculatedFields {
  const out: CalculatedFields = {};
  const seen = new Set<string>();

  for (const col of selectAll<Element>(doc, '//column[@caption]')) {
    const caption = attr(col, 'caption');
    if (!caption || seen.has(caption)) continue;

    const calc = selectOne<Element>(col, './calculation');
    const formula = attr(calc, 'formula').trim();
    if (!formula) continue;

    // Skip simple renames
    if (/^\[[^\]]+\]$/.test(formula)) continue;
    // Skip CASE parameter dispatchers (captured in parameter_calcs)
    if (formula.includes('CASE [Parameters].[')) continue;
    // Skip bare quoted strings and date literals (parameter defaults)
    if (/^"[^"]*"$/.test(formula)) continue;
    if (/^#\d{4}-\d{2}-\d{2}#$/.test(formula)) continue;

    seen.add(caption);
    out[caption] = formula;
  }

  return out;
}

// Extracts custom color palette definitions from the workbook preferences.
function extractColorPalettes(doc: Document): ColorPalette[] {
  const out: ColorPalette[] = [];
  for (const palette of selectAll<Element>(doc, '//preferences/color-palette')) {
    const name = attr(palette, 'name');
    const type = attr(palette, 'type');
    const colors = selectAll<Element>(palette, './color').map((c) => c.textContent?.trim() ?? '');
    if (name) out.push({ name, type, colors });
  }
  return out;
}

// ─── Workbook-specific config types ──────────────────────────────────────────

type BaseConfig = {
  workbook: WorkbookName;
  datasources: Datasource[];
  renamed_fields: RenamedFields;
  parameters: Parameters;
  parameter_calcs: ParameterCalcs;
  calculated_fields: CalculatedFields;
  color_palettes: ColorPalette[];
};

// All three workbooks share the same config shape; workbook-specific logic lives
// in the extraction routing below rather than in separate types.
type WorkbookConfig = BaseConfig;

// ─── Per-workbook extractors ──────────────────────────────────────────────────

function extractDailyDiagnostics(doc: Document): WorkbookConfig {
  return {
    workbook: 'daily_diagnostics',
    datasources: extractDatasources(doc),
    renamed_fields: extractRenamedFields(doc),
    parameters: extractParameters(doc),
    parameter_calcs: extractParameterCalcs(doc),
    calculated_fields: extractCalculatedFields(doc),
    color_palettes: extractColorPalettes(doc),
  };
}

function extractExecutiveSummary(doc: Document): WorkbookConfig {
  return {
    workbook: 'executive_summary',
    datasources: extractDatasources(doc),
    renamed_fields: extractRenamedFields(doc),
    parameters: extractParameters(doc),
    parameter_calcs: extractParameterCalcs(doc),
    calculated_fields: extractCalculatedFields(doc),
    color_palettes: extractColorPalettes(doc),
  };
}

function extractWeeklyCrossChannel(doc: Document): WorkbookConfig {
  return {
    workbook: 'weekly_cross_channel',
    datasources: extractDatasources(doc),
    renamed_fields: extractRenamedFields(doc),
    parameters: extractParameters(doc),
    parameter_calcs: extractParameterCalcs(doc),
    calculated_fields: extractCalculatedFields(doc),
    color_palettes: extractColorPalettes(doc),
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function extractConfig(doc: Document): WorkbookConfig {
  const workbook = detectWorkbook(doc);
  switch (workbook) {
    case 'daily_diagnostics':
      return extractDailyDiagnostics(doc);
    case 'executive_summary':
      return extractExecutiveSummary(doc);
    case 'weekly_cross_channel':
      return extractWeeklyCrossChannel(doc);
  }
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

function main(): void {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node dist/src/extract-config.js <input.twb> <output.json>');
    process.exit(1);
  }

  const doc = readXml(inputPath);
  const config = extractConfig(doc);

  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '', 'utf8');
  console.log(`Extracted config written to ${path.resolve(outputPath)}`);
  console.log(`Workbook detected: ${config.workbook}`);
}

main();
