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
