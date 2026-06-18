# Private Media Pipeline Guide

This document defines the recommended private media upload, processing, storage, and room playback architecture for SWaParty.

## Goals

- Keep the first implementation affordable and simple.
- Let users upload videos without understanding codecs, bitrate, or transcoding.
- Keep video bytes out of the WebSocket server.
- Support a future upgrade path from direct MP4 playback to HLS multi-rendition playback.
- Control cost with per-user quotas and bounded worker concurrency.

## Recommended Architecture

Use this architecture for the first production-ready media pipeline:

```text
Browser
  -> R2 original upload
  -> D1 metadata
  -> DO VPS transcode worker
  -> R2 HLS renditions
  -> Browser playback from R2
  -> WebSocket only for room state sync
```

Primary services:

```text
Cloudflare R2:
  Original video files, generated HLS files, thumbnails.

Cloudflare D1:
  Media metadata, quotas, upload state, transcode jobs.

DigitalOcean VPS:
  ffmpeg worker, optional lightweight link parser, optional WebSocket server in early stage.

WebSocket server:
  Play/pause/seek/current-time/member-state sync only. It must not proxy video bytes.
```

## MVP Path

The cheapest and fastest first version can avoid transcoding:

```text
Upload -> R2 original MP4/WebM/MOV
Detect if browser can play
If playable -> allow room playback from R2
If not playable -> keep in media library but disable room playback
```

Still reserve these fields from day one:

```text
transcode_status
hls_master_key
renditions
processing_mode
```

This keeps the later HLS upgrade from requiring a schema rewrite.

## Full Upload And Processing Flow

1. User selects one video.
2. Frontend reads local metadata where possible:
   - width
   - height
   - duration
   - file size
3. Show a processing choice dialog.
4. Backend validates:
   - authenticated user
   - per-user quota
   - active upload/processing lock
   - single-video size and duration limits
5. Backend creates a media item with `status = uploading`.
6. Frontend uploads original file directly to R2.
7. Frontend confirms upload completion to backend.
8. Backend creates processing jobs.
9. VPS worker processes jobs with ffmpeg.
10. Worker uploads generated files to R2.
11. Backend marks renditions ready.
12. Room playback uses HLS if ready, otherwise fallback MP4 only if playable.

## User-Facing Processing Choices

Do not expose technical words like codec, bitrate, GOP, or HLS in the main upload flow.

Use user-facing options:

```text
Fast Playable
  Generate a basic playable version first. This is faster and uses less storage.

Full Quality Processing
  Generate more quality options. This takes longer and uses more storage.
```

Required upload dialog copy:

```text
The highest generated quality will not exceed the original video quality.
```

Better user-facing phrasing:

```text
Highest quality is limited by the original video.
Low-quality videos will not become truly HD after processing.
```

Internal mapping:

```text
fast_playable:
  probe
  thumbnail
  base_480p or nearest safe playable base

full_quality:
  probe
  thumbnail
  base_480p
  enhance_720p if source >= 720p
  enhance_1080p if source >= 1080p
```

For 4K sources, cap generated playback renditions at 1080p unless there is a paid tier or explicit reason to store 4K renditions.

## Resolution Policy

Generated renditions must not exceed source quality.

```text
max_output_height = min(source_height, 1080)
```

Examples:

```text
Source 512p:
  480p, optional source-capped original rendition.

Source 720p:
  480p, 720p.

Source 1080p:
  480p, 720p, 1080p.

Source 4K:
  480p, 720p, 1080p.
```

Do not upscale 720p to 1080p. It increases storage and bandwidth without adding real detail.

## Storage Layout

Use deterministic R2 keys:

```text
users/{userId}/media/{mediaId}/original/{filename}
users/{userId}/media/{mediaId}/thumb/thumb.jpg
users/{userId}/media/{mediaId}/hls/master.m3u8
users/{userId}/media/{mediaId}/hls/480p/index.m3u8
users/{userId}/media/{mediaId}/hls/480p/seg_00001.ts
users/{userId}/media/{mediaId}/hls/720p/index.m3u8
users/{userId}/media/{mediaId}/hls/720p/seg_00001.ts
users/{userId}/media/{mediaId}/hls/1080p/index.m3u8
users/{userId}/media/{mediaId}/hls/1080p/seg_00001.ts
```

Generated HLS files should be stored. Do not re-transcode on every playback.

Optional cleanup policy:

```text
Keep original files.
Keep HLS for recently played videos.
Delete cold HLS renditions after 30-90 days of no playback.
Regenerate HLS on next demand.
```

## Cost Ownership

```text
Original video storage:
  R2

Generated HLS storage:
  R2

Thumbnail storage:
  R2

Metadata:
  D1

Transcode compute:
  DigitalOcean VPS

Transcode temporary disk:
  DigitalOcean VPS

Worker downloading original from R2:
  R2 read request + VPS inbound traffic

Worker uploading HLS to R2:
  R2 write request + VPS outbound transfer

User playback:
  Browser reads R2 HLS/MP4 directly
  This must not go through VPS

WebSocket:
  Room state messages only
```

## Quotas

Use both storage and duration quotas.

Reason:

```text
Storage limit controls R2 cost.
Duration limit controls transcode and playback cost.
```

Example free-tier policy:

```text
Total storage: 2 GB
Total duration: 120 minutes
Single video size: 500 MB
Single video duration: 30 minutes
Concurrent upload/processing per user: 1
```

Store quota usage as:

```text
used_storage_bytes = original_size_bytes + hls_size_bytes + thumbnail_size_bytes
used_duration_sec = sum(duration_sec)
```

Same-user restriction:

```text
One user can have only one active upload or processing job.
```

Different users:

```text
Multiple users can upload at the same time.
All transcode work enters the shared worker queue.
```

## Upload Concurrency

Separate upload concurrency from transcode concurrency.

Upload:

```text
Browser -> R2
```

This does not use VPS CPU and should allow multiple users concurrently.

Recommended rules:

```text
Per user: 1 active upload or processing task.
Global active upload grants: configurable N.
If global active upload slots are full, place upload in waiting state.
```

Upload states:

```text
waiting
uploading
uploaded
failed
cancelled
```

## Transcode Queue Design

Use non-preemptive multi-level scheduling. Do not interrupt an ffmpeg process once it starts.

Reason:

```text
Killing ffmpeg mid-job wastes work and complicates cleanup.
HLS playback segments are output format chunks, not scheduler time slices.
```

Instead of transcoding one full video completely before moving to the next, split each media item into sub-jobs:

```text
probe
thumbnail
base_480p
enhance_720p
enhance_1080p
```

Queue levels:

```text
Q0:
  probe, thumbnail

Q1:
  base playable rendition, usually 480p

Q2:
  720p enhancement

Q3:
  1080p enhancement, retry, long/heavy jobs
```

Primary goal:

```text
Make more users' videos playable first.
Generate higher quality renditions later.
```

Recommended sort:

```text
queue_level asc
user_has_no_playable_version desc
estimated_work asc
created_at asc
```

Aging:

```text
Increase priority for jobs waiting too long.
Promote long-waiting Q2/Q3 jobs gradually.
```

Do not let short jobs starve long jobs forever.

## Estimated Work Formula

Use an estimate to avoid a long or heavy source blocking short videos.

Example:

```text
estimated_work =
  duration_sec *
  source_resolution_factor *
  target_resolution_factor
```

Suggested source factors:

```text
<= 720p: 1
1080p: 1.8
4K: 6
```

Suggested target factors:

```text
480p: 1
720p: 1.6
1080p: 2.4
```

Example simultaneous uploads:

```text
A: 512p, 30 sec
B: 1080p, 1 min
C: 720p, 5 min
D: 4K, 10 sec
```

Recommended processing order:

```text
probe all
thumbnail all
A base_480p
D base_480p
B base_480p
C base_480p
D enhance_720p
B enhance_720p
C enhance_720p
D enhance_1080p
B enhance_1080p
```

A does not get 720p or 1080p because the source is only 512p.

## VPS Sizing

For a combined early worker machine:

```text
DigitalOcean Premium AMD or Premium Intel
2 vCPU
2 GB RAM
90 GB NVMe
3 TB transfer
Approx. $24/month
```

Use it for:

```text
ffmpeg worker
lightweight link parser
optional WebSocket server early on
```

Limitations:

```text
Run only one ffmpeg task at a time.
Do not proxy video playback through this machine.
Do not run heavy browser automation on the same machine in production.
```

Run ffmpeg with lower priority:

```bash
nice -n 10 ionice -c2 -n7 ffmpeg ...
```

If WebSocket latency suffers, split:

```text
$6 VPS:
  WebSocket realtime server

$24 VPS:
  ffmpeg worker and parser
```

## WebSocket Responsibilities

WebSocket should synchronize:

```text
play
pause
seek
current time
host control state
members online
chat or lightweight messages
processing status notifications
```

WebSocket must not carry:

```text
video files
HLS segments
MP4 byte ranges
large thumbnails
```

Playback data path:

```text
Browser -> R2
```

Not:

```text
Browser -> VPS -> R2
```

## External Link Parsing

Do not treat external links like uploaded videos.

Supported early:

```text
Direct MP4 URL
Direct HLS .m3u8 URL
Known platform embed URL
OpenGraph title/thumbnail parsing
```

Avoid early:

```text
yt-dlp heavy extraction
headless browser parsing
downloading external videos
proxying external video streams
```

Recommended behavior:

```text
External direct MP4/HLS:
  Save URL and play directly if browser allows.

Platform links:
  Save metadata and use embed if supported.

Unsupported links:
  Save as media-library link only, not room-playable.
```

## Database Sketch

`media_items`:

```text
id
user_id
title
category
source_type               upload | external_url
original_r2_key
thumbnail_r2_key
mime_type
source_width
source_height
duration_sec
original_size_bytes
hls_size_bytes
total_size_bytes
playback_status           not_ready | mp4_ready | playable_base | playable_hd
transcode_status          none | queued | processing | ready | failed
processing_mode           fast_playable | full_quality
hls_master_key
last_played_at
created_at
updated_at
```

`media_renditions`:

```text
id
media_id
height
label
playlist_r2_key
size_bytes
status                    queued | processing | ready | failed
created_at
```

`transcode_jobs`:

```text
id
media_id
user_id
job_type                  probe | thumbnail | base_480p | enhance_720p | enhance_1080p
queue_level               0 | 1 | 2 | 3
status                    queued | processing | done | failed | cancelled
estimated_work
attempts
locked_by
locked_until
created_at
started_at
finished_at
last_promoted_at
```

`user_media_quota`:

```text
user_id
max_storage_bytes
max_duration_sec
used_storage_bytes
used_duration_sec
active_media_task_id
updated_at
```

## Playback Selection

Room playback should select source in this order:

```text
1. HLS master if ready.
2. R2 original MP4/WebM if browser-playable.
3. External direct HLS/MP4 if allowed.
4. Platform embed if supported.
5. Otherwise not playable in room.
```

Quality selection:

```text
Default: Auto
Manual: available renditions only
Per-user preference: local only
Room sync: time/play/pause/seek only
```

Do not force every room member to the same quality level.

## Implementation Phases

Phase 1:

```text
R2 original upload
D1 metadata
Browser compatibility check
Direct MP4 playback when possible
Quota enforcement
Per-user active upload/processing lock
```

Phase 2:

```text
DO worker
ffmpeg probe/thumbnail
base_480p processing
processing progress UI
HLS playback from R2
```

Phase 3:

```text
Full quality mode
720p and 1080p enhancement jobs
non-preemptive multi-level scheduling
aging
manual "generate quality version" action
```

Phase 4:

```text
Cold HLS cleanup
separate WebSocket VPS if needed
multiple transcode workers
advanced link parsing
paid quota tiers
```

## Key Product Decisions

- Users should not need to understand video codecs.
- Upload should be wide enough to feel friendly.
- Playback eligibility can be automatic.
- Generated quality should never promise to exceed source quality.
- Store generated HLS once; do not re-transcode every playback.
- Keep video playback off the VPS.
- Start cheap with R2 and DO credits; consider Cloudflare Stream later only if maintenance or processing latency becomes the bigger cost.
