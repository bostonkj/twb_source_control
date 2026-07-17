# twb_typescript_xmldom

TypeScript toolchain for extracting, patching, and stripping Tableau `.twb` workbooks. Built on `@xmldom/xmldom` and `xpath` to safely handle Tableau's deeply nested XML without losing attribute fidelity.

## Structure

```
twb_typescript_xmldom/
  server.ts               — Express API server + static file host
  index.html              — Browser UI (Extract, Patch, Strip, Build Config tabs)
  src/
    xml.ts                — Shared DOM helpers (readXml, writeXml, selectAll, attr, ...)
    extract-config.ts     — Workbook detection and config extraction
    patch-twb.ts          — Applies a JSON config to a template workbook
    strip-data.ts         — Removes connection metadata for source-control-safe copies
    build-config.ts       — Build Config tab logic (browser module)
  configs/
    dd.json               — Daily Diagnostics template schema
    es.json               — Executive Summary template schema
    wcc.json              — Weekly Cross Channel template schema
  workbooks/              — Blank template workbooks
```

## Install & build

```bash
npm install
npm run build
```

## Run

```bash
node server.ts
```

The UI will be live at `http://localhost:3000` in your browser.

## CLI usage

The three core operations can also be run directly against the compiled output.

**Extract a config from a workbook**
```bash
node dist/src/extract-config.js "/path/to/workbook.twb" "./configs/output.json"
```

**Strip connection metadata from a workbook**
```bash
node dist/src/strip-data.js "/path/to/workbook.twb" "./output/stripped.twb"
```

**Patch a template workbook with a config**
```bash
node dist/src/patch-twb.js "./configs/client.json" "./workbooks/template.twb" "./output/patched.twb"
```

## Implementation notes

Detailed rationale moved out of inline comments. Section headings reference the file and function each note belongs to.

### patch-twb.ts

**`buildPassthroughAliasMap` — passthrough alias resolution.** Some fields are pure passthrough wrappers of another field — e.g. a "Filter 1" quick-filter field whose entire formula is just `[Calculation_598415825521487872]` (itself a renamed dimension). Formulas elsewhere in the workbook (like the "Select Dimension" parameter dispatch) sometimes reference the raw wrapped field directly instead of going through the friendlier wrapper, which is what actually gets used in user-facing filters. Preferring the wrapper avoids two different fields silently representing "the same" dimension in different places. The function builds a map from a raw field's internal name to the name of a column that passes through to it (formula === `[rawName]`). When more than one such wrapper exists, it prefers one defined in a datasource that isn't a "(copy)" duplicate, since those tend to be the ones worksheets actually use — falling back to the first one found otherwise. Only opaque, auto-generated `Calculation_XXXXX` names are considered for wrapping — never an already-readable field like "Spend" or "Impressions". Almost every plain metric field has its own "Platform - Spend"-style renamed_fields wrapper, and those wrappers are simple passthroughs too. Without this restriction, every clean field reference in every KPI formula got silently rerouted through its renamed wrapper's internal id — e.g. "Primary KPI Contribution"'s `[Spend]` turning into `[Calculation_0157526077595648]` (the id behind "Platform - Spend"). The aliasing was specifically about cryptic ids like Custom Dim 1/2/3 that have no readable name at all.

**`buildParameterCaptionMap` — KPI dispatch ground truth.** Maps each parameter's current caption to its real internal name, scoped to the Parameters datasource. Parameters aren't duplicated the way data columns are, so this is a reliable source of truth — unlike a calc column's own existing formula, which may already be corrupted from an earlier patch run that didn't preserve dispatch correctly.

**`resolveKpiDispatch` — KPI-family dispatch resolution.** Resolves the real `[Parameters].[X]` dispatch expression for a KPI-family calc. "KPI 1 LY", "KPI 1 Previous Period", "Plan KPI 1", "KPI 1 Tooltip", "Primary KPI Contribution", "Primary KPI Label", etc. all dispatch on whichever base KPI parameter they're a variant of, which for Primary KPI, Secondary KPI, and (in this template) KPI 3/KPI 4 is a cryptic internal id that has nothing to do with the caption. Only names clearly tied to a known KPI base caption get a result; everything else (e.g. "Select Dimension" and its several genuinely independent duplicate parameters) returns null so the caller falls back to preserving whatever that specific column already dispatches on.

**`updateRenamedFields` — matching strategy.** Columns are matched on the underlying calculation formula (a stable identifier that exists in the blank template) rather than on the desired friendly name, which doesn't exist yet. An earlier version searched for a column already captioned/named as the NEW display name, so it never found anything and silently no-opped. A field can also be duplicated across more than one datasource (e.g. a "(copy)" datasource) and cached again per-worksheet under datasource-dependencies — every instance is updated, not just the first, so the rename shows up no matter which copy a worksheet reads from.

**`updateParameterCalcs` — duplicate columns, raw parameters, and dispatch recovery.** Calculated fields can appear more than once: once in the "live" datasource (or a duplicated "(copy)" datasource) and again cached per-worksheet under datasource-dependencies. `selectOne` only patched the first hit, leaving other copies stale — every match is updated. Some columns captioned/named the same as a parameter_calcs key are actually the raw *parameter* itself (its value lives in a `value` attribute, no `<calculation>` at all) rather than a calculated field dispatching on it; bolting a fabricated CASE calculation onto a plain parameter would corrupt it, so only columns that are already genuine calculated fields are touched. For KPI-family calcs, the correct dispatch is derived from the Parameters datasource directly rather than trusting the column's existing formula — if the file was ever patched by an older, buggier version of this tool that rebuilt the CASE header from the calc name, the existing formula is itself already corrupted (literally dispatching on e.g. `[Parameters].[KPI 1 Previous Period]`, which doesn't exist), and preserving it would perpetuate the break instead of fixing it. For anything not clearly tied to a known KPI base (e.g. "Select Dimension", whose several duplicate copies are genuinely independent parameters), the column's existing dispatch is preserved — only the WHEN/THEN body changes.

### extract-config.ts

**`extractParameterCalcs` — CASE branch parsing.** WHEN conditions may be single- or double-quoted (Tableau accepts both, and branches added at different times often mix styles within the same CASE), and THEN expressions routinely span multiple lines. An older regex only matched double-quoted conditions and used `.` without dotAll, so any branch whose value crossed a line to reach the next double-quoted WHEN — or whose only neighbor was single-quoted — was silently dropped. `[\s\S]` matches across newlines without needing the `s` flag, and the alternation accepts either quote style.

### build-config.ts

**`kpiSortKey` — KPI display ordering.** Anything "Primary"-related sorts first, "Secondary"-related second, then plain "KPI 1", "KPI 2", ... in numerical order; anything else falls after in its original order (stable sort). Matching on the word "Primary"/"Secondary" anywhere in the name (rather than requiring an exact "Primary KPI") is deliberate: workbooks aren't consistent about spelling — Weekly Cross Channel names its main calcs "Primary  KPI TY" / "Secondary  KPI TY" (double space, "TY" suffix), which wouldn't match a strict equality check.

**`analyzeCalcs` — canonical vs. variant partitioning.** Partitions parameter_calcs into canonical KPI calcs, canonical dimension calcs, and a map from each canonical to its variant names. A calc is a variant if its name ends with a known suffix (e.g. " LY") or starts with a known prefix (e.g. "Plan ") and a base calc with the remainder of the name exists in the same set. A canonical calc is dimension-type if its option keys include "Date" or its name contains "Dimension"; otherwise it is KPI-type. kpiCalcs is returned ordered primary, secondary, then numbered KPIs — the raw extraction order (whatever order fields happened to appear in the .twb) made the Build Config UI hard to scan.

**`renderRenamedFields` — row layout.** templateFields and existingFields are keyed by the field's raw name in the datasource, mapped to its friendly (display) name, e.g. `{ "customDimension1": "Custom Dimension 1" }`. Each row shows, left to right: the field's raw name in the datasource (read-only), the field's default name in the blank template (read-only — always shown, even once overridden), and an editable display-name input pre-filled from existingFields (if provided) or the template default.

**`renderKpiParams` — checkbox groups.** Each canonical KPI calc gets a checkbox group; checked metrics are included in the exported config. Variants are shown as a hint and automatically inherit the same metric selection on export. Calcs are identified by index so the export step can correlate checkboxes back to their calc + metric without fragile name-based lookup.

**`renderDimMapping` — shared vs. per-calc tables.** When all dimension calcs share the same option keys, a single shared mapping table is shown (one input per option). Each input carries a `data-for-calcs` attribute listing all target calc names (newline-delimited) so the export step can fan the value out to each. When option keys differ per calc, a separate block is rendered for each.

**`exportBuildConfig` — variant inheritance.** Reads the current form state and builds a complete BuildConfig ready for JSON serialisation and download. KPI variant calcs inherit the same metric selection as their canonical, but use the variant's own formula values from the schema.

**`initBuildTab` — ownership boundaries.** Wires up the Build Config tab's DOM event listeners; call once on page load, passing the shared HTML utilities as callbacks. makeFileZone and its returned controller are owned by the caller — this function only handles the workbook-type dropdown, the Toggle All buttons, and the download button. The Toggle All listener is delegated and set up once so re-renders don't stack it.
