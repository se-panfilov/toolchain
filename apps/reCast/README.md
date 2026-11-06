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

| Argument                      | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `FILE`                        | Source video. Without it, the program asks for a path.                  |
| `--mode MODE`                 | `remux-test`, `remux`, `h264-test`, or `h264`.                          |
| `--audio N\|none`             | The audio stream by its number in the list, or no audio.                |
| `--subtitles N\|none`         | The subtitle stream by its number in the list, or no subtitles.         |
| `--subtitle-format vtt\|burn` | `vtt` writes a WebVTT file. `burn` burns in the subtitles (H.264 only). |
| `--start TIME`                | The start of a sample: `HH:MM:SS`, `MM:SS`, or seconds.                 |
| `--output PATH`               | The result path. It must end with `.mp4`.                               |
| `--dry-run`                   | Shows the plan and stops. No file is written.                           |
| `-y`, `--yes`                 | Runs without questions. `FILE` and `--mode` are necessary.              |
| `--`                          | Ends the options. Use it for a file name with `-`.                      |
| `--version`                   | Shows the version.                                                      |
| `--help`                      | Shows the help in Russian.                                              |

Options accept `--name value` and `--name=value`.
Stream numbers are the numbers that the program shows in the stream list, from 1.
A repeated, unknown, or empty option stops the program before it reads the file.

Without `--yes`, the program asks only the questions that the options do not answer.
It always asks for the final confirmation.

## Procedure

1. Start the program.
2. Drag the video file into the Terminal window, or type its path. Push Enter.
3. Examine the stream data: codec, resolution, HDR, audio streams, and duration.
4. Select a mode with the arrow keys. Push Space to select, then Enter.
5. If the file has more than one audio stream, select one audio stream.
6. If the file has subtitles that the mode supports, select a subtitle stream or `Без субтитров`.
7. If the stream supports two formats, select WebVTT or burn-in.
8. For a sample mode, edit the start time of the sample. The default is `00:05:00`.
9. Edit the result path. The default is next to the source file.
10. Examine the summary and the free space. Select `Да` to start.

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
The result has no data streams or chapters.

The default is no subtitles. You can add one subtitle stream in one of two formats.

| Format  | Result                                     | Modes      | Subtitle streams                |
| ------- | ------------------------------------------ | ---------- | ------------------------------- |
| WebVTT  | A separate `.vtt` file with the MP4 name   | All        | Text: SubRip, ASS, SSA, WebVTT  |
| Burn-in | The subtitles become a part of the picture | H.264 only | Text, and images: PGS, DVD, DVB |

Chromecast plays external WebVTT subtitles. The sender app must load the `.vtt` file with the video.
Burned-in subtitles are always visible on every device. You cannot turn them off.
Image subtitles cannot become WebVTT, so they need an H.264 mode.
Teletext and other subtitle formats are not offered.

A WebVTT file of a sample has the same time range as the sample.
Burned-in ASS subtitles use system fonts. Fonts attached to the MKV file are not used.

## Supported input

The program opens Matroska (MKV, WebM), MP4, MOV, AVI, and MPEG-TS files.
It does not open playlists, network addresses, or other FFmpeg formats.
The first video stream that is not a cover image is used.

## Use without questions

Use `--yes` for scripts and batch runs. A TTY is not necessary.

```sh
npx tx-recast "/path/to/film.mkv" --mode remux --subtitles 1 --yes
npx tx-recast "/path/to/film.mkv" --mode h264-test --start 00:20:00 --yes --dry-run
```

`FILE` and `--mode` are necessary. Other values have these defaults:

| Value     | Default                                                        |
| --------- | -------------------------------------------------------------- |
| Audio     | The stream that the file marks as default, else the first one. |
| Subtitles | None.                                                          |
| Format    | `vtt` for text subtitles, `burn` for image subtitles.          |
| Start     | `00:05:00`, or `00:00:00` for a file shorter than 6 minutes.   |
| Output    | `<name>-cast-<mode>.mp4` next to the source file.              |

With `--yes`, the program writes messages to stderr.
The progress bar shows only when stderr is a terminal.
After success, stdout contains the result path, and the WebVTT path on a second line.
If the free space is not sufficient, the program stops with an error.
Finder does not open.

| Exit code | Meaning                                 |
| --------- | --------------------------------------- |
| 0         | Success, or a completed dry run.        |
| 1         | An error. No result file stays.         |
| 130       | Interrupted. Partial files are removed. |

## Results and recovery

The program never replaces a file.
The default name is `<name>-cast-<mode>.mp4`.
If that name or the `.vtt` file with that name is in use, the program adds the date and time to the name.

FFmpeg writes into a hidden temporary directory `.recast-*` next to the result.
After a successful conversion, the program moves the files to the result path.
If the result path is in use at that time, the program uses a new name and shows a warning.

An FFmpeg error or Ctrl+C removes the partial files.
The source file stays unchanged, so you can start again.
If the program stops in an unusual way, such as a power failure, remove the `.recast-*` directory.

The program shows the estimated size of the result and the free space.
If the space is not sufficient, it asks for a confirmation. The default answer is `Нет`.

Burned-in text subtitles are first extracted into the temporary directory as `subtitles.ass`.

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
Burn-in uses VideoToolbox, so only its FFmpeg arguments are tested.
Tests do not use the hardware encoder, because CI runners do not have it.
