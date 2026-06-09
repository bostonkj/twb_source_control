# Chat Summary

## Overview

This chat focused on creating a source-control-friendly workflow for Tableau `.twb` workbooks using a template workbook plus client-specific config.

## Main conclusions

* A YAML/JSON config plus template `.twb` patching approach is a strong fit when the datasource schema is standardized and the only client-specific differences are renamed fields and parameter mappings/defaults.
* That approach is especially valuable for GitHub source control, template-version upgrades, repeatability, and reducing manual Tableau edits.
* TypeScript was identified as a strong alternative to Python for this workflow, with XSLT as a possible secondary option for narrow XML-to-XML transforms.

## Work completed

* A starter TypeScript project was created to:
  * patch a template `.twb` using a config file
  * extract a starter config from an existing `.twb`
  * strip workbook connection/metadata details for safer template/source-control use
* The project initially used `fast-xml-parser`.
* A security-related dependency update was made to move to `fast-xml-parser@5.8.0`.
* The project then ran into two issues with `fast-xml-parser`:
  * Tableau XML attribute serialization problems, such as `custom="true"` being written incorrectly
  * parser failures with `Maximum nested tags exceeded`
* Because of those issues, the project was revised to use `@xmldom/xmldom` plus `xpath`, which is better suited for deeply nested Tableau XML and safer attribute preservation.
* A more detailed version of the project was created with:
  * a fuller README
  * summaries of the main functions and packages
  * one-line comments above helper functions
  * a sample JSON config
  * a sample stripped workbook generated from the provided `Daily Diagnostics.twb`

## Troubleshooting discussed

* The npm “packages are looking for funding” message was identified as informational only and not a problem.
* A VS Code TypeScript error about `node:fs` was explained as a Node typings / editor configuration issue, typically resolved by ensuring `@types/node` is installed and adding `"types": ["node"]` to `tsconfig.json`.
* A `strip-data` run that wrote output successfully but then threw an error was traced to a post-write summary parse rather than the actual strip step.
* A later `patch` error with `Maximum nested tags exceeded` was identified as a parser limitation rather than malformed workbook XML.

## Current project state

* The recommended project version is the xmldom-based TypeScript project.
* It supports:
  * extracting config from a `.twb`
  * stripping workbook linkage/metadata details
  * patching a template `.twb` from config
  * local testing and iteration

## File locations provided

* `Daily Diagnostics.twb`: `/home/user/Daily Diagnostics.twb`
* `Daily Diagnostics_1.twb`: `/home/user/Daily Diagnostics_1.twb`
