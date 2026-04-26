# MFD JotForm Widgets

Public widget bundle for Multiform Defense's NJ firearms application intake.

> ⚠️ **This repository is intentionally public** because JotForm needs to fetch the widget files via HTTPS. **No secrets, API keys, or client data are stored here** — just the widget UI + the public ORI/ZIP/NJSP datasets sourced from FBI Crime Data Explorer and US Census Bureau.

## What's here

| Folder | Purpose |
|---|---|
| `ori-lookup/` | Smart NJ Police Department / ORI lookup. Solves the postal-vs-legal-municipality trap. Hard-blocks known-dead ORIs (Newark NJ0071400, etc.); warns on State-Police-patrolled towns with the patrolling barracks's contact email. |
| `email-typo-check/` | Catches common email-domain typos (gmial → gmail, yahooo → yahoo, etc.) via Mailcheck + a stuck-key detector. |

## Live widget URLs (after GitHub Pages enabled)

- ORI Lookup: `https://tamerarslanouk-mfd.github.io/mfd-jotform-widgets/ori-lookup/index.html`
- Email Typo Check: `https://tamerarslanouk-mfd.github.io/mfd-jotform-widgets/email-typo-check/index.html`

Each folder has its own README with deployment + JotForm-wiring instructions.

## How updates flow

1. Widget source-of-truth lives at `MFD AGENT 001/tools/jotform-widgets/{ori-lookup,email-typo-check}/`
2. The auto-refresh LaunchAgent regenerates upstream data weekly
3. To deploy a change to production:
   ```sh
   # From MFD AGENT 001 root
   cp -R tools/jotform-widgets/ori-lookup ../mfd-jotform-widgets/
   cp -R tools/jotform-widgets/email-typo-check ../mfd-jotform-widgets/
   cd ../mfd-jotform-widgets
   git add -A && git commit -m "Refresh widgets" && git push
   ```
   GitHub Pages redeploys in ~1 minute. Hard-refresh the JotForm preview to pick up the change.
