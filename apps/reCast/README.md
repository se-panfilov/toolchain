# reCast

reCast converts a video file into an MP4 file for Chromecast and other streaming devices.
It runs FFmpeg with settings that these devices can play.
The source file does not change. The result is a new file.
The user interface uses Russian.

Use [SECURITY.md](SECURITY.md) for security controls and limits.

## Requirements

- macOS. Other platforms are not supported in this version.
- Node.js 24.12 or later.
- FFmpeg and FFprobe from Homebrew: `brew install ffmpeg`.
- An ANSI terminal. The program is interactive.

H.264 modes use the `h264_videotoolbox` hardware encoder.
HDR sources also need the `zscale` filter.
The Homebrew FFmpeg build contains both.

## Start

Run the published package:

```sh
npx tx-recast
npx tx-recast "/path/to/film.mkv"
```

Run the local build from the Toolchain root:

```sh
npm ci --ignore-scripts
npm run start --workspace tx-recast
npm run start --workspace tx-recast -- "/path/to/film.mkv"
```

The start script builds the application before it starts `dist/src/cli.js`.
A build failure stops the start.

| Argument    | Purpose                                                |
| ----------- | ------------------------------------------------------ |
| `FILE`      | Source video. Without it, the program asks for a path. |
| `--`        | Ends the options. Use it for a file name with `-`.     |
| `--version` | Shows the version.                                     |
| `--help`    | Shows the help in Russian.                             |

## Procedure

1. Start the program.
2. Drag the video file into the Terminal window, or type its path. Push Enter.
3. Examine the stream data: codec, resolution, HDR, audio streams, and duration.
4. Select a mode with the arrow keys. Push Space to select, then Enter.
5. If the file has more than one audio stream, select one audio stream.
6. For a sample mode, edit the start time of the sample. The default is `00:05:00`.
7. Edit the result path. The default is next to the source file.
8. Examine the summary and the free space. Select `Да` to start.

The program shows a progress bar with the speed and the remaining time.
After the conversion, Finder shows the result.

## Modes

| Mode         | Video                                 | Speed   | Use                                          |
| ------------ | ------------------------------------- | ------- | -------------------------------------------- |
| REMUX sample | Copied without change, 60 seconds     | Seconds | Check if the device plays the copied stream. |
| REMUX        | Copied without change                 | Fast    | The device plays H.264 or HEVC.              |
| H.264 sample | Encoded with VideoToolbox, 60 seconds | Seconds | Check the colors and the quality.            |
| H.264        | Encoded with VideoToolbox             | Slow    | Old devices, HDR on an SDR screen, AV1.      |

REMUX modes are available only for H.264 and HEVC video.
For other codecs, such as AV1 or VP9, use an H.264 mode.

REMUX keeps the video stream without change.
HEVC gets the `hvc1` tag, because devices need it in MP4.
A REMUX sample starts at the nearest key frame before the selected time.

H.264 modes encode at 8 Mbit/s with the High profile and level 4.1.
Sources larger than 1920×1080 are scaled down and keep their aspect ratio.
HDR10 (PQ) and HLG sources get a tone map into SDR BT.709.
SDR sources keep their colors.

## Audio and subtitles

The result contains one audio stream that you select.
The default selection is the stream that the file marks as default.

| Source audio              | REMUX result | H.264 result |
| ------------------------- | ------------ | ------------ |
| AAC, MP3, AC-3, E-AC-3    | Copied       | AAC stereo   |
| DTS, TrueHD, FLAC, others | AAC stereo   | AAC stereo   |
| No audio                  | No audio     | No audio     |

AAC is 192 kbit/s with two channels.
The result has no subtitles, data streams, or chapters.

## Supported input

The program opens Matroska (MKV, WebM), MP4, MOV, AVI, and MPEG-TS files.
It does not open playlists, network addresses, or other FFmpeg formats.
The first video stream that is not a cover image is used.

## Results and recovery

The program never replaces a file.
The default name is `<name>-cast-<mode>.mp4`.
If that name is in use, the program adds the date and time to the name.

FFmpeg writes into a hidden temporary directory `.recast-*` next to the result.
After a successful conversion, the program moves the file to the result path.
If the result path is in use at that time, the program uses a new name and shows a warning.

An FFmpeg error or Ctrl+C removes the partial file.
The source file stays unchanged, so you can start again.
If the program stops in an unusual way, such as a power failure, remove the `.recast-*` directory.

The program shows the estimated size of the result and the free space.
If the space is not sufficient, it asks for a confirmation. The default answer is `Нет`.

## Package structure

| Path                | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `src/cli.ts`        | Arguments, interactive questions, and the summary.               |
| `src/media.ts`      | FFmpeg discovery, the subprocess environment, and FFprobe data.  |
| `src/plan.ts`       | Modes, paths, time values, filters, and FFmpeg arguments.        |
| `src/convert.ts`    | The FFmpeg process, progress, cleanup, and the result placement. |
| `src/prompts.ts`    | Terminal questions with text fields and radio buttons.           |
| `test/`             | Vitest unit, integration, and lint tests.                        |
| `scripts/build.mjs` | Type checking, Vite build, and safe output publication.          |
| `dist/src/`         | Compiled runtime modules for local execution and npx.            |

The package is a CLI without a public import API. Its exports map is empty.
Source module imports use `@reCast/*`.
Shared tool versions, configuration, and the only lockfile belong to the Toolchain root.

## Checks

Run these commands from the Toolchain root:

```sh
npm run build --workspace tx-recast
npm test --workspace tx-recast
npm run start --workspace tx-recast -- --help
```

Integration tests use a real FFmpeg with `libx264` when it is available.
Without it, these tests are skipped.
Tests do not use the hardware encoder, because CI runners do not have it.
