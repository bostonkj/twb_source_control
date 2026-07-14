# TWB Source Control

A research and tooling project for bringing version control and repeatable deployment to Tableau workbooks.

---

## Background

Tableau `.twb` files are XML under the hood, but they're typically treated as finished products — opened in Tableau Desktop, edited manually, and saved as opaque blobs. This makes it hard to track what changed between versions, understand what makes one client's workbook different from another's, or confidently update a template without breaking every client that depends on it.

This project explores whether you can separate the *template structure* of a workbook from the *client-specific configuration* that lives inside it, then manage each independently in source control.

---

## Learning the XML architecture

The first phase was understanding the `.twb` format well enough to know what was safe to touch and what wasn't.

A `.twb` file is a single XML document. The top-level sections break down roughly as:

| Section | What it contains |
|---|---|
| `<datasources>` | Field definitions, renamed fields, parameters, calculated fields, connection metadata |
| `<worksheets>` | Per-sheet visualization logic — which fields are on rows/columns, mark types, filters, formatting |
| `<dashboards>` | Layout zones, sheet references, sizing |
| `<windows>` | Saved view state |

The key insight for this project: almost everything that differs between clients — KPI selections, dimension mappings, field display names, datasource paths — lives in `<datasources>`. The `<worksheets>` and `<dashboards>` sections are almost entirely structural and the same across clients.

Reference files for the XML structure are in `reading tableau files/`:

- `minimal_tableau_workbook_reference.twb` — a stripped-down workbook showing each major XML section with one example each
- `minimal_tableau_workbook_reference_commented.twb` — the same file with inline XML comments explaining each section

---

## Parsing with TypeScript — two approaches

### Attempt 1: `fast-xml-parser` (`twb_typescript_fastxmlparse/`)

The first implementation used [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser), a popular and fast XML library for Node.js.

It ran into two problems specific to Tableau workbooks:

**1. Nesting depth limits**

Tableau workbooks are deeply nested XML. `fast-xml-parser` has a default limit of 256 nested tags and throws `Maximum nested tags exceeded` on real-world workbooks, which can exceed this easily in their `<worksheets>` sections.

The limit can be raised, but it's a config escape hatch rather than a real fix — and it doesn't address the second problem.

**2. Attribute serialization**

`fast-xml-parser` parses XML attributes into a JavaScript object representation, then re-serializes them when writing back. Tableau is sensitive to certain attribute forms — for example, boolean attributes like `custom="true"` on color palette nodes. The re-serialized output dropped the quotes or changed the representation in ways Tableau rejected on load.

This project lives in `twb_typescript_fastxmlparse/` and is kept for reference. It's not recommended for production use.

### Attempt 2: `@xmldom/xmldom` + `xpath` (`twb_typescript_xmldom/`)

The second implementation switched to [`@xmldom/xmldom`](https://github.com/xmldom/xmldom) with [`xpath`](https://github.com/goto100/xpath). This combination treats the workbook as a proper DOM document throughout — no intermediate JavaScript representation — so attributes are preserved exactly as-is.

This is the active project. See `twb_typescript_xmldom/` for the full implementation.

---

## Current toolchain (`twb_typescript_xmldom/`)

A TypeScript server with a browser UI. Three core operations, plus a config builder:

**Extract** — upload a `.twb` or `.twbx`, receive a structured JSON config capturing:
- Datasource paths
- Renamed fields (display name → source field mappings)
- Parameter definitions (allowed values, defaults)
- Parameter-driven CASE calculations (KPI and dimension selectors)
- Calculated fields
- Color palettes

**Patch** — upload a JSON config and a blank template `.twb`, receive a fully configured workbook. The patcher writes back datasource paths, renamed field formulas, parameter members, and CASE calc bodies.

**Strip** — upload a `.twb`, receive a sanitized version with connection metadata, server credentials, and extract definitions removed. Used to create source-control-safe template copies.

**Build Config** — a form-based UI for creating a client config from scratch. Loads the template schema for a selected workbook type, presents renamed fields and KPI/dimension selectors, and exports a ready-to-patch JSON config.

### Source files

```
twb_typescript_xmldom/
  server.ts               — Express server, API endpoints
  index.html              — Browser UI (Extract, Patch, Strip, Build Config tabs)
  src/
    xml.ts                — Shared XML helpers (readXml, writeXml, selectAll, attr, ...)
    extract-config.ts     — Workbook detection and config extraction logic
    patch-twb.ts          — Config-to-workbook patching logic
    strip-data.ts         — Metadata removal and connection sanitization
    build-config.ts       — Browser module: Build Config tab logic and types
  configs/
    dd.json               — Daily Diagnostics template schema
    es.json               — Executive Summary template schema
    wcc.json              — Weekly Cross Channel template schema
  workbooks/              — Blank template workbooks for each report type
```

---

## End goals

### 1. Version control client workbooks

Each client's workbook configuration lives as a JSON file in source control. A diff between two versions of `mkuk_dd.json` shows exactly what changed — which KPIs were added, which dimension mappings were updated, whether a datasource path changed. No more comparing two binary-ish XML files manually.

### 2. Version control templates

Template workbooks (stripped of client data and connection details) live alongside the configs. When the product team ships a new template version, the change is visible as a diff against the previous template workbook. Nothing is hidden inside a Tableau Server publish.

### 3. Simplify template updates across clients

When a template changes, the update process becomes:

1. Extract a fresh config from the new template
2. Diff the new template schema against each client's existing config — new fields, removed fields, changed parameter options
3. Update each client config to match the new structure (guided by the Build Config UI)
4. Patch the new template with each updated config
5. Validate and publish

Rather than manually re-configuring each client workbook inside Tableau Desktop, the process becomes a structured config update with a clear audit trail.

---

## Project structure

```
twb_source_control/
  README.md                               — this file
  reading tableau files/                  — reference workbooks for learning the XML format
  chat summary/                           — notes from early research phases
  example_architecutre/                   — sketches of the intended file/folder layout
  presentation/                           — presentation notes for the project overview
  twb_typescript_fastxmlparse/            — first attempt (fast-xml-parser, not recommended)
  twb_typescript_xmldom/                  — active project (@xmldom/xmldom + xpath)
```
