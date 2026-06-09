# tableau-twb-tools

TypeScript utilities for Tableau `.twb` files using `@xmldom/xmldom` + `xpath`.

## Why this version

This build avoids the `fast-xml-parser` issues you hit:
- `Maximum nested tags exceeded`
- Tableau-unfriendly attribute serialization like `custom` instead of `custom="true"`

## Install

```bash
npm install
npm run build
```

## Extract config from a workbook

```bash
npm run extract-config -- "/absolute/path/to/Daily Diagnostics.twb" "./configs/from-workbook.json"
```

## Strip connection/data metadata

```bash
npm run strip-data -- "/absolute/path/to/Daily Diagnostics.twb" "./output/Daily_Diagnostics_stripped.twb"
```

## Patch a workbook from config

```bash
npm run patch -- "./configs/from-workbook.json" "./output/Daily_Diagnostics_stripped.twb" "./output/patched.twb"
```

## Notes

- `extract-config` produces a starter JSON config you should review before using for production patches.
- `strip-data` is conservative: it removes connection and metadata blocks while preserving workbook structure.
- `patch` is scoped to datasource paths, renamed-field calcs, parameter defaults/member lists, and parameter-driven CASE calcs.
