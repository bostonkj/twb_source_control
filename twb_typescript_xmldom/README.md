# tableau-twb-tools

A small TypeScript project for working with Tableau `.twb` workbooks as source-controlled XML.

This version is built around `@xmldom/xmldom` and `xpath` instead of `fast-xml-parser`, because Tableau workbooks can be deeply nested and are sensitive to XML serialization details. This project focuses on a workflow where you:

1. strip connection-heavy metadata from a workbook to create a safer template copy
2. extract a client config from a workbook into JSON
3. patch a stripped/template workbook from JSON or YAML config

## Project goals

- keep Tableau workbook logic in source control as `.twb`
- separate reusable template structure from client-specific config
- make parameter updates and renamed-field mappings easier to review in Git
- provide starter utilities that are small enough to adapt locally

## What is included

```text
twb-typescript-xmldom-detailed/
  README.md
  package.json
  tsconfig.json
  src/
    xml.ts
    extract-config.ts
    strip-data.ts
    patch-twb.ts
  configs/
    sample-config.json
    daily-diagnostics.sample-config.json
  output/
    Daily Diagnostics.sample.stripped.twb
    Daily Diagnostics.sample.strip-summary.json
```

## Main packages used

### `@xmldom/xmldom`
Used in: `src/xml.ts`

What it does:
- parses `.twb` XML into a DOM `Document`
- serializes the modified DOM back to XML

Why it is used here:
- handles Tableau XML more safely than the earlier `fast-xml-parser` approach for this project
- avoids the nested-tag and attribute-serialization problems you ran into

### `xpath`
Used in: `src/xml.ts`, then indirectly everywhere else through helper functions

What it does:
- lets the scripts target Tableau XML nodes with XPath queries

Why it is used here:
- makes it easy to target specific workbook structures like `//datasource`, `//connection`, and `//column[@caption=...]`

### `js-yaml`
Used in: `src/patch-twb.ts`

What it does:
- loads YAML config files in addition to JSON

Why it is used here:
- lets you keep config in either JSON or YAML without changing the patching logic

### `typescript`
Used in: build step only

What it does:
- compiles the TypeScript source in `src/` to runnable JavaScript in `dist/`

## Main files and functions

### `src/xml.ts`
Shared XML helpers used by all other scripts.

Main functions:
- `readXml(filePath)`: reads a `.twb` file and parses it into a DOM document
- `writeXml(filePath, doc)`: writes a DOM document back to disk as XML
- `selectAll(node, expr)`: runs an XPath query and returns all matches
- `selectOne(node, expr)`: runs an XPath query and returns the first match
- `attr(node, name)`: safely reads an attribute value
- `ensureElement(doc, parent, tagName)`: finds or creates a child element

### `src/extract-config.ts`
Creates a starter config from a workbook.

Main functions:
- `extractDatasources(doc)`: pulls datasource names and repository paths
- `extractRenamedFields(doc)`: finds simple renamed-field calcs like `[customDimension1]`
- `extractParameters(doc)`: extracts parameter member lists and default values
- `extractParameterCalcs(doc)`: extracts CASE-based parameter mappings

### `src/strip-data.ts`
Creates a safer template/source-control copy of a workbook by removing or redacting connection-heavy metadata.

Main functions:
- `removeNodes(nodes)`: removes a list of XML nodes from the workbook
- `sanitizeConnections(doc)`: redacts sensitive connection attributes

### `src/patch-twb.ts`
Applies a JSON or YAML config to a workbook.

Main functions:
- `loadConfig(filePath)`: loads JSON or YAML config
- `xpathLiteral(value)`: safely escapes strings for XPath queries
- `updateDatasourcePaths(doc, config)`: updates datasource project paths
- `updateRenamedFields(doc, config)`: updates simple renamed-field formulas
- `replaceDomainValues(doc, column, values)`: replaces parameter domain values
- `updateParameters(doc, config)`: updates parameter member lists and defaults
- `buildCaseFormula(parameterName, mapping)`: converts config mappings into Tableau CASE formulas
- `updateParameterCalcs(doc, config)`: updates parameter-driven calculated fields
- `validateConfig(config)`: validates a few config assumptions before write

## Local requirements

- Node.js 20+ recommended
- npm

## Install

From the project directory:

```bash
npm install
npm run build
```

## Run instructions

### 1. Extract a config from a workbook

```bash
npm run extract-config --   "/absolute/path/to/Daily Diagnostics.twb"   "./configs/from-workbook.json"
```

What it does:
- reads the input workbookchr
- extracts datasource paths, simple renamed fields, parameters, and CASE-based parameter calcs
- writes a starter config file

### 2. Strip connection-heavy metadata from a workbook

```bash
npm run strip-data --   "/absolute/path/to/Daily Diagnostics.twb"   "./output/Daily_Diagnostics_stripped.twb"
```

What it does:
- removes `repository-location`, `metadata-records`, `semantic-values`, `extract`, and `connection-customization` nodes where present
- redacts a few connection attributes like `server`, `port`, `dbname`, and `username`
- writes a safer workbook copy for templating or source control

### 3. Patch a workbook from config

```bash
npm run patch --   "./configs/from-workbook.json"   "./output/Daily_Diagnostics_stripped.twb"   "./output/patched.twb"
```

What it does:
- reads the config
- updates datasource paths
- updates simple renamed-field calcs
- updates parameter member lists and defaults
- updates parameter-driven CASE calculations

## Sample files included

These sample files were generated from the attached/local workbook:

- input workbook: `/home/user/Daily Diagnostics.twb`
- sample config: `configs/daily-diagnostics.sample-config.json`
- sample stripped workbook: `output/Daily Diagnostics.sample.stripped.twb`
- strip summary: `output/Daily Diagnostics.sample.strip-summary.json`

## Sample config structure

The config file uses this shape:

```json
{
  "datasources": [
    {
      "name_in_workbook": "all_data_daily",
      "project_path": "client_project"
    }
  ],
  "renamed_fields": {
    "Goal": "customDimension1"
  },
  "parameters": {
    "Select Dimension": {
      "allowed_values": ["Date", "Channel"],
      "default_value": "Date"
    }
  },
  "parameter_calcs": {
    "Select Dimension": {
      "Date": "STR([Date])",
      "Channel": "[Channel]"
    }
  }
}
```

## Notes and limits

- `extract-config` is a starter extractor, not a full Tableau semantic model exporter.
- `extractRenamedFields` only captures simple formulas that are exactly one field reference, like `[customDimension1]`.
- `extractParameterCalcs` is aimed at CASE-based parameter calculations and will not perfectly model every possible Tableau calc pattern.
- `strip-data` is intentionally conservative: it tries to preserve workbook logic and structure while removing a subset of data/connection-heavy metadata.
- `patch` assumes the workbook structure still contains the fields and parameters referenced by the config.

## Suggested workflow

1. copy a workbook into your repo as a working template source
2. run `strip-data` to create a cleaner template copy
3. run `extract-config` against either the original workbook or a client version
4. review and simplify the extracted config
5. commit the stripped workbook plus config to Git
6. use `patch` to generate client-specific workbook builds

## Troubleshooting

### `Cannot find module dist/src/...`
Run:

```bash
npm run build
```

before calling any of the runtime scripts.

### Tableau says the generated workbook is unreadable
Check that:
- the input workbook opens before patching
- the config only updates fields/parameters that really exist in the template
- the generated file still contains required Tableau attributes like `custom="true"` on palette nodes if your workbook depends on them

### XPath updates are not finding a node
This usually means the workbook caption/name is not exactly what the config expects. Inspect the relevant `column` or `datasource` node in the `.twb` and update the config or XPath target.
