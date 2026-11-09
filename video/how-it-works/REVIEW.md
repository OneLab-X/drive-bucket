# Review: How drivebucket works (storyline A)

## Creative calls
- Built **A, "One photo's round trip"**: one illustrative photo travels form → browser resize →
  `createDriveRoute` → Drive folder (appProperties on the file) → database key → read path
  (Drive once, CDN after) → the S3 door → end card. Not built: **B "Change one line"** (editor
  dive for S3 users), **C "The sorting office"** (isometric machine). Both are in STORYLINES.md.
- Light "desk of real objects" world on #E9EEF3. Outfit 700 titles in the left column, IBM Plex
  Mono for keys and code, and one accent for the photo's path.
- The accent moved from #FF5B2E to **#E0441A**, because the original failed contrast on the
  ground (2.65:1). It's now 3.59:1 on the ground and 4.19:1 on white.
- Example values (4000 px / 4.1 MB → 2048 px / WebP / 380 KB, "Oak chair", user `u_42`, hash
  `9f3c…`) are illustrative and marked "sizes illustrative" / "illustrative" on screen. Facts that
  come from the repo: `uploadFile(... resize: { maxEdge })`, `createDriveRoute`, multipart/form-data
  streaming, type sniffing, appProperties keys `drivebucket`/`b`/`kh`/`k0`, the MD5 check, 200 quota
  units per uncached download, `endpoint` + `forcePathStyle`, and 750 GB/day.

## Measured vs looked at
- `hyperframes check`: ok, no errors. Seams 1, 3 and 6 checked frame by frame; the beat sheet and
  phone sheet were reviewed.
- Fixed after review: a stray photo on the S6 folder (P0, a fromTo applying its start state at
  frame 0), the S4→S5 card losing its rows at the cut, "+200 quota units" past the action-safe
  edge, and an empty frame at the S6→S7 cut.
- **Sound:** 19 placements of 8 bundled effects, each timed to its measured peak (+1 frame). There
  is **no music bed**: no music source on this machine (no HeyGen sign-in, no local model). The
  sound was measured, not heard.

## Warnings kept on purpose
- `text_below_floor` on the small file card while it sits inside the folder (S4, about 18–20 s):
  it's an object there, not text to read. The same card is shown full size afterwards.
- `line_unread` on the md5 row at the start of S5: it continues from S4, where it was held 2 s.
- `line_unread` on the old/new `endpoint` values (S7): the checker misreads the clip-path typing.
  Snapshots at 43.2 s and 46.5 s show each value fully visible for 1.6 s and 2.6 s.

## Weakest shot / with more time
- **S3 (stream):** the strips enter the route box and the folder appears, but the moment of
  "never buffered" is told mostly by the title. Showing the box's intake and outlet working at
  the same time would make it visible.
- At phone width the monospace labels are too small. The README audience is mostly desktop, so
  they were kept.
- Add a music bed once a source is available (HeyGen catalog, or the person's own track).
