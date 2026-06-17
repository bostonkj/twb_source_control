# TWB Source Control — Presentation Notes

**Format:** Problem → Bridge → Solution  
**Audience:** Product team (mixed technical/leadership)  
**Goal:** Present as proof of concept; gather input on fit and path forward

---

## Slide 1 — The Problem: No Structure, No Scale

Tableau workbooks are opaque. Every client configuration — KPIs, field mappings, parameters — is hand-wired into XML that's not readable, not diffable, and not reusable. Reconfiguring a report for a new client takes 2-3 hours of careful XML surgery, and when a template changes upstream, there's no systematic way to re-apply a client's settings without starting over. That's fine at current scale. It won't be.

**Key message:** The process doesn't break — it just doesn't scale.

---

## Slide 2 — The Root Cause

The config *is* the client-specific work. The workbook *is* the template. Treating them as one file means every client gets a bespoke fork — and every fork becomes a maintenance burden.

The underlying insight: if you can separate client configuration from the workbook structure, you can version it, automate it, and reuse it.

**Key message:** The problem is structural, and it has a structural fix.

---

## Slide 3 — The Architecture (3 Layers)

A lightweight TypeScript server + browser UI, three operations:

- **Extract** — upload a workbook, parse the XML, output a structured JSON config (datasources, renamed fields, parameters, KPI mappings, calculated fields)
- **Store** — the JSON lives in source control; diffs are human-readable
- **Patch** — feed the JSON + a blank template into the patcher, get a fully configured workbook out

**Visual suggestion:** Simple flow diagram  
`.twbx` → Extract → `config.json` → Patch + `template.twb` → configured `.twb`

**Key message:** Three steps, clear handoffs, automatable.

---

## Slide 4 — What's Inside the Config

Quick walkthrough of the JSON schema — show one real example (DD or WCC config). The point isn't the code; it's that a non-Tableau person could read this file and understand what a client's report does.

**Sample snippet to show (~10 lines):**
```json
{
  "renamed_fields": {
    "FCST Clicks": "FCSTClicks",
    "Budget Detail": "BudgetDetail"
  },
  "parameter_calcs": {
    "Select KPI 1": {
      "Revenue": "[Revenue]",
      "Clicks": "[Clicks]",
      "ROAS": "SUM([Revenue]) / SUM([Spend])"
    }
  }
}
```

**Key message:** Configuration is now readable, reviewable, and portable.

---

## Slide 5 — Where This Goes (and What We Need From You)

This PoC covers the three core report types — Daily Diagnostics, Executive Summary, Weekly Cross Channel — with a working extract/patch/build UI. The proof of concept answers: *can this work?*

What it doesn't answer is how it fits into how the product team thinks about tooling, standards, and the client onboarding workflow.

**Closing questions for the room:**

1. Does this pattern (config-as-JSON + blank template) align with how you're thinking about report maintenance going forward?
2. Are there report types or configuration edge cases we should stress-test before treating this as a foundation?
3. What would need to be true for this to move from PoC to something the broader team could use?

---

## Speaker Notes

- Keep slides visual — let the architecture diagram do the work on slide 3
- Slide 4 snippet should be real data from an actual config file (pull from `configs/mkuk_dd.json` or `mkuk_wcc.json`)
- Don't oversell the toolchain details — the product team cares about the pattern, not the implementation
- The 2-3 hour reconfiguration time is a concrete anchor — use it early and refer back to it
- Closing questions are intentionally open — you're not asking for a decision, you're asking for direction
