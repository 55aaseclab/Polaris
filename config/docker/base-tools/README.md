# Polaris Workspace Base Tools

This directory defines the shared tool baseline for the Polaris workspace
prebuilt image.

The catalog is organized by user task, not by implementation language.
That matches how coding agents usually choose tools:

1. use a purpose-built CLI first
2. fall back to Python when CLI output needs more shaping
3. use heavier desktop-grade tooling only when necessary

## 1. Text And Code Processing

Preferred CLI:
- `bash`
- `fd`
- `ripgrep`
- `git`
- `less`
- `tree`
- `file`

Python fallback:
- `pyyaml`
- `rich`
- `typer`

Heavy fallback:
- `neovim`

## 2. Structured Data And Tables

Preferred CLI:
- `jq`
- `sqlite3`
- `csvkit`
- `visidata`

Python fallback:
- `pandas`
- `numpy`
- `pyarrow`
- `duckdb`
- `openpyxl`

Heavy fallback:
- `libreoffice-calc`

## 3. PDF And Documents

Preferred CLI:
- `pdftotext`
- `pdfinfo`
- `pdftoppm`
- `qpdf`
- `pandoc`

Python fallback:
- `pypdf`
- `pymupdf`
- `pdfplumber`

Heavy fallback:
- `ghostscript`

## 4. Office File Conversion

Preferred CLI:
- `antiword`
- `catdoc`
- `odt2txt`

Python fallback:
- `python-docx`
- `python-pptx`
- `odfpy`

Heavy fallback:
- `libreoffice-writer`
- `libreoffice-impress`

## 5. OCR And Image Extraction

Preferred CLI:
- `tesseract`
- `imagemagick`
- `exiftool`

Python fallback:
- `pytesseract`
- `Pillow`

Heavy fallback:
- `tesseract-ocr-chi-sim`

## 6. Web And APIs

Preferred CLI:
- `curl`
- `wget`
- `http`

Python fallback:
- `requests`
- `httpx`
- `beautifulsoup4`
- `lxml`
- `markdownify`

Heavy fallback:
- `chromium`

## 7. Multimedia

Preferred CLI:
- `ffmpeg`
- `mediainfo`

Python fallback:
- `ffmpeg-python`

Heavy fallback:
- `libreoffice`

## 8. Archives And Binary Inspection

Preferred CLI:
- `zip`
- `unzip`
- `7z`
- `xz`
- `tar`
- `strings`

Python fallback:
- standard-library archive modules

Heavy fallback:
- none

## 9. System Debugging And Network Diagnostics

Preferred CLI:
- `procps`
- `psmisc`
- `lsof`
- `strace`
- `htop`
- `ncdu`
- `ip`
- `netstat`
- `dig`

Python fallback:
- `ipython`

Heavy fallback:
- `screen`

## 10. General Python Runtime

Preferred CLI:
- `python3`
- `pip`
- `venv`
- `pipx`
- `uv`

Python fallback:
- `pydantic`
- `tabulate`

Heavy fallback:
- `python3-dev`

## 11. General Node And Agent CLI

Preferred CLI:
- `node`
- `npm`
- `pnpm`
- `paseo`
- `codex`
- `claude`
- `copilot`
- `opencode`
- `pi`

Python fallback:
- none

Heavy fallback:
- `typescript`
- `tsx`
- `eslint`
- `prettier`
- `markdownlint-cli`

## Installed Package Sources

- Debian packages:
  `apt-packages.txt`
- Python packages:
  `python-packages.txt`
- Node packages:
  `node-packages.txt`
- Installer:
  `install-base-tools.sh`
