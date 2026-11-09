# @drivebucket/cli

```bash
npm i -g @drivebucket/cli    # provides `drivebucket`
```

## Get a refresh token

1. In Google Cloud Console: enable the **Google Drive API** and create an **OAuth client ID** of
   type **Desktop app**.
2. On the OAuth consent screen, **publish** the app. While it's in *Testing*, Google expires refresh
   tokens after **7 days**. The default `drive.file` scope is non-sensitive and doesn't need
   Google's verification review.
3. Run:

```bash
drivebucket auth login --client-id ID.apps.googleusercontent.com --client-secret SECRET > .env
```

This opens the browser, runs the loopback flow with PKCE, and writes `DRIVEBUCKET_CLIENT_ID`,
`DRIVEBUCKET_CLIENT_SECRET` and `DRIVEBUCKET_REFRESH_TOKEN` to stdout. Status messages go to
stderr, so redirecting stdout gives you a clean `.env`. Use `--scope drive` for full Drive access
(restricted scope), and `--no-open` on a headless box (open the printed URL on any machine that
can reach the loopback port, e.g. over SSH port forwarding).

## Commands

```bash
drivebucket --env-file .env doctor --write-test photos   # credentials, scopes, quota, shared drive, round trip
drivebucket buckets create photos
drivebucket buckets ls
drivebucket cp ./cat.jpg db://photos/2026/              # upload (type guessed from extension)
drivebucket cp -r ./album db://photos/albums/summer      # upload a directory
cat dump.sql | drivebucket cp - db://backups/dump.sql   # from stdin
drivebucket cp db://photos/2026/cat.jpg .                # download
drivebucket cp db://photos/a.jpg db://archive/           # server-side copy
drivebucket ls db://photos/2026/                         # one level; -r for everything; --json
drivebucket rm db://photos/2026/cat.jpg                  # to Drive trash; --permanent to hard-delete
drivebucket rm -r db://photos/tmp/                       # everything under a prefix
```

`doctor` exits 1 when a check fails, and explains the usual problems: a revoked or expired token
(including the 7-day Testing-mode expiry), the Drive API not being enabled, the wrong scope, a shared
drive the account isn't a member of, and storage that's nearly full.
