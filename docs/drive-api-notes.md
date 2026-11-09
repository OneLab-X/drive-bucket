# Drive API v3 notes and spec drift

Read against the live Drive v3 docs on 2026-11-09 (files.create/update/get/list,
manage-uploads, manage-downloads, properties, limits, handle-errors, search terms,
auth scopes, shared drives). This file records what the docs say and where the original
drivebucket spec had to change.

## Spec drift (decisions taken in M1)

| # | Spec said | Docs say | What drivebucket does |
|---|-----------|----------|-----------------------|
| 1 | Store full key in `appProperties.key` | 124 bytes UTF-8 **per property, key + value combined**; max 30 private props per app per file | Keys may be up to 1024 bytes, so the key is stored as chunks `k0..kN` (≤ 120 bytes each) and looked up via `kh` = SHA-256(bucket, key) base64url (43 chars). `b` holds the bucket name. |
| 2 | Simple upload < 5 MB | `uploadType=media` carries no metadata | Small objects use `uploadType=multipart` (metadata + media in one request, ≤ 5 MB). Larger ones use resumable. |
| 3 | Flat folder per bucket | 500,000 items per folder (`numChildrenInNonRootLimitExceeded`); shared drive cap is also 500,000 items and **trashed items count** | Flat bucket kept; README limit table says ~500k objects per bucket, and trash-by-default eats into a shared-drive cap. `permanentDelete` recommended for shared drives with churn. |
| 4 | Prefix listing "by appProperties query" | `appProperties has` supports exact key/value match only; no prefix/contains; `orderBy` can't sort on properties | ListObjects scans the bucket folder (pageSize 1000, 100 quota units/page), filters and sorts client-side. Cost grows with bucket size. Documented as a limit. |
| 5 | DailyUploadLimit (750 GB/day) error | Limit documented, but **no named error reason** for it | Detected heuristically (reason `uploadLimitExceeded` or message mentioning upload limit / 750 GB). Not retried. |
| 6 | Respect `Retry-After` | Not mentioned in Drive docs; recommends `min(2^n s + rand(0..1000ms), 32–64s)` | Honour `Retry-After` when present, otherwise doc formula, capped at 32 s, max 6 attempts. |
| 7 | `drive.file` scope default + configurable root folder | `drive.file` only covers files the app created/opened (or picked via Picker) | Under `drive.file`, a user-created root folder is invisible. Default root is a folder the app creates itself (`drivebucket`, tagged `appProperties.drivebucket=root`). A pre-existing `rootFolderId` needs the `drive` scope or a Picker grant. |
| 8 | Quota "per user per minute" | As of **May 1 2026** quota is in units: 1,000,000/min/project, 325,000/min/user/project, 400M units/day/project. list=100, create/update/delete/copy=50, alt=media download=200, metadata get=5. Overage billing announced for "later in 2026". | Metrics/doctor report units, not request counts. README should warn that the read proxy costs 200 units per uncached download → CDN caching is mandatory. |
| 9 | Overwrite keeps stable id | `files.update` with media keeps id | Done. `copy` onto an existing key creates a new id (Drive `files.copy`) and trashes the old target. |
| 10 | `googleapis` package | Same generated client ships as `@googleapis/drive` | Use `@googleapis/drive` (much smaller install). Its `auth` export supplies OAuth2/JWT so there's one `google-auth-library` copy. |

## Facts used by the implementation

- Upload: multipart ≤ 5 MB; resumable session URI lives one week; chunks must be multiples
  of 256 KiB except last; `308` = incomplete, `Range: bytes=0-N` says what was received
  (absent = nothing); status query = empty `PUT` with `Content-Range: bytes */TOTAL`
  (`*/*` if unknown); `404` on session → restart; other `4xx` → restart; `5xx` → query and resume.
  Max file 5,120 GB.
- `md5Checksum`, `sha1Checksum`, `sha256Checksum`, `headRevisionId`: binary files only.
- `files.get?alt=media` supports `Range: bytes=a-b`. `acknowledgeAbuse` only for owner/organizer.
- `supportsAllDrives`, `includeItemsFromAllDrives`, `driveId` current; `corpora` ∈
  `user|domain|drive|allDrives`, prefer `user`/`drive`. `supportsTeamDrives`,
  `includeTeamDriveItems`, `teamDriveId`, `corpus` deprecated.
- `files.list` pageSize max 1000; `nextPageToken` valid "several hours"; returns trashed
  files unless `trashed=false`.
- Service accounts have no storage quota and can't own files → must write into a shared
  drive, or impersonate a user via domain-wide delegation.
- Errors: 429/403 `rateLimitExceeded`, 403 `userRateLimitExceeded`, 403
  `storageQuotaExceeded`, 403 `dailyLimitExceeded`, 403 `activeItemCreationLimitExceeded`
  (500M items/user), 403 `teamDriveFileLimitExceeded`, 404 `notFound`, 401 auth.

## Not verified yet (needs the integration suite)

- Exact error body when the 750 GB/day limit trips.
- Whether `files.list` under `drive.file` reliably returns every app-created file
  immediately after create (list is eventually consistent; the key index papers over this).
