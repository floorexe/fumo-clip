# Fumo Clip

A free, open-source clip library and player for **OBS replay buffer** clips. OBS does the recording. Fumo Clip sorts your clips by game, plays them back with a **live mixer for every audio track** (game / Discord / mic, each on its own channel), and lets you trim and export them.

There is no auto-clipping. A clip only exists because you pressed your OBS replay hotkey.

## Download

Grab the latest **Fumo-Clip-Setup-x.y.z.exe** from the [Releases page](https://github.com/floorexe/fumo-clip/releases/latest) and run it.

- Windows may show a SmartScreen warning because the installer isn't code-signed. Click **More info → Run anyway**.
- **Updates are automatic.** Fumo Clip checks for a new release shortly after it starts and every few hours, downloads it in the background, and installs it when you restart (or right away with **Restart now**). You can turn this off or check by hand in Settings → App.

## Features

- **Library**: clips grouped by day, filtered by game (sidebar), Favorites, Exports, search, sort, card size, hover preview.
- **Game detection**: when OBS saves a replay, Fumo Clip checks which program is in the foreground and moves the clip to `Library/<Game>/<Game> <date>.mp4`. You can fix names in Settings → Game names.
- **Multi-track timeline**: every OBS audio track gets its own lane with a waveform, plus volume (0–200%), mute, solo and a level meter. Name your tracks once (Game, Discord, Mic…) and the names apply to every clip. Keys `1`–`6` mute tracks.
- **Trim**: drag the purple handles, Shift-drag on the timeline, or press `I` / `O`. Playback stays inside the trim (looping, or stopping at the end). Trims are saved per clip.
- **Timeline zoom**: Ctrl + scroll on the timeline (or the zoom slider, `+` / `-`, `0` to fit) zooms down to about 2 seconds on screen. Scroll to pan, and the view follows the playhead while playing.
- **Markers**: press `B` (or the flag button) to drop a marker. Click a marker to jump to it, use Ctrl+←/→ to go to the previous/next one, and right-click to remove it. Saved per clip.
- **Copy a frame**: press `C` (or the camera button) to copy the current frame to the clipboard. The toast can also save it as a PNG in `Screenshots/`.
- **Combine clips**: Ctrl/Shift-click clips in the library → **Combine**. Reorder them, pick a size, and get one video (each clip uses its trim, and audio is mixed with your track volumes). It's a temporary file to drag into Discord, unless you save a copy.
- **Themes**: 7 Fumo Clip themes plus 11 Touhou-inspired palettes (Reimu, Marisa, Sakuya, Remilia, Flandre, Cirno, Youmu, Yuyuko, Patchouli, Koishi, Sanae) with a faint danmaku-dot background. Settings → Theme.
- **Custom theme & background image**: pick your own colours (or start from any theme), and set a background image with darken / blur / see-through sliders. The image works with every theme.
- **Categories**: labels for clips, separate from folders. A clip can be in several categories and stays in its game folder (no copies). They show in the sidebar and you can rename or delete them there (that only removes the label). Add them from the clip details, right-click, or the selection bar.
- **Select whole games**: Ctrl-click or Shift-click games in the sidebar to select all their clips, then delete, move into one game, favorite, combine or categorize them together.
- **Import from other apps**: one click finds SteelSeries Moments, Overwolf/Outplayed, Medal, NVIDIA, AMD ReLive, Xbox Game Bar and Discord clip folders (or pick any folder). It works out each clip's game and date, brings over trims, custom titles and the real game names from Moments' database (read-only), skips anything already imported, and lets you **move** (instant on the same drive, no extra space) or **copy** (keeps the originals, checks free space first).
- **Share**: pick Original, 10 MB, 50 MB or 100 MB. Fumo Clip renders a temporary file with your tracks mixed the way you hear them, using the GPU encoder when there is one (NVENC/AMF/QSV). Drag it straight into Discord or copy it. Nothing is added to your folder unless you press **Save a copy**, and temp files are deleted when the app quits.
  - **Fine-tune** (optional): custom max size, resolution, frame rate, quality, audio (mixed / separate / none) and audio bitrate, H.264 or H.265, and GPU or CPU encoder. A live estimate shows the output resolution and bitrate. Your choices are remembered.
- **Sharing**: drag a clip card into Discord or Explorer. Right-click a clip for Copy file, Show in folder, Rename, Move to game, Delete (goes to the Recycle Bin).
- **OBS link** (optional, through obs-websocket): live replay-buffer status, a "Save replay" button, and start/stop the buffer from the status pill or the tray.
- Runs in the tray so it can catch clips while you play.

## How clips get in

Fumo Clip uses two methods, and you can turn on either or both:

1. **Folder watch** (no setup needed): Fumo Clip watches the OBS recording folder for new files that start with `Replay` (OBS's replay prefix). Normal recordings are ignored.
2. **obs-websocket**: in OBS go to *Tools → WebSocket Server Settings → Enable*. In Fumo Clip, open Settings → **Read from OBS** to fill in the port and password.

Both methods are read from your OBS config the first time Fumo Clip runs.

## Getting separate audio tracks from OBS

1. OBS *Settings → Output* → set Output Mode to **Advanced** → **Recording** tab → tick the audio tracks you want (for example 1–4).
2. *Edit → Advanced Audio Properties* → for each source, tick which tracks it goes to. A common setup: Track 1 = everything, Track 2 = game, Track 3 = Discord, Track 4 = mic.
3. The replay buffer uses the recording settings. Use MP4 or MKV. Both work, and MKV is converted for playback automatically if needed.

## Run / build from source

```
npm install
npm start          # run from source
npm run dist       # build the Windows installer into dist/
```

The app uses bundled ffmpeg/ffprobe (`ffmpeg-static`), so nothing else needs to be installed.

### Publishing a release (maintainers)

1. Bump `version` in `package.json`.
2. `npm run dist`
3. `gh release create vX.Y.Z dist/Fumo-Clip-Setup-X.Y.Z.exe dist/Fumo-Clip-Setup-X.Y.Z.exe.blockmap dist/latest.yml --title "Fumo Clip X.Y.Z" --notes "..."`

Installed copies find the new version through `latest.yml` on the newest release.

## How it works

- `src/main.js`: Electron main process, settings, IPC, and a `clipdeck://` protocol that serves the UI and local media with HTTP Range support.
- `src/library.js`: scans the library folder and stores metadata (favorites, trims, game names) in `<Library>/.clipdeck/db.json`, so it travels with your clips. Thumbnails and audio stems are cached in `%APPDATA%/Fumo Clip/clipdeck-cache`.
- `src/obs.js`: obs-websocket client, folder watcher, and OBS config detection.
- `src/game.js`: foreground-window process → game name.
- `src/media.js`: ffprobe/ffmpeg wrappers (probe, thumbnails, per-track audio extraction, playback proxies, export).
- `src/renderer/mixer.js`: the video plays muted while each audio track plays from its own extracted stem through Web Audio (gain → analyser → master). The stems are kept in sync with the video.

MIT licensed.
