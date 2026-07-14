# twb_typescript_fastxmlparse (discontinued)

First go at a TypeScript CLI for extracting, patching, and stripping Tableau `.twb` workbooks. Discontinued due to library incompatibility

## Structure

```
twb_typescript_fastxmlparse/
  src/
    xml.ts                — Shared DOM helpers (readXml, writeXml, selectAll, attr, ...)
    extract-config.ts     — Config extraction from a workbook
    patch-twb.ts          — Applies a JSON config to a template workbook
    strip-data.ts         — Removes connection metadata for source-control-safe copies
  configs/                — Sample and extracted config files
  workbooks/              — Input workbooks used during development
  output/                 — Generated output files from CLI runs
```

## Install & build

```bash
npm install
npm run build
```

## CLI usage

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

---

## Why this project was discontinued

This project was the first working implementation of the TWB toolchain and was used to validate the core approach. It was superseded by `twb_typescript_xmldom` for two reasons:

**1. Nesting depth**: Tableau workbooks routinely exceed `fast-xml-parser`'s default tag nesting limit of 256, causing `Maximum nested tags exceeded` errors.
**2. Attribute serialization**: `fast-xml-parser` uses a JavaScript object to for its mapping, causing changes how some attributes were written back
-  `custom="true"` would return `custom` causing load issues in tableau.
