# Renderer security and reproducible builds (2026-09-13)

Scope: E02 (Markdown), E12 (dependency audit), O06 (runtime/build provenance).
This change does not own HTTP authentication, WebDAV application logic, or Electron window policy.

## Renderer boundary and CSP handoff

`services/SafeMarkdown.js` owns a private marked parser and the single `renderSafeMarkdown()` boundary. Parsing and optional highlighting happen **before** DOMPurify. Both `addMessage()` (initial/history) and `renderMarkdownContent()` (all stream prefixes/finalization) call it before writing HTML. Missing browser libraries fail closed. No raw HTML fallback exists.

The HTML-only policy strips scripts, SVG/MathML, styles, forms/interactive widgets, event attributes, dangerous URL protocols, DOM-clobbering IDs/names, and `data-*` application-action attributes. Ordinary Markdown, syntax highlighting, tables, safe images/links and literal formula text remain. This app had no formula-rendering library to migrate. App-owned code/table enhancements run after sanitization using DOM APIs.

`index.html` loads only local scripts/styles. Its pre-paint appearance code is in `services/InitialAppearance.js`. All static/dynamic inline event attributes in index/app were migrated to an explicit data-action registry and addEventListener; arguments are escaped data, never executable strings. The registry ignores Markdown containers and DOMPurify removes injected data-action attributes.

Main can use this script policy for the main app:

```text
script-src 'self'; script-src-attr 'none'; object-src 'none'; base-uri 'none'
```

No script nonce/hash, `unsafe-inline`, `unsafe-hashes` or `unsafe-eval` is required for index/app. Existing inline layout styles and programmatic styles still need `style-src 'self' 'unsafe-inline'`; this is a style exception, not a script exception. Main owns final connect/img/media/frame policies and opaque document-preview CSP. Separately, the original `desktop-live.html` contained an inline appearance script; main was notified because it is outside this slice.

Pairing consumes `#pair=TOKEN` first (legacy query remains accepted), removes every pair parameter before the first fetch even for an already-authenticated device, and preserves other URL parameters.

## Exact dependencies

| Package | Pin | Purpose |
| --- | --- | --- |
| dompurify | 3.4.15 | HTML sanitization |
| marked | 18.0.13 | Private Markdown parser/browser UMD |
| highlight.js | 11.12.0 | Pinned highlighting library/license |
| @highlightjs/cdn-assets | 11.12.0 | Matching local browser build and two themes; dev build input |
| webdav | 5.10.0 | Audited ESM release; sibling owns native-import adapter |
| selfsigned | 5.5.0 | CommonJS entry, asynchronous certificate generation |
| electron | 44.3.0 | Exact dev runtime; official release September 8, 2026 |
| @electron/rebuild | 4.2.0 | Conditional native source rebuild against that runtime |
| node-pty | 1.1.0 | Native PTY; actual target-runtime smoke decides compatibility |
| sharp | 0.35.4 | Fix remaining dev libheif advisory |
| jsdom | 29.0.1 | DOM tests using the actual vendored browser libraries |
| typescript | 5.9.3 | Exact compiler |
| @types/node | 20.19.43 | Existing type dependency pinned |
| @types/qrcode | 1.5.5 | Existing type dependency pinned |
| iconv-lite | 0.7.3 | Existing production dependency pinned |
| qrcode | 1.5.4 | Existing production dependency pinned |

Node >=22.13.0 and npm >=10 are required. Bootstrap helpers enforce the Node minimum, fetch portable Node from the official source, and use `npm ci` without a silent `npm install` fallback. Only the dependency owner performed installation/lock updates.

`selfsigned` was tested with `require('selfsigned')` and awaited `generate()`. WebDAV's native `import('webdav')` was tested; a TypeScript CommonJS build should not downlevel it to a legacy `require` for older compatible Node runtimes. Do not simultaneously require and import the same not-yet-loaded ESM graph (observed a host Node 24.14.1 loader assertion in that artificial probe).

## Assets and commands

`npm run vendor:renderer` copies exact npm bytes plus licenses into the checked-in `src/renderer/vendor/` directory. `manifest.json` records source package, exact version and SHA256. `npm run vendor:check` verifies the files and rejects version drift. No network/CDN request occurs during rendering.

```powershell
npm ci
npm run vendor:check
npm test                         # pretest rebuilds assets + TypeScript; wildcard tests only
npm run electron:runtime         # official SHA256 verification and staging install
npm run electron:rebuild         # actual target PTY smoke; rebuild only if needed
npm run electron                # build + verified runtime + native gate + launch
node scripts/rebuild-native.cjs --force  # explicitly force a source rebuild
npm run dist                    # requires published desktop-agent helper
```

For slow networks, the downloader automatically tries one bounded ranged transfer after a failed full transfer; `node download_electron.js --install --ranged` selects that transport directly. Both transports trust only official release metadata and finish with the same SHA256 check. Ranges have concurrency, byte, timeout and retry limits. Redirects must remain HTTPS; malformed/missing/duplicate checksum entries, size/range mismatch, or checksum mismatch fail closed. Failed partial files are not promoted to the cache/runtime.

## Runtime/build design

`package.json.devDependencies.electron` is the sole version source, accessed through `scripts/electron-config.cjs`. Launch, setup and distribution paths use `node_modules/electron/dist/electron.exe`, not the old Electron 28 cache.

Official sources consulted on 2026-09-13:

```text
https://releases.electronjs.org/releases.json
https://registry.npmjs.org/electron
https://github.com/electron/electron/releases/download/v44.3.0/SHASUMS256.txt
```

Expected official SHA256 for `electron-v44.3.0-win32-x64.zip`:

```text
26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d
```

Installer extracts into a validated staging path, probes the executable's Electron version, and writes `.iexa-verified.json` with archive provenance and per-file hashes. Reuse checks both the official archive checksum and installed file hashes. The native helper executes a real PTY echo using the selected Electron executable; compatible Node-API prebuilds are accepted only after that probe, otherwise @electron/rebuild runs and the probe must pass. `--force` needs the Windows C++/Python build toolchain.

Distribution assembly preflights inputs before changing output, copies the complete runtime/locales plus preload/resources/renderer/desktop-agent, and uses lockfile paths to preserve nested/optional production dependencies while excluding dev-only packages. It rejects missing required or version-mismatched dependencies, repeats native and module-import checks in the packaged location, and emits a per-file build manifest. It never recursively deletes the release directory. Existing `release/IEXA` is renamed to `IEXA.previous-<timestamp>` only after staging passes; promotion failure restores it. These are reproducible input/layout guarantees, not a claim of byte-identical native compilers or installer timestamps.

## Evidence and verification

Local evidence root: `.iexa-artifacts/renderer-build/` (ignored, no real credentials).

- E1: `baseline-hashes.json` and `baseline/` preserve the original seven primary owned files.
- E2: `renderer-tests.log` exercises malicious HTML/URLs/SVG/mutation/clobbering, all stream prefixes and actual history functions, positive formatting, fragment pairing, CSP/data dispatch, checksum failure, nested packaging and bounded ranged transfer. Real Chrome fixture runs when installed; elsewhere set `IEXA_TEST_BROWSER` or it explicitly skips only that fixture.
- E3: `audit-before.json`, `audit-production.json`, `audit-all.json`: baseline production advisories addressed; final production and full audits report zero vulnerabilities. No blind audit force was used.
- E4: `electron-npm.json`, `electron-npm-times.json`, `electron-official.json` record exact-version verification against npm and Electron's official stable feed.
- E5: `clean-ci.log` records a separate clean lockfile installation (`npm ci --ignore-scripts`), successful with zero advisories. This proves lock resolution, not execution of package install hooks; runtime/native gates are separate.
- E6: `full-tests.log` records the rebuilt cross-agent suite. An earlier HTTP preview fixture 404 was reported to main and resolved in the subsequent run.
- E7: `electron-download-ranged.log`: official archive SHA256 verified and Electron 44.3.0 installed; `native-smoke.log`: actual target runtime reported Node 24.20.0 / module ABI 149 and `IEXA_NATIVE_ABI_OK`, exit 0. Compatible Node-API prebuild succeeded; no source rebuild was necessary.
- E8: `distribution.log`: `node build-dist.js` completed, including packaged native smoke and dependency imports, with 94 production packages. Output: `release/IEXA`, inventory: `release/IEXA/build-manifest.json`. Existing release output was preserved; no setup installer or GUI launch was executed by this slice (main owns GUI smoke).
- E9: latest final `npm test` run rebuilt first and passed 105/105 tests, zero skipped; this slice's dedicated renderer/build suite passed 10/10 including real Chrome. Counts may grow as sibling tests land. Both final audits remain zero. `runtime-bat.log` and `node-deps-bat.log` record the Windows setup helper checks.

## Rollback

Revert only this slice's tracked file changes and remove only this slice's new helper/vendor/test files; do not restore deleted tests or reset sibling changes. The seven primary original files are also available in E1 for targeted recovery. Run `npm ci` with the matching restored lockfile after a dependency rollback. To roll back a successful distribution, preserve the current `release/IEXA` under a new name and rename the chosen `IEXA.previous-<timestamp>` back to `IEXA`. Do not reuse an unverified Electron 28 cache as an implicit fallback.
