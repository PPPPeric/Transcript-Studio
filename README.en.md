# LLJ Transcript Studio

[中文](README.md) · [English](README.en.md)

A browser-local audio/video transcription and editing workspace. The host Mac serves the website, browser runtimes, and public model files. Visiting computers need no Python, Node.js, or FFmpeg installation. Audio decoding, Whisper inference, editing, revision history, and exports run on the visiting computer.

Recordings and transcripts are stored in that browser and are not uploaded or automatically synchronized between computers.

## How it works

1. Connect to the Tailscale network authorized to access the host.
2. Open the deployed HTTPS address in a recent Chrome or Edge browser. On the host, you can also use `http://127.0.0.1:8001`.
3. Import audio or video, select a model and language, and start transcription.
4. Keep the page open during transcription. Play back, search, edit, label speakers, organize paragraphs, and export Markdown or SRT.
5. Use **项目备份** (Project backup) to download a `.lts` file containing audio, transcript, and revision history. Import that file through the media import button to restore it as a new project.

The current interface is in Chinese; this document provides English setup and usage instructions.

## Model downloads

Each computer downloads a model from the host the first time it uses that model, then normally reuses the browser cache. Choosing another model downloads its files. Switching browsers or clearing/evicting the cache may require downloading again. These requests download public model assets; they do not upload recordings.

Current quantized models and supporting files, measured in decimal MB:

| Model | Size | Suggested use |
| --- | ---: | --- |
| tiny | About 45 MB | Quick previews |
| base | About 81 MB | Clear recordings; a good starting point |
| small | About 254 MB | More accurate drafts; higher memory use |

All three total about 380 MB. The browser loads the selected model. Initial use also downloads the ONNX runtime; media that cannot be decoded natively additionally loads the FFmpeg runtime. Download size is not runtime memory use. Medium and large-v3 are not offered in this browser version.

The host prepares the model assets from Hugging Face before serving them. Visiting browsers use same-origin assets and do not need direct access to external model websites.

## Storage and privacy

Projects use IndexedDB and belong to the current computer, browser, and website origin. Changing computers, browsers, ports, or switching from localhost to HTTPS produces a separate project list. Use one consistent HTTPS address for everyday work.

Clearing site data, private browsing, or browser storage eviction can remove projects. The application requests persistent storage, but permission is not guaranteed. Download `.lts` backups regularly for recovery and manual migration.

The import action reads files locally. The default host serves static resources, rejects upload requests, and does not load the legacy Python API. Ordinary page and model downloads generate network requests and server access logs; application requests do not include recordings, transcripts, project IDs, or recording filenames.

## Editor features

- **Import:** Native browser decoding, with local FFmpeg WebAssembly fallback to extract the first audio track. Audio becomes mono 16 kHz WAV. Input files are limited to 1 GB; practical limits depend on memory and storage quota.
- **Transcription:** Browser CPU by default, with experimental GPU support. Chinese, English, Japanese, and automatic language detection are available.
- **Playback and editing:** Playback speed, 5-second jumps, waveform zoom, playback highlighting, search, undo/redo, paragraph boundaries, and speaker labels. Click text to play; double-click to edit. Changes autosave after roughly 0.9 seconds.
- **History:** Retains up to 30 revisions. Restoring a revision also preserves the previous content. Editing is disabled during transcription.
- **Stop:** Terminates the worker in the window that started the task and retains persisted segments. Closing the page interrupts inference; reopening marks the task interrupted. Inference does not continue in the background.
- **Export and backup:** Markdown/SRT downloads and complete `.lts` project backups are generated locally. Deleting a project removes its data from the current browser; back it up first if needed.

## Deploy on a Mac

Only the host requires Python 3, Node.js 20+, and npm. The macOS scripts prepare public models and frontend dependencies, build the site, and install a user-level LaunchAgent:

```bash
brew install python node
git clone https://github.com/PPPPeric/Transcript-Studio.git
cd Transcript-Studio
./scripts/install-macos.sh
```

The service starts when the current macOS account signs in, including after a reboot, and restarts if it exits. It listens only on `127.0.0.1:8001`, avoiding services on port 8000. It does not open a browser at login.

The first model preparation requires the host to reach Hugging Face. To use an existing proxy for public model downloads:

```bash
LTS_MODEL_PROXY=http://127.0.0.1:7897 ./scripts/install-macos.sh
```

Model assets live in `.browser-models/` and are copied to `frontend/dist/models/` during builds. They are excluded from Git. Logs are under `.runtime/logs/`. Keep the project directory in place; reinstall after moving it.

```bash
# Start manually and open a browser
./scripts/start.command
# Inspect the background service
launchctl print "gui/$(id -u)/local.llj-transcript-studio.server"
# Update, rebuild, and restart
git pull --ff-only
./scripts/install-macos.sh
# Stop and remove the LaunchAgent; keep project data
./scripts/uninstall-macos.sh
```

When the background service is installed, open the page directly instead of starting a second instance.

## Access over Tailscale

If standard HTTPS port 443 already serves another application, such as pp-daily, use a separate HTTPS port:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8001
tailscale serve status
```

Open the returned `https://machine.tailnet.ts.net:8443` address on an authorized Tailscale device. Devices need not share Wi-Fi. HTTPS enables the browser capabilities used by the application. Use Serve; do not enable Funnel or public router port forwarding for this deployment.

To remove only this entry:

```bash
tailscale serve --https=8443 off
```

## Import legacy host projects

Legacy `projects/` data and `.model-cache/` remain on the host. The browser edition does not read or remotely serve these private files. Create local backups on the host:

```bash
python3 scripts/export-legacy-projects.py
```

Import the resulting `.lts` files from `.runtime/legacy-backups/` on the chosen computer. This directory is not served by the website. The legacy Python implementation remains in `backend/` for reference; default startup now uses the static server.

## Development and tests

```bash
cd frontend
npm ci
npm run build
npx playwright install chromium
npm run test:browser
```

Builds check TypeScript and copy the local ONNX and FFmpeg runtimes. A build without models prints a notice; deployment scripts prepare models first. For frontend development, `npm run dev` proxies `/models` and `/runtime` to the static service on localhost port 8001.

Browser tests cover persistence after reload, editing, revision restore, Markdown/SRT exports, project backup restore, browser isolation, absence of uploads/API requests, and rejection of uploads/private file access by the host. Set `LTS_TEST_AUDIO` to an absolute path to a synthetic speech WAV to enable real Whisper inference and cancellation tests; prepare models first. `LTS_TEST_CHROME` can select an existing Chrome executable. Manual browser validation also covered MKV audio extraction. GitHub Actions retains legacy backend tests and runs the browser regression suite.

## Limitations

- Performance depends on the visiting computer. CPU inference is generally slower than the legacy host MLX engine. GPU support is experimental and depends on browser and hardware compatibility.
- Decoding, waveforms, inference, and backups consume local memory. Large files and long recordings can exceed browser limits. Start with short recordings and tiny or base.
- Whisper emits timestamped segments in 25-second audio blocks. Boundaries can affect phrasing; precise word alignment is not provided. Accuracy and accents require manual review.
- The host must be reachable for initial page loading and uncached models. There is no offline installation/PWA; model caching alone does not make the whole site available offline.
- Projects do not automatically sync between browsers; transfer them manually using `.lts` backups.
- Media support depends on browser and bundled FFmpeg codecs. If decoding fails, try MP3, M4A, or WAV.

## License and earlier design notes

Project code is [MIT licensed](LICENSE). Third-party runtimes and models retain their respective licenses. Model source revisions are recorded in `.browser-models/Xenova/whisper-*/source.json`, with model cards saved alongside the files.

`PACKAGING_PLAN.md` and `PYTORCH_RUNTIME_TEST.md` document the earlier desktop/Python approach and do not describe the current browser deployment.
