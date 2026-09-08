# clue-video-review

Inbound **video** utilities for ad-content (not promo generation).

| Capability | Command | Status |
|------------|---------|--------|
| Extract audio | `extract-audio` | **implemented** (ffmpeg) |
| Transcribe → text | `transcribe` | **JieKou ElevenLabs Scribe v2** when `JIEKOU_API_KEY` set; else whisper / dry-run |
| Keyframes | `extract-keyframes` | **implemented** (ffmpeg) |
| Understanding | `understand` | keyframes → optional `image-review`; vibe later |
| Full pass | `review` | audio + transcript + optional understand |

Orchestrate from `ad_content` phase 2. Product IA (`ad-content-review`)
consumes transcript/text evidence, not raw video.

## Commands

```sh
./clue-video-review version

./clue-video-review extract-audio \
  --video clip.mp4 --output /tmp/audio.wav

./clue-video-review extract-keyframes \
  --video clip.mp4 --output-dir /tmp/frames --count 5

# JieKou ElevenLabs Scribe v2 (needs JIEKOU_API_KEY in repo .env)
./clue-video-review transcribe \
  --engine scribe-v2 \
  --audio-url 'https://example.com/clip.wav' \
  --output /tmp/transcript.json

# or local file (multipart)
./clue-video-review transcribe \
  --engine scribe-v2 \
  --audio /tmp/audio.wav \
  --output /tmp/transcript.json

./clue-video-review transcribe \
  --audio /tmp/audio.wav --output /tmp/transcript.json --dry-run

./clue-video-review understand \
  --video clip.mp4 --work-dir /tmp/v-understand --dry-run

./clue-video-review review \
  --video clip.mp4 --work-dir /tmp/v-review --output /tmp/video-review.json --dry-run
```

## Output (`review`)

`schema_version: clue.video-review.v1` with:

- `audio_path`, `transcript` (text + segments)
- `keyframes[]`, optional `image_review` (from clue-image-review)
- `evidence[]` for collection merge
