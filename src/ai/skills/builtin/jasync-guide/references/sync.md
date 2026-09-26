# Synchronization Guide

JASync supports S3 synchronization with plan confirmation and recovery copies.

Configure endpoint, region, bucket, prefix and credentials in S3 settings.
Credentials stay in device-local data.local.json, excluded from synchronization.
The file is not encrypted. Never read or expose it in chat.

Start JASync scans the configured prefix and compares content and history.
The user selects files and clicks Confirm and sync to execute. Closing or
cancelling the plan does not execute operations. Only completed operations
update history. A later cancellation or failure does not roll back earlier
completed files. Prefix is the remote root; Path Style defaults to off.

## Sync policies and conflicts

Two Way, Send Only, Send Only Override Changes, Receive Only and Receive Only
Revert Local Changes support uploads, downloads and tracked deletions. Normal
single-direction policies protect independent destination changes; mirror
policies may delete destination-only files. Review the per-run file plan.

Default and Diff3 strategies merge only with a verified common text version.
Overlapping conflicts or no baseline preserve both versions with a conflict
copy. Local/server priority overwrites the other side after a recovery backup.

## Safety and recovery

Changed plans, failed scans/backups and permissions errors stop execution.
Content is backed up to .obsidian/plugins/jasync/recovery/<run>/local/ and
remote/, with per-file journals. Disable automatic sync before restoring a
chosen backup to its original vault path, then review a new manual plan.
Recovery copies do not expire automatically and there is no restore UI.

Services that do not enforce conditional writes require explicit per-run
compatibility confirmation. Backups and version checks still leave a race
with other clients between check and write; pause other syncing clients.
Automatic sync never uses that fallback. Automatic triggers default off and
also defer conflicts, protected deletion and batches of at least 10 deletions.

For HTTP 403, check list/read/write/delete permissions, endpoint, region and
bucket. HTTP 404 for a bucket is an error; an empty prefix is valid. Do not ask
for access keys, secret keys, session tokens, or authorization headers.
Files are buffered in memory (default skip threshold 30 MB); multipart upload
and resumable transfers are not available. Cloud-provider and mobile behavior
needs live verification; do not claim that protocol mocks establish it.
