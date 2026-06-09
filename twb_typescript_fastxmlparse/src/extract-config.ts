import fs from 'node:fs';
import path from 'node:path';
import { attr, readXml, selectAll, selectOne } from './xml.js';

type ExtractedConfig = {
  datasources: Array<{ name_in_workbook: string; project_path: string }>;
  renamed_fields: Record<string, string>;
  parameters: Record<string, { allowed_values: string[]; default_value: string }>;
  parameter_calcs: Record<string, Record<string, string>>;
};

function extractDatasources(doc: Document): ExtractedConfig['datasources'] {
  const out: ExtractedConfig['datasources'] = [];
  for (const ds of selectAll<Element>(doc, '//datasource')) {
    const name = attr(ds, 'name') || attr(ds, 'formatted-name');
    if (!name) continue;
    const repo = selectOne<Element>(ds, './/repository-location');
    out.push({
      name_in_workbook: name,
      project_path: attr(repo, 'path')
    });
  }
  return out;
}

function extractRenamedFields(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
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

function extractParameters(doc: Document): ExtractedConfig['parameters'] {
  const out: ExtractedConfig['parameters'] = {};
  for (const col of selectAll<Element>(doc, "//datasource[@name='Parameters']//column[@caption]")) {
    const name = attr(col, 'caption');
    const defaultValue = attr(col, 'value');
    const allowedValues = selectAll<Element>(col, './/domain/member').map((m) => attr(m, 'alias') || attr(m, 'value')).filter(Boolean);
    if (name) {
      out[name] = { allowed_values: allowedValues, default_value: defaultValue };
    }
  }
  return out;
}

function extractParameterCalcs(doc: Document): ExtractedConfig['parameter_calcs'] {
  const out: ExtractedConfig['parameter_calcs'] = {};
  const targets = selectAll<Element>(doc, "//column[@caption and calculation[contains(@formula, 'CASE [Parameters].[')]]");
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

function main(): void {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node dist/src/extract-config.js <input.twb> <output.json>');
    process.exit(1);
  }

  const doc = readXml(inputPath);
  const config: ExtractedConfig = {
    datasources: extractDatasources(doc),
    renamed_fields: extractRenamedFields(doc),
    parameters: extractParameters(doc),
    parameter_calcs: extractParameterCalcs(doc)
  };

  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '', 'utf8');
  console.log(`Extracted config written to ${path.resolve(outputPath)}`);
}

main();
