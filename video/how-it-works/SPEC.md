# SPEC: How drivebucket works (storyline A, "One photo's round trip")

GOAL:    a developer finishes knowing where an uploaded photo goes, what drivebucket writes into
         Google Drive, why the database keeps a key, and why a CDN makes reads cheap, and that
         S3 code can switch by changing `endpoint`.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, MP4 (H.264) + a GIF preview for the README.
TIME:    54 s x 30 = 1620 frames. No music source on this machine (no HeyGen, no local model):
         bundled sound effects only, no bed. Cuts follow motion.

LOOK:    the world is a desk of real objects: a browser window, a printed photo, a Drive folder,
         a file card, a database table, a phone. Flat, light, physical; no screens floating in a void.
         ground  #E9EEF3 flat (no gradient, no grain)
         ink     #0E1B2A (all read text, structural lines 3 px)
         muted   #5B6B7C (secondary labels)
         paper   #FFFFFF (cards, window, file), shadow 0 14px 0 rgba(14,27,42,0.10) (a hard
                 offset shadow, like a card lifted 14 px off the desk), radius 18 px
         folder  #F2B84B body, #D99A2B tab and back, 3 px #0E1B2A outline
         accent  #E0441A (3.59:1 on the ground, 4.19:1 on white; #FF5B2E failed at 2.65:1): ONLY the photo's path (the travelling line, the key text in flight, the
                 highlighted code token, one word per title). Never on backgrounds.
         ok      #1E9E62: only the two checkmarks (type sniffed, MD5 match)
         display Outfit 700, titles 80 px (7.4% H), tracking -1.5%, line-height 1.05
         labels  IBM Plex Mono 500, 30 px; small tags 24 px (above the 28 px floor only for
                 non-essential "illustrative" tags, which are allowed to be skimmed)
         body    Outfit 500, 36 px
         Titles sit in a left column, x = 120 px, top 110 px, max width 640 px. Never centred.

OBJECTS: photo    a printed photo: white 18 px border, sky #9ED4F5, sun #FFC94A, two hills
                  #4FA36B / #2F7D4F, filename tag below "IMG_4021.jpg" (illustrative)
         browser  white window, 54 px chrome bar with three dots and an address pill
                  "yourapp.com/listings/new", a form: Title "Oak chair", Price "120", a dashed
                  drop zone, an Upload progress bar
         route    a white machine box labelled `createDriveRoute`, sublabel `@drivebucket/next`,
                  an intake slot on the left, an outlet on the right
         folder   a Drive folder (tab + body) labelled "photos"; a file card can sit in it
         file     white card with a photo thumb on the front; on its back a table of
                  appProperties: drivebucket=object, b=photos, kh=9f3c…e1, k0=users/u_42/9f3c….webp
         db       a table with header row (id · title · price · image_key) and one row
         phone    a phone outline 300 x 600 px with a 16 px bezel and an address bar
         cdn      a box labelled "CDN cache" with a small stack of copies inside
         server   a box labelled "drivebucket-server", sublabel "resize ?w=640"
         code     a white code card, IBM Plex Mono 34 px, `endpoint` value in accent

MOTION:  enter   expo.out 0.6 s (18 f); titles per word: blur 6 px -> 0 + opacity 0 -> 1 in
                 0.13 s, 0.07 s apart, no translate
         move    power2.inOut 0.8 s (24 f) for objects travelling across the desk
         camera  power2.inOut 0.9 s on a stage wrapper (scale / x / y)
         exit    power3.in 0.3 s; titles blur out 0.18 s
         travel  the accent path draws with linear stroke-dashoffset at constant speed
         springs none (no bounce on UI). One hero move per shot; secondaries start 0.15 s later
                 and travel 50-70 %.

SHOTS:
  1  0.0-5.0   Hook. Browser window right (x 760-1800). Title left "Where does this photo go?"
               already on screen at frame 0. Photo drops into the drop zone (0.7 s, settles from
               6 deg to 0), zone border turns accent, progress fills 0 -> 100 % (1.4 s).
               SFX pop on landing, click-soft as progress completes.
               Hand-off: camera pushes into the photo (power3.in 0.45 s).
  2  5.0-10.5  Resize. The photo fills the left (640 px tall) with tag "4000 x 3000 · 4.1 MB".
               Title right "Shrunk in the browser first", code line
               `uploadFile(file, { resize: { maxEdge: 2048 } })`. At 1.6 s the photo scales to
               0.62 and the tag rolls to "2048 x 1536 · WebP · 380 KB" (both illustrative).
               SFX whoosh-short on the scale. Hand-off: the photo slices into 6 strips.
  3  10.5-17.0 Stream. Strips travel along an accent track into the route box (left to right,
               constant speed), label on the track "multipart/form-data". A check stamps on the
               box: "bytes say image/webp ✓". Title "Streamed through, never buffered".
               Strips leave the outlet and fall into a folder corner at bottom right.
               SFX whoosh on the travel, pop on the stamp. Hand-off: push into the folder.
  4  17.0-26.0 Drive. Big folder "photos", tag "bucket = a Drive folder" (title 1, 0.4-4.2 s).
               The file card drops in, camera pushes onto it, the card flips (rotateY 180,
               0.8 s) to show its appProperties table; title 2 "Its key is written on the file"
               (4.6-8.6 s); a row "md5 ✓ matches what was sent". SFX whoosh-short on the flip,
               pop on the md5 row. Hand-off: the k0 value lifts off in accent.
  5  26.0-31.0 Database. The key flies into the image_key cell of the listings table.
               Title "Your database keeps the key, not a URL". SFX key-press x2 as it lands.
               Hand-off: the key types itself into a phone address bar.
  6  31.0-42.0 Read. Phone left, CDN, server, folder right on one line. Request 1 draws an accent
               line all the way to the folder; the folder shows "+200 quota units"; the photo
               returns at 640 px, the CDN gets a copy. Title 1 "First view: one Drive download".
               Request 2 stops at the CDN, folder shows "+0". Title 2 "After that: served from
               the CDN". SFX whoosh-short per request, ping on "+200", pop on "+0".
  7  42.0-48.0 S3. Code card; the endpoint value types from 's3.amazonaws.com' to
               'https://files.example.com' (accent). Title "Already on S3? Change the endpoint".
               Small line "SigV4 · presigned URLs · multipart". SFX typing.
  8  48.0-54.0 End. "Google Drive as your object store" (accent on "object store"), under it
               "github.com/OneLab-X/drive-bucket" and `npm i @drivebucket/core`, then the honest
               line "750 GB/day upload limit · put a CDN in front". The name "drivebucket" types in.
               Holds 3 s. SFX impact-bass-1 on the name.

BANNED:  dark or navy void; glow, bloom, particles; purple/blue gradients; glass cards; cream paper
         with serif + italic accents + numbered labels + mono caps chips; centred everything;
         every element fading and sliding up; titles moving after they land; corner brackets,
         HUD readouts, frame borders; three cards in a row; a docked logo; icons in circles;
         bullet slides; chimes and dings.

QA:      t=0.0 thumbnail shows window + title; 3.0 photo in the zone, progress mid; 7.0 big photo
         + tag; 9.0 resized tag; 13.5 strips on the track + label; 15.5 stamp ✓; 19.0 folder +
         bucket line; 23.5 flipped card table legible; 28.5 key in the db row; 34.5 request 1 with
         +200; 39.5 request 2 stopped at CDN, +0; 45.5 endpoint typed; 52.5 end card complete.
