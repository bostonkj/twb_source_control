# Slide 1: TWB XML becomes more maintainable when we turn workbook structure into source-controlled config
- `.twb` files mix reusable workbook logic with formatting and layout details, which makes raw XML hard to compare and maintain directly in Git.
- The minimal teaching workbook helps isolate the core XML sections—datasources, calculated fields, parameters, worksheet logic, and dashboard zones—so the same patterns are easier to recognize in a real production workbook.
- Once those sections are understood, the next tool can extract starter config from an existing `.twb`, strip workbook-specific metadata, and patch a template workbook from config using the XML itself.
- The payoff is simpler source control, more repeatable template updates, and fewer manual Tableau edits because the config can be versioned separately from the full workbook artifact.

**Speaker notes**
- Start with the problem: TWB files are source-controllable, but not very human-friendly when logic and presentation are all mixed together.
- Use the minimal example as the bridge to the real workbook: it shows which XML blocks matter and what they represent.
- Then connect that to the tool: if we can reliably read and target those XML sections, we can extract config and patch templates instead of editing everything by hand.
- Close with the takeaway: this is the first step toward config-driven, source-controlled Tableau template management.
