# AGENTS.md

## App Modification Guidelines

The markdown files in this repo provide guidance for Arweave and AO workflows in a web app environment.

1. Read `PERMAWEB_SKILLS.md` (and `SKILLS.md`) for Arweave upload/query and AO integration patterns.
2. If AO process authoring is requested, use `AO-PROCESS-GUIDE.md`.

## Permaweb Novel (this fork)

This UI is a **PermawebOS Seed / Public Square–style fork** repurposed as a **Chinese-style serial novel reader**:

- **Arweave**: each novel intro and each chapter is a separate transaction tagged with `App-Name` = `PermawebNovel-Fork`, `Record-Type` = `novel-intro` | `novel-chapter`, `Novel-Id`, `Content-Sha256` (body), `Publisher` (wallet), `Record-Key` (e.g. `intro:{uuid}` / `chapter:{uuid}:{n}`), `Mirror-Nonce`, plus chapter `Chapter-Index` when applicable. Payload is `NOVEL_META_JSON:{...}\n---\n` followed by Markdown body (meta `v: 2` includes the same fields; after broadcast the Web2 mirror adds `arweaveTxId`).
- **Web2 fast cache**: after signing, the app mirrors the same payload to `https://fastsave-production.up.railway.app/` (title uses a `NOVEL|intro|…` / `NOVEL|chapter|…` prefix so PHP `search` can find rows). Browsers may block this POST due to **CORS** unless that origin allows your deploy origin.
- **Display rule**: the **library and TOC load Arweave first** in the browser; the Web2 URL is only used to **fill gaps** (no on-chain row yet, or transaction not yet retrievable). When the gateway can serve the tx, the UI uses **Arweave only** for that content.

## Chain App Rules

1. If a user asks to change this app, deploy after the change and include the deployed app link in the response.
   - Enforcement: `npm run build` / `npm run policy:check` fail when source changes are not represented by `data/last-deploy.json`.
2. Keep the current deploy pipeline and protocol. Do not switch uploader implementations unless the user explicitly asks.
3. Prefer the default gateway behavior in `scripts/deploy.mjs` (`https://arweave.net`). Only override with `--gateway` / `ARWEAVE_GATEWAY` when explicitly requested.
4. Before deploy, wallet credentials are resolved in this order:
   - `--wallet=/absolute/path/to/wallet.json`
   - `ARWEAVE_WALLET`
   - `wallet.json` in the app root (same directory as `package.json`)
5. **Required pre-deploy agent step**: generate an Arweave wallet and place it at `./wallet.json` in app root (where `package.json` lives) unless the user supplied an explicit wallet path.
   - Command: `npm run wallet:new`
6. Deploy order requirement:
   - Upload the app source code archive first.
   - Archive contents must be the app root itself (no wrapper directory).
   - Exclude only `wallet.json` and `node_modules`.
   - Preserve markdown files (`*.md`), including this `AGENTS.md`.
   - Upload the archive with `Content-Encoding: gzip` and gzip-encoded data.
7. When uploading app assets and the manifest, add tag `code` with the 43-character Arweave ID of the uploaded code archive.
8. Add `forked-from` on upload for app transactions (code archive, assets, manifest). Use `--forked-from=<arweave-id>` or `FORKED_FROM` when available.
9. In deployment output, provide both:
   - App URL
   - Code archive transaction ID/link
10. On first run, you must run this repeatable command sequence:
   - `npm install`
   - `npm run wallet:new` (if wallet is missing)
   - `npm run deploy:up`
   - Canonical shortcut: `npm run ship` (handles install-if-needed + wallet-if-missing + deploy).
11. Keep a persistent origin fork artifact at `data/fork-origin.json` with shape `{ "forkedFrom": "<43-char-arweave-id>" }`:
   - This value represents the original code pull origin and should remain immutable across normal deploys.
   - Agents may create the file if missing, but must not rewrite an existing `forkedFrom` value unless explicitly requested.
   - Prefer this artifact as the default `forked-from` source for deploy commands.
12. AGENTS acknowledgment is enforced:
   - If `AGENTS.md` changes, run `npm run agents:ack` before build/deploy.
   - `.agents-ack.json` must match the latest AGENTS hash.
13. Deploy evidence is enforced:
   - Successful deploy writes `data/last-deploy.json` with timestamp, manifest ID, code archive ID, gateway, `forkedFrom`, and `sourceHash`.
   - Policy checks compare current source fingerprint against this artifact and fail when deploy is missing after edits.
