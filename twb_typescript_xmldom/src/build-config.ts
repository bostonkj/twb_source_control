// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkbookType =
  | 'daily_diagnostics'
  | 'executive_summary'
  | 'weekly_cross_channel';

type ParameterCalcs  = Record<string, Record<string, string>>;
type RenamedFields   = Record<string, string>;
type Parameters      = Record<string, { allowed_values: string[]; default_value: string }>;
type CalculatedField = Record<string, string>;
type ColorPalette    = { name: string; type: string; colors: string[] };
type Datasource      = { name_in_workbook: string; project_path: string };

export type BuildSchema = {
  workbook:          WorkbookType;
  datasources:       Datasource[];
  renamed_fields:    RenamedFields;
  parameters:        Parameters;
  parameter_calcs:   ParameterCalcs;
  calculated_fields: CalculatedField;
  color_palettes:    ColorPalette[];
};

export type BuildConfig = BuildSchema;

export type BuildState = {
  workbookType: WorkbookType | null;
  schema:       BuildSchema | null;
  kpiCalcs:     string[];   // canonical KPI calc names, in order
  dimCalcs:     string[];   // canonical dimension calc names
  variantOf:    Record<string, string[]>;  // canonicalName → [variantName, ...]
};

export type CalcAnalysis = {
  kpiCalcs:  string[];
  dimCalcs:  string[];
  variantOf: Record<string, string[]>;
};

/** Callbacks the HTML must supply for status messaging and downloads. */
export type StatusCallbacks = {
  showStatus:  (id: string, type: 'success' | 'error', message: string, filename?: string) => void;
  clearStatus: (id: string) => void;
  downloadBlob: (blob: Blob, filename: string) => void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const WORKBOOK_SCHEMAS: Record<WorkbookType, string> = {
  daily_diagnostics:    '/configs/dd.json',
  executive_summary:    '/configs/es.json',
  weekly_cross_channel: '/configs/wcc.json',
};

// Suffixes / prefixes that mark a calc as a derived variant of a canonical one.
export const VARIANT_SUFFIXES = [' LY', ' Previous Period', ' Label', ' Contribution'] as const;
export const VARIANT_PREFIXES = ['Plan ', '%-Str '] as const;

// ─── Module-level state ───────────────────────────────────────────────────────

export const buildState: BuildState = {
  workbookType: null,
  schema:       null,
  kpiCalcs:     [],
  dimCalcs:     [],
  variantOf:    {},
};

// ─── Utilities ────────────────────────────────────────────────────────────────

/** HTML-escape a value for use in attribute values or text content. */
function esc(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── analyzeCalcs ─────────────────────────────────────────────────────────────

/**
 * Partitions parameter_calcs into canonical KPI calcs, canonical dimension calcs,
 * and a map from each canonical to its list of variant names.
 *
 * A calc is a variant if its name ends with a known suffix (e.g. " LY") or
 * starts with a known prefix (e.g. "Plan ") and a base calc with the remainder
 * of the name exists in the same set.
 *
 * A canonical calc is dimension-type if its option keys include "Date" or its
 * name contains "Dimension"; otherwise it is KPI-type.
 */
export function analyzeCalcs(parameterCalcs: ParameterCalcs): CalcAnalysis {
  const names      = Object.keys(parameterCalcs);
  const nameSet    = new Set(names);
  const variantSet = new Set<string>();
  const variantOf: Record<string, string[]> = {};

  for (const name of names) {
    let matched = false;

    for (const suf of VARIANT_SUFFIXES) {
      if (name.endsWith(suf)) {
        const base = name.slice(0, -suf.length);
        if (nameSet.has(base)) {
          variantSet.add(name);
          (variantOf[base] ??= []).push(name);
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      for (const pre of VARIANT_PREFIXES) {
        if (name.startsWith(pre)) {
          const base = name.slice(pre.length);
          if (nameSet.has(base)) {
            variantSet.add(name);
            (variantOf[base] ??= []).push(name);
            break;
          }
        }
      }
    }
  }

  const canonicals = names.filter(n => !variantSet.has(n));

  // Dimension calcs: option keys include 'Date', or name contains 'Dimension'.
  const dimCalcs = canonicals.filter(n => {
    const keys = Object.keys(parameterCalcs[n]);
    return keys.includes('Date') || n.includes('Dimension');
  });
  const kpiCalcs = canonicals.filter(n => !dimCalcs.includes(n));

  return { kpiCalcs, dimCalcs, variantOf };
}

// ─── Schema loading ───────────────────────────────────────────────────────────

/** Fetches the template schema JSON for the given workbook type. */
export async function loadBuildSchema(workbookType: WorkbookType): Promise<BuildSchema> {
  const url = WORKBOOK_SCHEMAS[workbookType];
  if (!url) throw new Error(`Unknown workbook type: ${workbookType}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not load schema for ${workbookType} (${resp.status})`);
  return resp.json() as Promise<BuildSchema>;
}

// ─── loadAndRenderBuildForm ───────────────────────────────────────────────────

/**
 * Fetches the schema for the given workbook type, updates buildState, and
 * renders all three form sections. Status feedback is delegated to the
 * provided callbacks so this module stays independent of the HTML's status UI.
 */
export async function loadAndRenderBuildForm(
  workbookType: WorkbookType,
  callbacks: Pick<StatusCallbacks, 'showStatus' | 'clearStatus'>,
  importedConfig: BuildConfig | null = null,
): Promise<void> {
  callbacks.clearStatus('status-build');

  try {
    const schema                         = await loadBuildSchema(workbookType);
    const { kpiCalcs, dimCalcs, variantOf } = analyzeCalcs(schema.parameter_calcs ?? {});

    buildState.workbookType = workbookType;
    buildState.schema       = schema;
    buildState.kpiCalcs     = kpiCalcs;
    buildState.dimCalcs     = dimCalcs;
    buildState.variantOf    = variantOf;

    renderRenamedFields(schema.renamed_fields ?? {}, importedConfig?.renamed_fields ?? null);
    renderKpiParams(kpiCalcs, variantOf, schema.parameter_calcs ?? {}, importedConfig?.parameter_calcs ?? null);
    renderDimMapping(dimCalcs, schema.parameter_calcs ?? {}, importedConfig?.parameter_calcs ?? null);

    (document.getElementById('build-form') as HTMLElement).style.display = '';
  } catch (err) {
    callbacks.showStatus(
      'status-build',
      'error',
      (err instanceof Error ? err.message : null) ?? 'Failed to load workbook schema.',
    );
  }
}

// ─── renderRenamedFields ──────────────────────────────────────────────────────

/**
 * Renders the renamed-fields section.
 *
 * Each row shows a source field name (read-only) and an editable display-name
 * input pre-filled from existingFields (if provided) or the template default.
 */
export function renderRenamedFields(
  templateFields: RenamedFields,
  existingFields:  RenamedFields | null,
): void {
  const container = document.getElementById('build-renamed-list') as HTMLElement;
  container.innerHTML = '';

  const entries = Object.entries(templateFields);
  if (!entries.length) {
    container.innerHTML = '<div class="build-empty">No renamed fields for this workbook.</div>';
    return;
  }

  // Build a reverse map: sourceField → friendlyName, from the imported config.
  const existingReverse: Record<string, string> = {};
  if (existingFields) {
    for (const [friendly, source] of Object.entries(existingFields)) {
      existingReverse[source] = friendly;
    }
  }

  for (const [defaultFriendly, sourceField] of entries) {
    const friendlyName = existingReverse[sourceField] ?? defaultFriendly;
    const row = document.createElement('div');
    row.className = 'renamed-row';
    row.innerHTML = `
      <span class="renamed-source" title="${esc(sourceField)}">${esc(sourceField)}</span>
      <span class="renamed-arrow">→</span>
      <input class="renamed-input" type="text"
             value="${esc(friendlyName)}"
             data-source="${esc(sourceField)}"
             placeholder="Display name" />
    `;
    container.appendChild(row);
  }
}

// ─── renderKpiParams ──────────────────────────────────────────────────────────

/**
 * Renders the KPI parameter_calcs section.
 *
 * Each canonical KPI calc gets a checkbox group. Checked metrics are the ones
 * that will be included in the exported config. Variants are shown as a hint
 * and will automatically inherit the same metric selection on export.
 *
 * Calcs are identified by their index so the export step can correlate
 * checkboxes back to their calc + metric without fragile name-based lookup.
 */
export function renderKpiParams(
  kpiCalcs:       string[],
  variantOf:      Record<string, string[]>,
  parameterCalcs: ParameterCalcs,
  existingCalcs:  ParameterCalcs | null,
): void {
  const section   = document.getElementById('build-kpi-section') as HTMLElement;
  const container = document.getElementById('build-kpi-list') as HTMLElement;
  container.innerHTML = '';

  if (!kpiCalcs.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  for (let ci = 0; ci < kpiCalcs.length; ci++) {
    const calcName    = kpiCalcs[ci];
    const metrics     = Object.keys(parameterCalcs[calcName] ?? {});
    const existingKeys = existingCalcs?.[calcName]
      ? new Set(Object.keys(existingCalcs[calcName]))
      : null; // null → check all by default
    const variants = variantOf[calcName] ?? [];

    const group = document.createElement('div');
    group.className = 'kpi-group';

    const variantHint = variants.length
      ? `<span class="kpi-variants">Auto-applied to: ${esc(variants.join(', '))}</span>`
      : '';

    const checkboxes = metrics.map((m, mi) => {
      const cbId    = `kpi-cb-${ci}-${mi}`;
      const checked = existingKeys ? existingKeys.has(m) : true;
      return `
        <label class="metric-item" for="${esc(cbId)}">
          <input type="checkbox" id="${esc(cbId)}"
                 data-calc-idx="${ci}" data-metric-idx="${mi}"
                 ${checked ? 'checked' : ''} />
          <span class="metric-name" title="${esc(m)}">${esc(m)}</span>
        </label>
      `;
    }).join('');

    group.innerHTML = `
      <div class="kpi-group-header">
        <span class="kpi-name">${esc(calcName)}</span>
        ${variantHint}
        <button class="kpi-toggle-all" type="button" data-calc-idx="${ci}">Toggle All</button>
      </div>
      <div class="metric-grid">${checkboxes}</div>
    `;
    container.appendChild(group);
  }
}

// ─── renderDimMapping ─────────────────────────────────────────────────────────

/**
 * Renders the dimension parameter_calcs section.
 *
 * When all dimension calcs share the same option keys, a single shared mapping
 * table is shown (one input per option). Each input carries a data-for-calcs
 * attribute listing all target calc names (newline-delimited) so the export
 * step can fan the value out to each.
 *
 * When option keys differ per calc, a separate block is rendered for each.
 */
export function renderDimMapping(
  dimCalcs:       string[],
  parameterCalcs: ParameterCalcs,
  existingCalcs:  ParameterCalcs | null,
): void {
  const section   = document.getElementById('build-dim-section') as HTMLElement;
  const container = document.getElementById('build-dim-list') as HTMLElement;
  container.innerHTML = '';

  if (!dimCalcs.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  // Check whether all dim calcs share identical option keys.
  const firstKeys   = Object.keys(parameterCalcs[dimCalcs[0]]).sort().join('\0');
  const allSameKeys = dimCalcs.every(n =>
    Object.keys(parameterCalcs[n]).sort().join('\0') === firstKeys,
  );

  if (allSameKeys && dimCalcs.length > 1) {
    const note = document.createElement('div');
    note.className   = 'dim-shared-note';
    note.textContent = `Applied to: ${dimCalcs.join(', ')}`;
    container.appendChild(note);

    const refMapping  = parameterCalcs[dimCalcs[0]];
    const existingRef = existingCalcs?.[dimCalcs[0]];
    const forCalcs    = dimCalcs.join('\n'); // newline-delimited for data attribute

    for (const [dimOption, formula] of Object.entries(refMapping)) {
      const currentFormula = existingRef?.[dimOption] ?? formula;
      const row = document.createElement('div');
      row.className = 'dim-row';
      row.innerHTML = `
        <span class="dim-label">${esc(dimOption)}</span>
        <input class="dim-input" type="text"
               value="${esc(currentFormula)}"
               data-dim="${esc(dimOption)}"
               data-for-calcs="${esc(forCalcs)}"
               placeholder="e.g. [Channel] or STR([Date])" />
      `;
      container.appendChild(row);
    }
  } else {
    for (const calcName of dimCalcs) {
      const mapping  = parameterCalcs[calcName];
      const existing = existingCalcs?.[calcName];

      const head = document.createElement('div');
      head.className   = 'dim-calc-name';
      head.textContent = calcName;
      container.appendChild(head);

      for (const [dimOption, formula] of Object.entries(mapping)) {
        const currentFormula = existing?.[dimOption] ?? formula;
        const row = document.createElement('div');
        row.className = 'dim-row';
        row.innerHTML = `
          <span class="dim-label">${esc(dimOption)}</span>
          <input class="dim-input" type="text"
                 value="${esc(currentFormula)}"
                 data-dim="${esc(dimOption)}"
                 data-for-calcs="${esc(calcName)}"
                 placeholder="e.g. [Channel]" />
        `;
        container.appendChild(row);
      }
    }
  }
}

// ─── exportBuildConfig ────────────────────────────────────────────────────────

/**
 * Reads the current form state and builds a complete BuildConfig object ready
 * for JSON serialisation and download.
 *
 * KPI variant calcs inherit the same metric selection as their canonical, but
 * use the variant's own formula values from the schema.
 */
export function exportBuildConfig(): BuildConfig | null {
  const { schema, workbookType, kpiCalcs, dimCalcs, variantOf } = buildState;
  if (!schema || !workbookType) return null;

  const config: BuildConfig = {
    workbook:          workbookType,
    datasources:       schema.datasources       ?? [],
    renamed_fields:    {},
    parameters:        schema.parameters        ?? {},
    parameter_calcs:   {},
    calculated_fields: schema.calculated_fields ?? {},
    color_palettes:    schema.color_palettes    ?? [],
  };

  // 1. Renamed fields — read display name from each input; key by friendly name.
  for (const input of document.querySelectorAll<HTMLInputElement>('#build-renamed-list .renamed-input')) {
    const sourceField  = input.dataset['source'];
    const friendlyName = input.value.trim();
    if (sourceField && friendlyName) {
      config.renamed_fields[friendlyName] = sourceField;
    }
  }

  // 2. KPI parameter_calcs — include only checked metrics; propagate to variants.
  for (let ci = 0; ci < kpiCalcs.length; ci++) {
    const calcName = kpiCalcs[ci];
    const metrics  = Object.keys(schema.parameter_calcs[calcName] ?? {});
    const selected: Record<string, string> = {};

    document
      .querySelectorAll<HTMLInputElement>(`#build-kpi-list input[data-calc-idx="${ci}"]`)
      .forEach((cb, mi) => {
        if (cb.checked && metrics[mi] !== undefined) {
          selected[metrics[mi]] = schema.parameter_calcs[calcName][metrics[mi]];
        }
      });

    config.parameter_calcs[calcName] = selected;

    // Each variant inherits the selected metric keys, using the variant's own formulas.
    for (const variantName of (variantOf[calcName] ?? [])) {
      const variantMapping: Record<string, string> = {};
      for (const metricKey of Object.keys(selected)) {
        const variantFormula = schema.parameter_calcs[variantName]?.[metricKey];
        if (variantFormula !== undefined) {
          variantMapping[metricKey] = variantFormula;
        }
      }
      config.parameter_calcs[variantName] = variantMapping;
    }
  }

  // 3. Dimension parameter_calcs — fan each input's value to all target calcs.
  for (const input of document.querySelectorAll<HTMLInputElement>('#build-dim-list .dim-input')) {
    const dimOption = input.dataset['dim'];
    const forCalcs  = (input.dataset['forCalcs'] ?? '').split('\n').filter(Boolean);
    for (const calcName of forCalcs) {
      config.parameter_calcs[calcName] ??= {};
      if (dimOption) config.parameter_calcs[calcName][dimOption] = input.value.trim();
    }
  }

  return config;
}

// ─── initBuildTab ─────────────────────────────────────────────────────────────

/**
 * Wires up the Build Config tab's DOM event listeners. Call once on page load,
 * passing the shared HTML utilities as callbacks.
 *
 * makeFileZone and the file-zone returned controller are owned by the caller;
 * this function only handles the workbook-type dropdown, the Toggle All buttons,
 * and the download button.
 */
export function initBuildTab(
  callbacks: StatusCallbacks,
  makeFileZone: (opts: {
    zoneId: string; inputId: string; promptId: string;
    nameId: string; clearId: string;
    onFileChange: (file: File | null) => void;
  }) => { getFile: () => File | null },
): void {
  // Toggle All — delegated listener, set up once so re-renders don't stack it.
  document.getElementById('build-kpi-list')!.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('.kpi-toggle-all');
    if (!btn) return;
    const ci  = btn.dataset['calcIdx'];
    const cbs = document.querySelectorAll<HTMLInputElement>(
      `#build-kpi-list input[data-calc-idx="${ci}"]`,
    );
    const anyUnchecked = [...cbs].some(cb => !cb.checked);
    cbs.forEach(cb => { cb.checked = anyUnchecked; });
  });

  // Config JSON import zone.
  makeFileZone({
    zoneId:   'zone-build-json',
    inputId:  'input-build-json',
    promptId: 'prompt-build-json',
    nameId:   'name-build-json',
    clearId:  'clear-build-json',
    onFileChange: async (file) => {
      if (!file) {
        (document.getElementById('build-form') as HTMLElement).style.display = 'none';
        callbacks.clearStatus('status-build');
        return;
      }
      try {
        const text     = await file.text();
        const imported = JSON.parse(text) as BuildConfig;
        const wbType   = imported.workbook;
        if (!wbType || !WORKBOOK_SCHEMAS[wbType]) {
          callbacks.showStatus(
            'status-build', 'error',
            'Could not detect workbook type. Config must have a "workbook" field: daily_diagnostics, executive_summary, or weekly_cross_channel.',
          );
          return;
        }
        (document.getElementById('build-type-select') as HTMLSelectElement).value = wbType;
        await loadAndRenderBuildForm(wbType, callbacks, imported);
      } catch (err) {
        callbacks.showStatus(
          'status-build', 'error',
          'Invalid JSON: ' + ((err instanceof Error ? err.message : null) ?? 'Parse error'),
        );
      }
    },
  });

  // Workbook type dropdown.
  document.getElementById('build-type-select')!.addEventListener('change', async (e) => {
    const wbType = (e.target as HTMLSelectElement).value as WorkbookType | '';
    if (!wbType) {
      (document.getElementById('build-form') as HTMLElement).style.display = 'none';
      callbacks.clearStatus('status-build');
      buildState.schema = null;
      return;
    }
    await loadAndRenderBuildForm(wbType, callbacks, null);
  });

  // Download button.
  document.getElementById('btn-build-download')!.addEventListener('click', () => {
    const config = exportBuildConfig();
    if (!config) return;

    const json     = JSON.stringify(config, null, 2);
    const blob     = new Blob([json], { type: 'application/json' });
    const shortMap: Record<WorkbookType, string> = {
      daily_diagnostics:    'dd',
      executive_summary:    'es',
      weekly_cross_channel: 'wcc',
    };
    const baseName = shortMap[buildState.workbookType!] ?? 'config';
    callbacks.downloadBlob(blob, `${baseName}_config.json`);
    callbacks.showStatus('status-build', 'success', 'Config downloaded.', `${baseName}_config.json`);
  });
}
