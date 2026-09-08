#!/usr/bin/env python3
"""clue-video-review: extract audio/transcript + optional video understanding."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

TOOL_NAME = "clue-video-review"
SCHEMA = "clue.video-review.v1"
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}


class CliError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_version(root: Path) -> str:
    return (root / "VERSION").read_text(encoding="utf-8").strip()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def find_ffmpeg() -> str:
    env = (os.environ.get("FFMPEG_BIN") or "").strip()
    if env:
        return env
    found = shutil.which("ffmpeg")
    if not found:
        raise CliError("ffmpeg not found on PATH (set FFMPEG_BIN)")
    return found


def find_ffprobe() -> str | None:
    env = (os.environ.get("FFPROBE_BIN") or "").strip()
    if env:
        return env
    return shutil.which("ffprobe")


def resolve_video(path_str: str) -> Path:
    path = Path(path_str).expanduser().resolve()
    if not path.is_file():
        raise CliError(f"video not found: {path}")
    if path.suffix.lower() not in VIDEO_SUFFIXES:
        raise CliError(
            f"unsupported video suffix {path.suffix!r} (allowed: {sorted(VIDEO_SUFFIXES)})"
        )
    return path


def run_cmd(cmd: list[str], *, label: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip()[:800]
        raise CliError(f"{label} failed ({completed.returncode}): {err}")
    return completed


def extract_audio_file(video: Path, output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()
    # Mono 16 kHz wav — friendly default for many ASR backends.
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(video),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(output),
    ]
    run_cmd(cmd, label="ffmpeg extract-audio")
    if not output.is_file() or output.stat().st_size < 32:
        raise CliError(f"audio output missing or empty: {output}")
    return output


def command_extract_audio(args: argparse.Namespace) -> int:
    video = resolve_video(args.video)
    output = Path(args.output).expanduser().resolve()
    extract_audio_file(video, output)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "video": str(video),
                "audio": str(output),
                "bytes": output.stat().st_size,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def video_duration_s(video: Path) -> float | None:
    probe = find_ffprobe()
    if not probe:
        return None
    completed = subprocess.run(
        [
            probe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return None
    try:
        return float((completed.stdout or "").strip())
    except ValueError:
        return None


def extract_keyframe_files(
    video: Path, out_dir: Path, *, count: int = 5, interval: int = 2
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    # Clear prior frames so re-runs do not mix.
    for old in out_dir.glob("frame-*.jpg"):
        old.unlink(missing_ok=True)
    ffmpeg = find_ffmpeg()
    count = max(1, int(count))
    duration = video_duration_s(video)
    if duration and duration > 0:
        fps = max(count / duration, 0.05)
        vf = f"fps={fps:.6f}"
    else:
        vf = f"fps=1/{max(1, int(interval))}"
    pattern = str(out_dir / "frame-%03d.jpg")
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(video),
        "-vf",
        vf,
        "-frames:v",
        str(count),
        "-q:v",
        "2",
        pattern,
    ]
    run_cmd(cmd, label="ffmpeg extract-keyframes")
    frames = sorted(out_dir.glob("frame-*.jpg"))
    if not frames:
        raise CliError(f"no keyframes written under {out_dir}")
    if len(frames) > count:
        for extra in frames[count:]:
            extra.unlink(missing_ok=True)
        frames = frames[:count]
    return frames


def command_extract_keyframes(args: argparse.Namespace) -> int:
    video = resolve_video(args.video)
    out_dir = Path(args.output_dir).expanduser().resolve()
    frames = extract_keyframe_files(
        video, out_dir, count=int(args.count or 5), interval=int(args.interval or 2)
    )
    print(
        json.dumps(
            {
                "status": "succeeded",
                "video": str(video),
                "output_dir": str(out_dir),
                "frame_count": len(frames),
                "frames": [str(p) for p in frames],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def whisper_bin() -> str | None:
    env = (os.environ.get("WHISPER_BIN") or "").strip()
    if env:
        return env
    return shutil.which("whisper")


def load_dotenv_root() -> None:
    """Load repo-root .env into os.environ without overriding existing keys."""
    root = Path(__file__).resolve().parents[2]
    env_path = root / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value


def jiekou_api_key() -> str | None:
    load_dotenv_root()
    for name in ("JIEKOU_API_KEY", "JIEKOU_TOKEN", "INTERFACE_AI_API_KEY"):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return None


def jiekou_base_url() -> str:
    load_dotenv_root()
    return (
        (os.environ.get("JIEKOU_BASE_URL") or os.environ.get("JIEKOU_API_BASE") or "")
        .strip()
        .rstrip("/")
        or "https://api.highwayapi.ai"
    )


def command_transcribe_scribe_v2(args: argparse.Namespace) -> int:
    """ElevenLabs Scribe v2 via JieKou (~$0.004 / 千字)."""
    import urllib.error
    import urllib.request

    key = jiekou_api_key()
    if not key:
        raise CliError(
            "JIEKOU_API_KEY missing in environment or repo-root .env "
            "(https://jiekou.ai/settings/key-management)"
        )

    source = (args.audio_url or args.audio or "").strip()
    if not source:
        raise CliError("provide --audio-url (HTTPS) or --audio (local path)")

    output = Path(args.output).expanduser().resolve()
    url = f"{jiekou_base_url()}/v3/elevenlabs-scribe-v2"
    headers = {
        "Authorization": f"Bearer {key}",
    }

    if source.startswith("http://") or source.startswith("https://"):
        body = json.dumps(
            {
                "cloud_storage_url": source,
                "language_code": args.language or None,
                "diarize": bool(args.diarize),
                "tag_audio_events": True,
                "timestamps_granularity": "word",
                "file_format": "other",
            },
            ensure_ascii=False,
        ).encode("utf-8")
        headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    else:
        audio = Path(source).expanduser().resolve()
        if not audio.is_file():
            raise CliError(f"audio not found: {audio}")
        # multipart/form-data
        boundary = f"----polaris-literature{os.getpid()}{int(datetime.now(UTC).timestamp())}"
        file_bytes = audio.read_bytes()
        chunks: list[bytes] = []
        def part(name: str, value: str) -> None:
            chunks.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
            )
        part("diarize", "true" if args.diarize else "false")
        part("tag_audio_events", "true")
        part("timestamps_granularity", "word")
        part("file_format", "other")
        if args.language:
            part("language_code", args.language)
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{audio.name}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
        )
        chunks.append(file_bytes)
        chunks.append(b"\r\n")
        chunks.append(f"--{boundary}--\r\n".encode())
        body = b"".join(chunks)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            raw_text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:800]
        raise CliError(f"JieKou Scribe v2 HTTP {error.code}: {detail}") from error

    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as error:
        raise CliError(f"Scribe v2 returned non-JSON: {raw_text[:300]}") from error

    root = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    if not isinstance(root, dict):
        root = {}
    text = root.get("text") if isinstance(root.get("text"), str) else ""
    words_in = root.get("words") if isinstance(root.get("words"), list) else []
    if not text and isinstance(root.get("transcripts"), list) and root["transcripts"]:
        first = root["transcripts"][0]
        if isinstance(first, dict) and isinstance(first.get("text"), str):
            text = first["text"]
            words_in = first.get("words") if isinstance(first.get("words"), list) else words_in

    segments: list[dict[str, Any]] = []
    for item in words_in:
        if not isinstance(item, dict):
            continue
        wtext = item.get("text")
        if not isinstance(wtext, str) or not wtext.strip():
            continue
        if item.get("type") == "spacing":
            continue
        segments.append(
            {
                "start_s": float(item["start"]) if isinstance(item.get("start"), (int, float)) else 0.0,
                "end_s": float(item["end"]) if isinstance(item.get("end"), (int, float)) else 0.0,
                "text": wtext.strip(),
            }
        )

    payload = {
        "schema_version": "clue.video-review.transcript.v1",
        "status": "succeeded",
        "dry_run": False,
        "audio": source,
        "engine": "jiekou-elevenlabs-scribe-v2",
        "model": "elevenlabs-scribe-v2",
        "text": str(text or "").strip(),
        "segments": segments,
        "language": root.get("language_code") if isinstance(root.get("language_code"), str) else None,
        "language_probability": root.get("language_probability")
        if isinstance(root.get("language_probability"), (int, float))
        else None,
        "provider_raw": raw,
    }
    write_json(output, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "dry_run": False,
                "engine": payload["engine"],
                "segment_count": len(segments),
                "chars": len(payload["text"]),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_transcribe(args: argparse.Namespace) -> int:
    engine = (getattr(args, "engine", None) or "auto").strip().lower()
    if engine in {"jiekou", "scribe", "scribe-v2", "elevenlabs-scribe-v2"}:
        return command_transcribe_scribe_v2(args)
    if engine == "auto" and jiekou_api_key() and not args.dry_run:
        # Prefer JieKou Scribe v2 when key is configured.
        try:
            return command_transcribe_scribe_v2(args)
        except CliError as error:
            # Fall through to whisper if multipart/local fails and whisper exists.
            if not whisper_bin():
                raise
            print(f"warning: scribe-v2 failed ({error}); falling back to whisper", file=sys.stderr)

    audio = Path(args.audio).expanduser().resolve() if args.audio else None
    if audio is None or not audio.is_file():
        raise CliError(f"audio not found: {args.audio}")
    output = Path(args.output).expanduser().resolve()
    model = args.model or "base"
    if args.dry_run or not whisper_bin():
        payload = {
            "schema_version": "clue.video-review.transcript.v1",
            "status": "succeeded",
            "dry_run": True,
            "audio": str(audio),
            "engine": "dry-run" if args.dry_run else "whisper-unavailable",
            "text": (
                f"[dry-run transcript for {audio.name}; "
                "set JIEKOU_API_KEY for Scribe v2, or install whisper on PATH]"
            ),
            "segments": [
                {
                    "start_s": 0.0,
                    "end_s": 0.0,
                    "text": f"[dry-run] {audio.name}",
                }
            ],
            "language": None,
        }
        write_json(output, payload)
        print(
            json.dumps(
                {
                    "status": "succeeded",
                    "output": str(output),
                    "dry_run": True,
                    "engine": payload["engine"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    # openai-whisper CLI: whisper audio.wav --model base --output_format json --output_dir …
    out_dir = output.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        whisper_bin() or "whisper",
        str(audio),
        "--model",
        model,
        "--output_format",
        "json",
        "--output_dir",
        str(out_dir),
    ]
    run_cmd(cmd, label="whisper transcribe")
    # Default whisper names output after stem.
    candidate = out_dir / f"{audio.stem}.json"
    if not candidate.is_file():
        # Sometimes language suffix — pick newest json in dir.
        jsons = sorted(out_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not jsons:
            raise CliError("whisper produced no JSON transcript")
        candidate = jsons[0]
    raw = json.loads(candidate.read_text(encoding="utf-8"))
    text = raw.get("text") if isinstance(raw, dict) else ""
    segments_in = raw.get("segments") if isinstance(raw, dict) else []
    segments: list[dict[str, Any]] = []
    if isinstance(segments_in, list):
        for item in segments_in:
            if not isinstance(item, dict):
                continue
            seg_text = item.get("text")
            if not isinstance(seg_text, str) or not seg_text.strip():
                continue
            segments.append(
                {
                    "start_s": float(item.get("start") or 0),
                    "end_s": float(item.get("end") or 0),
                    "text": seg_text.strip(),
                }
            )
    payload = {
        "schema_version": "clue.video-review.transcript.v1",
        "status": "succeeded",
        "dry_run": False,
        "audio": str(audio),
        "engine": "whisper",
        "model": model,
        "text": str(text or "").strip(),
        "segments": segments,
        "language": raw.get("language") if isinstance(raw, dict) else None,
        "whisper_json": str(candidate),
    }
    write_json(output, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "dry_run": False,
                "segment_count": len(segments),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def image_review_cli(root: Path) -> Path:
    path = root.parent / "image-review" / "clue-image-review"
    if not path.is_file():
        raise CliError(f"clue-image-review missing: {path}")
    return path


def run_understand(
    *,
    root: Path,
    video: Path,
    work: Path,
    dry_run: bool,
    frame_count: int = 5,
    interval: int = 2,
) -> dict[str, Any]:
    """Keyframes + image-review; vibe reserved. Returns understand document."""
    frames_dir = work / "keyframes"
    frames = extract_keyframe_files(
        video, frames_dir, count=frame_count, interval=interval
    )
    image_review_path = work / "image-review.json"
    image_review: dict[str, Any] | None = None
    if frames:
        cmd = [
            str(image_review_cli(root)),
            "review",
            "--output",
            str(image_review_path),
        ]
        for frame in frames:
            cmd.extend(["--image", str(frame)])
        if dry_run:
            cmd.append("--dry-run")
        completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            err = (completed.stderr or completed.stdout or "").strip()[:600]
            raise CliError(f"image-review failed: {err}")
        image_review = json.loads(image_review_path.read_text(encoding="utf-8"))
    return {
        "schema_version": "clue.video-review.understand.v1",
        "status": "succeeded",
        "generated_at": utc_now(),
        "video": str(video),
        "keyframes": [str(p) for p in frames],
        "image_review_path": str(image_review_path) if image_review else None,
        "image_review": image_review,
        "vibe": None,
        "note": "vibe/style understanding not implemented yet",
    }


def command_understand(args: argparse.Namespace, root: Path) -> int:
    video = resolve_video(args.video)
    work = Path(args.work_dir).expanduser().resolve()
    work.mkdir(parents=True, exist_ok=True)
    payload = run_understand(
        root=root,
        video=video,
        work=work,
        dry_run=bool(args.dry_run),
        frame_count=int(args.frame_count or 5),
        interval=int(args.interval or 2),
    )
    output = Path(args.output).expanduser().resolve() if args.output else work / "understand.json"
    write_json(output, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "frame_count": len(payload.get("keyframes") or []),
                "image_review": payload.get("image_review_path"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def write_transcript_dry(audio: Path, output: Path) -> dict[str, Any]:
    payload = {
        "schema_version": "clue.video-review.transcript.v1",
        "status": "succeeded",
        "dry_run": True,
        "audio": str(audio),
        "engine": "dry-run",
        "text": (
            f"[dry-run transcript for {audio.name}; "
            "install openai-whisper as `whisper` on PATH for live ASR]"
        ),
        "segments": [
            {
                "start_s": 0.0,
                "end_s": 0.0,
                "text": f"[dry-run] {audio.name}",
            }
        ],
        "language": None,
    }
    write_json(output, payload)
    return payload


def command_review(args: argparse.Namespace, root: Path) -> int:
    """Full pass: audio → transcript; optional understand."""
    video = resolve_video(args.video)
    work = Path(args.work_dir).expanduser().resolve()
    work.mkdir(parents=True, exist_ok=True)
    audio = work / "audio.wav"
    transcript_path = work / "transcript.json"

    extract_audio_file(video, audio)
    if args.dry_run or not whisper_bin():
        transcript = write_transcript_dry(audio, transcript_path)
        if not args.dry_run and not whisper_bin():
            transcript["engine"] = "whisper-unavailable"
            write_json(transcript_path, transcript)
    else:
        command_transcribe(
            argparse.Namespace(
                audio=str(audio),
                output=str(transcript_path),
                dry_run=False,
                model=args.whisper_model or "base",
            )
        )
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))

    understand_doc: dict[str, Any] | None = None
    if not args.skip_understand:
        und_out = work / "understand.json"
        understand_doc = run_understand(
            root=root,
            video=video,
            work=work,
            dry_run=bool(args.dry_run),
            frame_count=int(args.frame_count or 5),
            interval=int(args.interval or 2),
        )
        write_json(und_out, understand_doc)

    evidence: list[dict[str, str]] = []
    t_text = str(transcript.get("text") or "").strip()
    if t_text:
        evidence.append({"quote": t_text[:800], "locator": "transcript"})
    for seg in transcript.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        st = seg.get("text")
        if isinstance(st, str) and st.strip():
            start = seg.get("start_s") or 0
            evidence.append(
                {
                    "quote": st.strip()[:400],
                    "locator": f"transcript@{float(start):.1f}s",
                }
            )
            if len(evidence) >= 8:
                break
    if understand_doc and isinstance(understand_doc.get("image_review"), dict):
        for item in understand_doc["image_review"].get("evidence") or []:
            if isinstance(item, dict) and isinstance(item.get("quote"), str):
                evidence.append(
                    {
                        "quote": item["quote"][:400],
                        "locator": f"keyframe:{item.get('locator', 'image@0')}",
                    }
                )

    payload = {
        "schema_version": SCHEMA,
        "tool": {"name": TOOL_NAME, "version": read_version(root)},
        "generated_at": utc_now(),
        "status": "succeeded",
        "dry_run": bool(args.dry_run),
        "video": str(video),
        "audio_path": str(audio),
        "transcript": transcript,
        "understand": understand_doc,
        "text": t_text
        or (
            (understand_doc or {}).get("image_review") or {}
        ).get("text")
        or "",
        "evidence": evidence,
    }
    output = Path(args.output).expanduser().resolve()
    write_json(output, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(output),
                "dry_run": bool(args.dry_run),
                "has_transcript": bool(t_text),
                "evidence_count": len(evidence),
                "skip_understand": bool(args.skip_understand),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Inbound video: audio/transcript + optional visual understanding.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="Print tool version.")

    ea = sub.add_parser("extract-audio", help="Demux audio to WAV via ffmpeg.")
    ea.add_argument("--video", required=True)
    ea.add_argument("--output", required=True, help="Output .wav path.")

    ek = sub.add_parser("extract-keyframes", help="Sample still frames via ffmpeg.")
    ek.add_argument("--video", required=True)
    ek.add_argument("--output-dir", required=True)
    ek.add_argument("--count", type=int, default=5, help="Max frames (default 5).")
    ek.add_argument(
        "--interval",
        type=int,
        default=2,
        help="Fallback seconds between frames if duration unknown.",
    )

    tr = sub.add_parser(
        "transcribe",
        help="ASR audio → text (JieKou Scribe v2 default when JIEKOU_API_KEY set).",
    )
    tr.add_argument("--audio", help="Local audio/video path (multipart to Scribe, or whisper).")
    tr.add_argument("--audio-url", help="HTTPS cloud_storage_url for Scribe v2.")
    tr.add_argument("--output", required=True)
    tr.add_argument(
        "--engine",
        default="auto",
        help="auto|jiekou|scribe-v2|whisper (default auto → jiekou when key present).",
    )
    tr.add_argument("--language", help="Optional ISO language code for Scribe.")
    tr.add_argument("--diarize", action="store_true", help="Enable speaker diarization (Scribe).")
    tr.add_argument("--model", dest="model", default="base", help="Whisper model name.")
    tr.add_argument("--dry-run", action="store_true")

    un = sub.add_parser(
        "understand",
        help="Keyframes + image-review; vibe reserved.",
    )
    un.add_argument("--video", required=True)
    un.add_argument("--work-dir", required=True)
    un.add_argument("--output", help="Understand JSON (default work-dir/understand.json).")
    un.add_argument("--frame-count", type=int, default=5)
    un.add_argument("--interval", type=int, default=2)
    un.add_argument("--dry-run", action="store_true", help="Pass dry-run to image-review.")

    rev = sub.add_parser("review", help="Audio+transcript (+ optional understand).")
    rev.add_argument("--video", required=True)
    rev.add_argument("--work-dir", required=True)
    rev.add_argument("--output", required=True)
    rev.add_argument("--dry-run", action="store_true")
    rev.add_argument("--skip-understand", action="store_true")
    rev.add_argument("--frame-count", type=int, default=5)
    rev.add_argument("--interval", type=int, default=2)
    rev.add_argument("--whisper-model", default="base")

    args = parser.parse_args(argv)
    try:
        if args.command == "version":
            print(
                json.dumps(
                    {
                        "tool": TOOL_NAME,
                        "version": read_version(root),
                        "role": "media-utility",
                        "schema_version": SCHEMA,
                        "ffmpeg": shutil.which("ffmpeg") or os.environ.get("FFMPEG_BIN"),
                        "whisper": whisper_bin(),
                        "image_review": str(image_review_cli(root))
                        if (root.parent / "image-review" / "clue-image-review").is_file()
                        else None,
                        "jiekou_configured": bool(jiekou_api_key()),
                        "capabilities": {
                            "extract_audio": True,
                            "transcribe": "jiekou-scribe-v2|whisper|dry-run",
                            "extract_keyframes": True,
                            "understand": "keyframes+image-review",
                            "vibe": False,
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if args.command == "extract-audio":
            return command_extract_audio(args)
        if args.command == "extract-keyframes":
            return command_extract_keyframes(args)
        if args.command == "transcribe":
            return command_transcribe(args)
        if args.command == "understand":
            return command_understand(args, root)
        if args.command == "review":
            return command_review(args, root)
        raise CliError(f"unknown command: {args.command}")
    except CliError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
