---
description: "Chart.js dashboard, creative growth analysis, data visualization"
globs: ["index.html", "*.html", "*.js"]
---

# Creative Dashboard — Rules

## Chart data
Always sort ascending at data layer before passing to Chart.js — library renders in array order.

## Games tracked
- INV (Invokers: Titan Legacy)
- UH (Urban Heat)

## Data source
goat-mcp tools (`fb_analyze_creatives`, `google_analyze_creatives`) feed this dashboard.

## Light/dark mode
Required for user-facing products. Wire to `localStorage` + `prefers-color-scheme`. CSS variables or Tailwind `dark:` classes. Toggle in header.

## Chart colors
No hardcoded colors — use CSS variables so dark mode works.
