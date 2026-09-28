# Implementation notes — 2026-09-28

## Delivered scope

JASync 0.2.12 executes S3 synchronization: manual plan approval, file selection, uploads, downloads, conditional overwrites/deletes, common-base text merging, conflict copies, recovery backups, per-file history, progress and cancellation. The production coordinator is `src/sync/safe/runner.ts`; it does not call the retained upstream task executor. The RemoteStorage abstraction remains provider-independent.

Nutstore account services, SSO, WebDAV, delta/cache backend and hosted AI gateway are removed. The AI settings tab and ChatBox ribbon button remain hidden. The AI conflict-resolution header action is disabled by removing service registration and settings refresh hooks. Prefix is the single remote root setting; Path Style defaults to off.

The sync progress window keeps Stop sync visible but disabled and gray in terminal states. Successful completion gives Close a green background and white text; active sync restores the red Stop sync and neutral Hide controls.

## 0.2.12 — Disable the AI conflict action and clarify completion controls

The note header no longer registers the AI conflict-resolution service or refreshes it after settings changes. Sync completion keeps Stop sync visible, disabled and gray instead of relying on a hidden utility class. Close becomes green with white text only after successful completion. Returning to active sync restores enabled Stop sync and neutral Hide controls.

The existing native Obsidian check verifies the disabled button remains visible, the actual rendered Close colors, and restoration of active controls. Validation: 71 unit files / 903 tests, 19 native desktop Obsidian checks, ESLint, TypeScript, production build and five-file ZIP checks passed.

## 0.2.11 — Android HEAD response compatibility

The native transport marks only Android HEAD requests rejected before delivery of a response with the known `Request Failed. IOException Stream closed` message. Analysis of the official Obsidian 1.13.8 APK found an unconditional error-stream read before status/headers are returned. A null stream produces this exception for multiple HTTP error statuses; it must never imply 404 by itself.

Normal stat still uses HEAD. A marked failure triggers a newly signed GET on the same key with `Range: bytes=0-0`. Real 404 follows the existing directory/absence handling, while 401/403/412 and network errors propagate. A 206 requires a valid one-byte range, consistent response length, safe total size and complete metadata. Total object size comes from Content-Range. A 416 causes one further HEAD without recursive fallback; that result may describe a now-nonempty object. A server ignoring Range may return 200, which is accepted only with validated full-body length and metadata. Such a server can cause a full download.

The new observation preserves current ETag/VersionId and feeds existing sync-plan checks. The engine regression covers creation, modification and disappearance since preview and requires no user-file mutations. Write conditions and mutation retries are unchanged; existing bounded HTTP read retries still apply. Compatibility works with verbose logging off. Parent request ID, fallback reason and step appear in the fallback request/response context; no HTTP status is invented for the original HEAD.

The regression suite drives the actual native transport using a mocked Android requestUrl boundary. An additional Obsidian check evaluates the exact production browser bundle in an isolated realm and covers 404, 206, 416 and 403 through its production session factory. Seven real COS cases use the test environment and a simulated Android response-loss boundary, with cleanup verified. These checks do not constitute Android device acceptance.

Validation: 71 unit files / 903 tests, 19 native desktop Obsidian checks, 7 real COS cases, ESLint, TypeScript, production build and five-file ZIP equality checks passed.

## 0.2.10 — Opt-in verbose S3 request diagnostics

Troubleshoot adds a default-off Verbose log toggle persisted only in `data.local.json`. The production session passes a live predicate so subsequent requests on an existing session honor changes without changing the session identity. Every S3 API call can log its method, URL/object path, safe query parameters, signed header names and credential scope, redacted request/response headers, body byte counts, millisecond timestamps, timing, attempt and caller stack. Successes and ordinary HEAD requests are included.

The native transport observer identifies requestUrl invocation/resolution, response metadata access and arrayBuffer access. A failure after metadata preserves the observed status in diagnostics while remaining a network error; no synthetic 404, success or new fallback is introduced. A failure inside Obsidian before requestUrl resolves cannot expose its underlying Java/HTTP state. Existing deadlines, signing inputs, read retry policy and mutation protection are unchanged.

Credential values (including URL-encoded forms), actual request signatures, authorization/token/cookie headers and unknown header/query values are redacted. Successful response bodies, request bodies, raw error XML and signing material are omitted; only a bounded XML-decoded, redacted service Message is added. Fields and stack/cause depth are bounded. Exports retain the 2000-entry limit and add toggle state and diagnostics format version. Object filenames and bucket/prefix paths are deliberately visible in verbose mode.

Tests cover live toggling, request preservation, redaction, XML entity echoes, requestUrl rejection versus response body access failure, correlated read retries and observer isolation. The native production-bundle check operates the actual Troubleshoot toggle, reloads its saved local setting, exercises S3 diagnostics and exports a redacted note. Android device/network reproduction remains outstanding.

Validation: 70 unit-test files / 857 tests and 18 native Obsidian checks passed, including the actual toggle, persisted reload and exported log note. ESLint, TypeScript, production build and the five-file ZIP comparison passed.

## 0.2.9 — Avoid HEAD in deletion capability verification

The user's Android 0.2.8 log identified `delete/verify-deleted`: after the conditional DELETE returned success, native HEAD raised `Request Failed. IOException Stream closed` without delivering an HTTP response. Cleanup DELETE returned 204. This identifies the failed request, not the native implementation's root cause or an authorization failure.

The absence check now uses GET on the same small, private probe object (24-byte seed). Only an actual HTTP 404 proves absence. A retained or empty object does not pass; authentication/permission failures, unexpected statuses and native exceptions remain failures. Normal user-file stat still uses HEAD. Conditional mutations, approval, recovery, retries and cleanup are unchanged.

A regression injected the exact native exception for missing-object HEAD and failed against 0.2.8 before the fix. Additional cases cover GET 401/403/304, thrown native 404, and DELETE success receipts that leave nonempty or empty objects. The production-bundle Obsidian check covers successful probing under this simulated HEAD failure and export of a subsequent native GET failure. These simulations do not replace Android device confirmation.

Validation: 69 unit-test files / 850 tests and 18 native Obsidian checks passed. ESLint, TypeScript, production build and the exact five-file ZIP comparison passed.

## 0.2.8 — Exportable S3 diagnostics

Android deletion capability failures previously discarded the native exception and displayed only a generic network error. Request failures now include the HTTP method, capability/step and diagnostic ID. Probe start/response events record elapsed time, attempt, HTTP status, token-shaped service Code and request ID. Native failures record bounded, redacted name/message/code, separately labelled reportedStatus, timeout information and up to three causes. A native exception carrying 404/412 remains a failure; it cannot silently satisfy a probe or enable compatibility mode. Cleanup failures are logged without replacing the primary error. Mutation retries, confirmations and conditional protections are unchanged.

Diagnostic fields do not retain request headers, full URLs, bodies or raw exceptions. Configured credentials and their URL-encoded forms are redacted before truncation. Logs are bounded to the latest 2000 entries. Troubleshoot exports include platform, Obsidian API version and discarded-entry count, and explain exporting before restart. The production-bundle integration check injects a native HEAD failure after conditional deletion and exports the resulting redacted log note through the actual troubleshooting implementation. This is a diagnostic release, not a verified Android network fix.

Validation: 69 unit-test files / 844 tests and 18 native Obsidian checks passed, including production log-note export and browser execution without Node globals. ESLint, TypeScript, production build and the five-file ZIP comparison passed. Android device confirmation remains outstanding.

## 0.2.7 — Android module loading

Android / Obsidian 1.13.8 reported `Buffer is not defined` in `_seedDefaults` while enabling 0.2.6. The S3 implementation introduced `fast-xml-validator`, whose barrel import pulled in `detailed-xml-validator` and `@nodable/flexible-xml-parser`. The latter eagerly creates an encoding registry with global `Buffer.from()`. This dependency chain is absent from the Nutstore baseline. Node and Electron supplied Buffer, masking the regression in earlier tests.

The old production bundle reproduced the same stack in a separate JavaScript realm without Node globals. The fix removes that dependency chain and uses the existing fast-xml-parser XMLValidator, explicitly checking for a true result. DOCTYPE rejection, malformed-listing failures, complete pagination and all mutation protections remain. ESLint allows this specific deprecated symbol in the S3 adapter because the recommended replacement is the source of the mobile failure; future upgrades must retain browser compatibility and validation.

New unit coverage bundles the S3 implementation for a realm without Buffer/process/require, signs and parses a Unicode listing, and rejects a malformed later page. The native harness also evaluates the exact production main.js in an independent browser iframe without Node globals, supplying only Obsidian and CodeMirror host modules. This checks module evaluation, not the Android lifecycle or actual device/cloud synchronization. No global Buffer polyfill is installed.

Upgrading an existing jasync installation from 0.2.6 preserves its settings, cache and recovery; only plugin release files are replaced.

Validation: 67 unit-test files / 834 tests and 17 native Obsidian checks passed, including the independent browser evaluation of the final 0.2.7 bundle. ESLint, TypeScript, production build and ZIP content comparison passed. The archive contains exactly five release files matching dist, without credentials or sync state. Android device confirmation remains outstanding.

## 0.2.6 — Unified JASync identity

The plugin ID is `jasync`, package name is `obsidian-jasync`, and the installation directory is `.obsidian/plugins/jasync/`. Protocol links, CSS classes, view IDs, built-in skill paths, agent paths, temporary downloads and S3 probe objects now use the same identity.

Version 0.2.6 is installed fresh after removing the old plugin and its local settings, cache and recovery files. It creates a new vaultId and synchronization baseline. The new `JASync_Plugin_Cache` database does not import legacy caches. Notes and remote objects are not part of uninstall cleanup; the first sync must be reviewed with the new baseline.

The old plugin identifier remains only for hard exclusions: old private plugin data, temporary downloads and reserved probe objects must never become synchronized notes, even under user include rules. All new files, objects, settings and UI identifiers use JASync.

## 0.2.5 — Avoid repeated checks of unchanged files

A known equal pair now retains its existing baseline without further HEAD requests, local reads or history writes. The fast path requires matching content hashes, sizes and remote ETag; a supplied VersionId must also match. Missing VersionId in an S3 listing does not invalidate a recorded version. Planning still hashes local content and requires a complete listing. Later edits do not get marked synchronized: the old baseline remains unchanged and the next scan detects them.

Preflight covers only approved actions that change files. Equal pairs without a matching baseline still receive one fresh local content check and one remote stat before saving history. Both-sided deletion still verifies absence before clearing a record. These record-only actions do not need recovery backups or duplicate pre-write checks. Upload, download, overwrite, deletion and conflict execution retain their existing checks and backups. Capability probes remain per session for runs that need remote mutations.

An established unchanged vault now finishes directly after comparison, without empty Recheck / Verify phases. History progress counts only records needing refresh. A 20-file protocol regression verifies one listing, 20 local reads, zero per-file remote requests and zero history saves; a side-by-side run against the committed 0.2.4 engine confirms total S3 requests drop from 61 to 1 and local reads from 100 to 20, with no history writes in either case. Large listings still require all pages. This is a request-count reduction, not a claim about measured live-cloud latency; first sync and changed files still require network IO.

## 0.2.4 — Continuous sync progress

Previously the coordinator closed its scanning modal unconditionally after planning, then ran capability probes and sequential per-file preflight requests without a window. A no-change plan skipped the file review entirely, leaving a long invisible wait before the transfer UI reappeared. Content comparison and final history verification also lacked file-level progress.

The progress window now stays open through scanning, comparison, preflight, transfer and history verification. It closes only to hand off to an approval dialog, and resumes immediately after approval. Each counted phase shows completed/total files and the current path; unknown-length scanning and capability checks use a visible indeterminate bar. Preparation layouts are compact. Hide remains respected across phases, Stop remains available, automatic runs do not open a window, and old completion timers no longer overwrite active status. An unchanged plan does not announce a transfer phase.

This fixes feedback, not network latency: content hashing, remote reads when a baseline cannot be reused, and sequential validation remain in place. Mutation checks, plan approval, version checks and recovery guarantees are unchanged. Native regressions inspect the window during remote comparison, capability probes, validation and unchanged-file finalization, including Stop and Hide.

## 0.2.3 — JA sync icon

The sync ribbon and start-sync command use a theme-aware JA monogram surrounded by two sync arrows. While syncing, only the arrows rotate and the ribbon uses the theme accent; the letters remain upright. Reduced-motion preferences disable rotation. The stop control and sync behavior are unchanged.

## 0.2.2 — JASync product name

Display branding is now JASync: manifest, English/Chinese ribbon and command labels, notices, errors, log exports, MCP client name and built-in help. Internal plugin/settings/coordinator types and UI classes no longer use Nutstore branding. Source attribution remains in LICENSE/NOTICE and project documentation.

At this stage only display branding and internal symbols changed; persistent identifiers retained their previous values. Version 0.2.6 replaces the persistent identifiers with a fresh installation. Newly exported log notes use `jasync/logs/`.

## 0.2.1 — PUT HTTP 304 compatibility fix

A user reported `S3 PUT failed (HTTP 304)`. The 0.2.0 capability check handled 400/409/412/501 but aborted on 304, and compatibility execution still sent unverified condition headers. Protocol regressions reproduce both duplicate-create and initial-create 304 responses.

The fix treats 304 inside probes as unsupported, verifies positive and negative conditions with readback, and removes only unsupported headers after per-run consent. COS official endpoints use the documented native `x-cos-forbid-overwrite` creation header, without `If-None-Match`; detection still rejects support when that native header is ignored (for example with versioning). Actual file PUT 304 responses remain failures: no successful sync record and no unconditional retry. Probe failures now identify the capability being checked.

## Execution contract

- Manual sync always displays the selectable plan; **Confirm and sync** executes selected files. Close, Escape and Cancel decline execution. The optional earlier policy dialog does not replace plan approval.
- Full listings and SHA-256 content comparisons establish the plan. An incomplete scan is an error. Equal size alone is never proof of equality.
- Connection identity and file versions are checked again before execution. Every affected local/remote original is backed up and verified before destructive operations. Changed files, failed backups and permissions errors stop the remaining work.
- The sync history records transferred bytes and the actual upload receipt. Unchecked, skipped and failed operations are not marked synchronized. Already completed files remain complete if a later file fails or the user cancels; this is not a vault-wide transaction.
- Two Way propagates a deletion only if the surviving copy matches the common baseline; a changed surviving copy is preserved and restored. Send/Receive Only propagate source-side deletions of unchanged tracked files while protecting changes on the receiving side. Override/Revert policies mirror the selected source and may delete untracked destination files.
- Conflict-free three-way merging requires a verified small UTF-8 common version. Otherwise the local version is saved to a `.conflict-<UUID>` filename and both versions are present on both sides. Priority strategies back up before overwriting.
- No recursive deletions or independent empty-folder synchronization. Ten or more selected deletions require an additional manual confirmation.

## Service compatibility

After plan approval, random `.jasync-internal/probes/<UUID>` objects test whether the service enforces create/overwrite/delete preconditions. These objects are excluded from synchronization and cleanup is attempted. A cleanup failure may leave a small reserved probe object; no user object is used for testing.

If a required condition is ignored or unsupported, manual execution requires a second **per-run** compatibility confirmation. It explains that recovery backups and last-moment version checks cannot prevent a different client from changing an object between the check and the write/delete. Other syncing clients should be paused. Automatic sync never enables this fallback. Permission failures are not treated as unsupported capabilities.

The capability probe and compatibility path support provider differences without claiming all S3-compatible services behave like AWS. The tests below use a protocol fixture, not credentials for AWS, COS, R2 or MinIO.

## Recovery

Recovery is local to the vault under `.obsidian/plugins/jasync/recovery/<run UUID>/` (or the configured Obsidian config directory):

- `local/<original path>` contains the local pre-operation bytes.
- `remote/<original path>` contains the remote pre-operation bytes.
- `journal/<path hash>.json` describes the path, proposed action, versions, target identity and pending/complete status.

To recover, disable automatic sync, inspect the journal and both versions, then copy the desired content into the vault using its original relative path. Run a new manual plan and review it before updating S3. Copies remain until manually removed; there is no automatic expiry or restore UI in this release. Backups are ordinary unencrypted vault files and should be protected with the vault.

History is stored at `cache/sync-v2-<identity hash>.json`, isolated by vault ID, endpoint, region, bucket, prefix, account ID and addressing mode. No Nutstore history is imported. Corrupt history stops sync and is preserved. An upload with a lost response or failed record save is not blindly retried: retain the recovery journal, inspect both sides and generate a new plan. Never clear history merely to suppress an error, since doing so removes deletion/merge baselines.

Own credentials, settings, cache, recovery, temporary downloads and reserved probes are hard-excluded from syncing, even with user include rules.

## Validation

Development: macOS arm64, Node 24.20.0, pnpm 9.15.9, Obsidian 1.13.7.

- Unit tests cover complete pagination, later-page errors, path/Unicode collisions, prefix isolation, binary/empty/range reads, version changes between chunks, mutation signing/receipts, ignored conditions, no retry on lost write responses, upload/download/delete, all five policies, common-base merges, same-size conflicts, selected operations, backup/save failures, corrupt history, staged-write failures and concurrent local edits.
- `pnpm run build` includes zero-warning ESLint, TypeScript, esbuild, SWC and packaging into `dist/`.
- `pnpm run test:obsidian -- --native` uses a separate macOS Obsidian profile and temporary synthetic vault. It loads the built production bundle, renders settings/progress, reloads the plugin and exercises real modal selection, cancellation, transfer, overwrite, tracked deletion, target changes, compatibility confirmation/decline and automatic-mode refusal.
- Final verification: 66 unit-test files / 829 tests passed; 16 native Obsidian checks passed. ESLint, TypeScript, production packaging and `git diff --check` passed.

The existing Linux sandbox harness is retained. Earlier Linux runs were blocked before plugin startup by official AppImage/Ubuntu package downloads. The macOS harness avoids those bootstrap dependencies. No personal notes or real cloud objects are used by the integration tests.

## Baseline and limits

- Nutstore upstream baseline: `79d35b4e8b47ac43d3531ceb888a722ee942dc5e`. Isolated baseline unit suite: 57 files / 800 tests. The 76 tests for removed Nutstore endpoints are no longer applicable.
- The upstream model catalog remains its original Git LFS object (`78b42af966d9493385832624db7abf00344899a696fbfe0bad86854a43734256`). Dependencies come from public npm, without `@nutstore/sso-js`.
- Native HTTP uses 30-second read/delete deadlines and a 120-second upload deadline. Obsidian does not provide an abort handle: cancellation stops later work but cannot revoke a request already sent. Mutations are never automatically retried.
- Files are buffered in memory. The default size limit is 30 MB; multipart upload, streaming, resumable transfers and historical-version browsing are not implemented.
- `Vault.process` guards visible small UTF-8 text edits. Binary/hidden/large-text writes use a verified staged copy and final check, but adapter APIs cannot guarantee a cross-platform compare-and-swap against simultaneous external edits. Recovery copies do not eliminate that race.
- Automatic triggers default off, and upgrading from 0.1.0 disables previously dormant triggers. Conflicts, protected deletion, batches of at least 10 deletions and unsupported conditions require manual review.
- Cloud-provider and mobile acceptance still require separate live tests. These limits are separate from the now-working manual execution flow.
