# MFD Email Typo Check — JotForm Custom Widget

Catches common email typos (gmial.com → gmail.com, yahooo.com → yahoo.com, hotnail.com → hotmail.com, .cmo → .com, etc.) using the open-source [Mailcheck](https://github.com/mailcheck/mailcheck) library.

## Where this fits

Three layers of email-typo defense for the MFD intake form:

| Layer | What | Where |
|---|---|---|
| 1 | JotForm "Confirm Email" double-entry | Native, already enabled on Personal Email field (qid 75) of both production and clone |
| 2 | **THIS WIDGET** — domain typo detection (gmial → gmail) | Custom Widget added to clone form first |
| 3 | DNS MX record validation at agent review time | `tools/validate_jurisdiction.py` |

## Local preview

```sh
cd tools/jotform-widgets/email-typo-check
python3 -m http.server 8767
# open http://localhost:8767
```

Try typing typo'd emails:
- `you@gmial.com` → suggests `you@gmail.com`
- `you@yahooo.com` → suggests `you@yahoo.com`
- `you@hotnail.com` → suggests `you@hotmail.com`
- `you@gmail.cmo` → suggests `you@gmail.com`
- `you@google.com` → no suggestion (real domain)

## Deploy alongside the ORI widget

If you've already set up the GitHub Pages repo for the ORI widget, just add this folder to the same repo:

```sh
# From this widget's directory
cp -r . /path/to/your/mfd-jotform-widgets/email-typo-check/
cd /path/to/your/mfd-jotform-widgets
git add email-typo-check
git commit -m "Add email-typo-check widget"
git push
```

Your widget URL becomes:
```
https://<your-username>.github.io/mfd-jotform-widgets/email-typo-check/index.html
```

If you haven't set up the GitHub Pages repo yet, see `../ori-lookup/README.md` for the one-time setup steps.

## Add to JotForm clone form

> **Note:** Layer 1 (JotForm's native "Confirm Email" double-entry) is already enabled on `Personal Email Address` (qid 75) on both forms. This widget is the SECOND defense layer.

1. Open the clone in the JotForm form builder: https://www.jotform.com/build/261151705585154
2. Click **+ Add Form Element** → **Widgets** tab → search "iFrame Embed" → drag onto the form
3. Position it RIGHT AFTER the "Personal Email Address" field
4. Click the gear icon on the iFrame Embed widget → **Widget Settings**
5. Paste your GitHub Pages URL (the email-typo-check one)
6. Set Frame Height: **300px** (the widget auto-resizes)
7. Set the field label to something like "**Verify your email is spelled correctly**"
8. Save

Test by previewing the form, typing `you@gmial.com` in the widget, and confirming the suggestion appears.

## What lands in your inbox

The widget submits one of these formats as its field value:

| Scenario | Value in submission inbox |
|---|---|
| Clean email, no typo detected | `you@gmail.com [confirmed]` |
| Applicant accepted a suggestion | `you@gmail.com [auto-corrected from gmial.com]` |
| Applicant **rejected** a suggestion | `you@gmial.com [⚠ rejected suggestion: gmail.com]` |
| Format is invalid | `(invalid format) [⚠ NOT SUBMITTED]` |

That `[⚠ rejected suggestion: ...]` tag is the critical signal — it tells you the applicant was warned of a likely typo and chose to keep what they typed. **Always double-check those before filing the FARS application.** The agent-side `jurisdiction-validator` skill will also flag these for you.

## File map

| File | Purpose |
|---|---|
| `index.html` | Widget shell + JFCustomWidget + Mailcheck script tags |
| `main.js` | Widget logic + Mailcheck wiring + JotForm submit format |
| `mailcheck.min.js` | Embedded copy of mailcheck v1.1.2 (3.6KB, MIT licensed) |
| `style.css` | Self-contained styling matching the ORI widget visual style |
| `README.md` | This file |

## Updating Mailcheck

Mailcheck is rarely updated, but when needed:

```sh
curl -sS -o mailcheck.min.js "https://cdnjs.cloudflare.com/ajax/libs/mailcheck/X.Y.Z/mailcheck.min.js"
git add mailcheck.min.js && git commit -m "Bump mailcheck to X.Y.Z" && git push
```

## Customizing the typo dictionary

Mailcheck has built-in lists of common email domains and TLDs. If you want to add more (e.g., regional ISPs your clients commonly use), edit `main.js` and add:

```js
Mailcheck.run({
  email: v,
  domains: Mailcheck.defaultDomains.concat(["yourisp.net"]),
  topLevelDomains: Mailcheck.defaultTopLevelDomains.concat(["co.us"]),
  suggested: ...,
});
```

For most clients the defaults are sufficient.
