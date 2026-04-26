# MFD ORI Lookup — JotForm Custom Widget

Smart NJ Police Department / ORI lookup widget that runs inside the JotForm intake form.

## What it does

When an applicant fills out the MFD intake form:

1. They enter their home address (Street, City, ZIP) into the widget
2. Widget calls the **US Census Geocoder** (free, no API key) to resolve the address to its **legal municipality** — solves the "postal city ≠ legal town" trap (e.g., a "Bridgeton, NJ" mailing address that's actually in Hopewell Township)
3. Widget looks up the matching **ORI** (Originating Agency Identifier) in the bundled `ori-data.json` (563 NJ municipalities, generated from `tools/data/nj_ori_lookup.json`)
4. Result is displayed: `✓ Match found — NJ0020100 — Paramus PD (Bergen County)`
5. Special cases (Newark's NJNPD0000 vs deprecated NJ0071400, Camden CCPD migration, State-Police-patrolled towns) get prominent warnings
6. Manual override always available: searchable dropdown of all 563 municipalities

The widget submits its value back to JotForm in this format:
```
ORI: NJ0020100 — Paramus PD (Bergen County)
```

This is suitable as the value for the existing "What Police Department serves your Jurisdiction?" field (qid 5 on both production and clone forms).

---

## Local preview (developer / testing)

```sh
cd tools/jotform-widgets/ori-lookup
python3 -m http.server 8765
# open http://localhost:8765 in your browser
```

The widget runs standalone (no JotForm wrapper) — UI is fully functional, but the form-submission part is no-op. Good for verifying:
- Address inputs accept text and enable the "Find" button at 5-char ZIP
- "Find" button calls Census Geocoder (you'll see network activity in DevTools → Network)
- Match result appears with the right ORI
- Manual override search filters the muni list correctly

Test addresses to try:
- **Trenton State House, 125 W State St, Trenton, NJ 08608** — should match `Trenton (Mercer)` → `NJ0111100`
- Any Newark address — should match `Newark (Public Safety)` → `NJNPD0000` with the cancellation warning
- Try typing "hopewell" in the manual search — shows both Cumberland and Mercer Hopewell Townships

---

## Deploy to GitHub Pages (free hosting)

JotForm Custom Widgets must be hosted at a public HTTPS URL. GitHub Pages is free and works perfectly.

### One-time setup

1. **Create a new GitHub repo** (separate from the private `MFD AGENT 001` repo since this needs to be public).
   - Go to https://github.com/new
   - Name it `mfd-jotform-widgets` (or whatever you like)
   - Visibility: **Public**
   - Don't initialize with README/license (we'll push our files)
   - Create repo

2. **Push the widget files to that repo:**
   ```sh
   cd tools/jotform-widgets/ori-lookup
   git init
   git add index.html main.js style.css ori-data.json README.md
   git commit -m "Initial: MFD ORI lookup widget"
   git branch -M main
   git remote add origin https://github.com/<your-username>/mfd-jotform-widgets.git
   git push -u origin main
   ```

3. **Enable GitHub Pages on the repo:**
   - Go to your repo → Settings → Pages
   - Source: "Deploy from a branch"
   - Branch: `main`, folder: `/ (root)`
   - Save
   - Wait ~1 minute for the first deploy

4. **Your widget URL will be:**
   ```
   https://<your-username>.github.io/mfd-jotform-widgets/index.html
   ```

   Verify it loads in a browser. You should see the widget UI.

---

## Add the widget to the JotForm clone (`Max Test Form-Claude`)

> **Critical:** All testing happens on the clone form (`261151705585154`), NOT the production form (`260295941117054`). Promote to production only after the clone is verified.

1. **Open the clone form in JotForm form builder:**
   https://www.jotform.com/build/261151705585154

2. **Add an iFrame Embed widget:**
   - Click "+ Add Form Element" → "Widgets" tab → search "iFrame Embed" → drag onto the form
   - Position it **right after** the "What Police Department serves your Jurisdiction?" field (qid 5), or replace that field — your call

3. **Configure the widget:**
   - Click the gear icon on the iFrame Embed widget → "Widget Settings"
   - Paste your GitHub Pages URL:
     ```
     https://<your-username>.github.io/mfd-jotform-widgets/index.html
     ```
   - Set Frame Height: **600px** (the widget auto-resizes via `JFCustomWidget.requestFrameResize`, but a sensible default helps)
   - Save

4. **Hide the original "Police Department" textbox** (qid 5) — Conditional Logic isn't needed; just delete the field or set it to "Hidden" via Field Properties → Advanced. The widget will be the source of truth going forward.

5. **Test by previewing the form:**
   - Click "Preview Form" in the form builder
   - Fill out the address fields
   - Use the widget to find your ORI
   - Submit the form
   - Check the submission in the JotForm Inbox — the widget value should appear under the iFrame Embed field's name

---

## Updating the widget after changes

When you change widget files locally:

```sh
cd tools/jotform-widgets/ori-lookup
git add -A
git commit -m "Describe what changed"
git push
# GitHub Pages redeploys in ~1 minute
```

JotForm doesn't cache the widget aggressively, but if a change doesn't appear, **hard-refresh** the form-builder preview (Cmd+Shift+R on Mac).

---

## Updating the ORI data

If `NJ_ORI_Master_List.xlsx` changes (new municipality added, ORI corrected, special case identified):

```sh
# from project root
python3 tools/build_ori_lookup.py
cp tools/data/nj_ori_lookup.json tools/jotform-widgets/ori-lookup/ori-data.json
cd tools/jotform-widgets/ori-lookup
git add ori-data.json
git commit -m "Refresh ORI data from XLSX"
git push
```

Then hard-refresh the JotForm preview to see the updated lookup data.

---

## File map

| File | Purpose |
|---|---|
| `index.html` | Widget shell + JFCustomWidget script tag |
| `main.js` | Widget logic: Census Geocoder calls, ORI lookup, fuzzy matching, manual override, JotForm submit wiring |
| `style.css` | Self-contained styling (no framework) |
| `ori-data.json` | All 563 NJ municipalities with ORI, county, special cases. Generated from `tools/data/nj_ori_lookup.json`. |
| `README.md` | This file |

---

## Promotion to production (after clone verification)

When the clone form's widget behaves correctly across multiple test submissions:

1. Open the production form: https://www.jotform.com/build/260295941117054
2. Repeat the "Add iFrame Embed widget + configure URL + hide qid 5" steps from above
3. Use the same GitHub Pages URL (no separate deploy needed — both forms point to the same widget)
4. Submit one real test entry to confirm

Production form ID: `260295941117054`
Clone form ID: `261151705585154`
