# Next Agent Brief

You can use this project archive as a reusable starting point for future feature requests.

## Prompt pattern for future agents

Use prompts like:

`Please unzip the permaweb app code found at <ARWEAVE_ZIP_LINK> and add the following features: ...`

## What the next agent should do immediately

1. Download and unzip the archive.
2. Install dependencies (`npm install`).
3. Read `AGENT_HANDOFF.md` first.
4. Acknowledge policy doc (`npm run agents:ack`) if `AGENTS.md` changed.
5. Implement requested changes.
6. Run `npm run policy:check` (must pass before handoff).
7. Ship changes with `npm run ship` (canonical; includes deploy).
8. Return both links:
   - App URL (manifest)
   - Code archive URL

## Non-Optional Compliance

- Modify app => deploy is required.
- `npm run build` fails if source differs from `data/last-deploy.json`.
- Deploy writes evidence to `data/last-deploy.json` and policy checks use that artifact.
- If AGENTS instructions change, re-ack with `npm run agents:ack` or policy checks fail.

## App idea summary

This app generalizes a styled docs-like reader into a dynamic permaweb markdown experience:

- Markdown stored on Arweave becomes a multi-page book UI.
- Hash routes support direct links to specific pages.
- Writers can publish markdown once, then browse it as a navigable site.
- Upload flow supports permanent publication via ArConnect/Wander `dispatch()`.

## Quick acceptance checklist

- Route format still works: `/AppArweaveID/#MarkdownID/PageID`
- H1/H2 parsing semantics unchanged.
- Upload confirmation message and dispatch flow still functional.
- TOC and mobile layout remain usable.
