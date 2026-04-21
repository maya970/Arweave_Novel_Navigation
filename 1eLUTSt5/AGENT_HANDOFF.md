# ChronoWire Agent Handoff Guide

This repository contains a permaweb app that renders Arweave-hosted markdown files as page-based reading experiences.

## Core behavior

- Route format: `/AppArweaveID/#MarkdownID/PageID`
- `MarkdownID` is the Arweave tx ID for a markdown file.
- Each `# H1` starts a new page.
- A leading `## H2` inside each page is rendered as that page subtitle.
- Remaining markdown is rendered as page content.

## Important files

- `index.html`: app shell, top bar controls, TOC, and upload confirmation UI.
- `styles.css`: visual style system and responsive layout.
- `src/main.js`: routing, markdown parsing, page rendering, upload+dispatch flow.
- `scripts/build.mjs`: builds browser bundle into `dist/`.
- `scripts/deploy.mjs`: uploads assets + manifest to Arweave.

## Upload flow (ArConnect/Wander)

The upload UX is:

1. User clicks `Upload` in top bar.
2. File picker opens.
3. App shows confirmation card:
   `Uploading X.XX KB to Arweave permanently. Are you sure?`
4. User confirms with `🚀︎` or cancels with `×`.
5. App dispatches with `window.arweaveWallet.dispatch(transaction)`.
6. Returned tx ID is loaded immediately as the active markdown document.

Wallet permissions requested:

- `DISPATCH`
- `ACCESS_ADDRESS`
- `SIGN_TRANSACTION`

## Local development

```bash
npm install
npm run build
npm run preview
```

## Deploy to Arweave

```bash
npm run deploy:up
```

If wallet is missing:

```bash
npm run wallet:new
```

Output includes:

- `Manifest ID (AppArweaveID)`
- app URL
- code archive URL
- route format

## Recommended workflow for modifications

1. Implement changes in `index.html`, `styles.css`, and/or `src/main.js`.
2. Run `npm run build`.
3. Smoke-check key flows:
   - load by tx ID
   - page navigation
   - deep hash routes
   - upload+dispatch flow
4. Deploy with `npm run deploy:up`.
5. Share both the app URL and code archive URL.

## Guardrails

- Never include `wallet.json` in artifacts or commits.
- Keep route format backwards compatible.
- Preserve markdown parsing semantics (`#` -> page, leading `##` -> subtitle).
- Keep Content-Type tags accurate when uploading assets.
