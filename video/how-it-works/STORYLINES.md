# How drivebucket works: three storylines

The one idea: **your app talks S3, drivebucket turns that into Google Drive files, and a CDN
keeps reads cheap.** Every claim below comes from the repo (README, docs/, packages/). Example
values (a photo's size, the key) are marked illustrative in the film.

Length 45–60 s · 1920×1080 · 30 fps · music + sound effects, no voiceover · no paid items.

---

## A. One photo's round trip (recommended)

**Device:** a worked example: one real object travels through every part. **Form:** an
object-to-object chain. Each stop ends on the thing that opens the next one.

One phone photo (`cat.jpg`, 4000 px, illustrative) leaves a web form. It's shrunk in the browser,
streamed through the upload route, filed in a Drive folder with its key written on the back,
and then requested by a visitor, fetched once from Drive and served from the CDN after that.
The viewer follows one thing and ends knowing every package's job.

- **First 2 s:** a phone-sized upload form, a photo thumbnail dropping into it, and the
  progress bar starting. Above it in big type: "Where does this photo go?"
- **Beats:** form drop → browser resize (4000 px → 2048 px WebP) → stream to `createDriveRoute`
  (no base64) → Drive: bucket = folder, file tagged with `b` / `kh` / `k0`, MD5 checked → key
  saved in the database → visitor requests `?w=640` → first hit: Drive download (200 quota
  units) → second hit: CDN, 0 units → the S3 door: same files via `endpoint` → limits line →
  repo name.
- **Look:** a light Drive-folder world. White sheets, real folder and file shapes, monospace
  keys printed on file tabs, and one accent colour for the photo's path. No dark void.
- **Sound:** a light pulsing bed. A soft click on each handoff, a paper slide when the file
  lands in its folder, and a cache-chime on the CDN hit.

## B. Change one line

**Device:** a question with the input in it. **Form:** split screen collapsing to one.

A code editor shows `new S3Client({ endpoint: 's3.amazonaws.com' })`. The cursor changes the
endpoint to `files.example.com`, and the app on the right keeps working. Then the camera dives
behind the endpoint: SigV4 check, resumable upload session, Drive folder. For developers who
already use S3.

- **First 2 s:** the editor line with `endpoint:` highlighted and the caret blinking after
  `s3.amazonaws.com`.
- **Beats:** old endpoint → edit → PutObject returns an ETag → dive: signature verified (15-min
  skew) → body verified before commit → resumable chunks (256 KiB-aligned) → Drive file →
  GetObject / presigned URL → "what's different" checklist (path-style, no versioning) → repo
  name.
- **Look:** an editor-and-terminal world in a real syntax theme, opening up into a technical
  cutaway of the server. Monospace-led.
- **Sound:** keyboard taps, a terminal blip per request, and a low synth pulse under the dive.

## C. The sorting office (bold)

**Device:** the object is the explanation. **Form:** a flight through one world.

drivebucket drawn as one isometric mail-sorting machine. Uploads arrive as envelopes. A label
press writes the key in 120-byte strips. A card catalogue (the key index) remembers where each
envelope went. Drawers labelled as buckets, each capped at 500,000. A quota meter needle climbs
towards 325,000 units a minute, and a reservoir (the CDN) in front keeps the needle low. The
camera flies across the machine, stopping at each part as it's named.

- **First 2 s:** an envelope dropping into the machine's intake chute, with gears starting
  to turn.
- **Beats:** intake → label press (keys chunked to Drive's 124-byte limit) → card catalogue
  (memory / Redis / Mongo) → drawers = buckets → outbound: request → meter needle jumps 200 →
  reservoir fills → needle stays down → the limits wall (750 GB/day, 500k per bucket) → repo
  name.
- **Look:** a flat isometric illustration in warm paper tones, with one signal colour on the
  envelope.
- **Sound:** mechanical clacks, stamps and a drawer slam, over a light rhythmic bed.
