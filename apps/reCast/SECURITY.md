# reCast security notes

This document describes the inputs, writes, subprocesses, and limits of reCast.
It is a result of a static review and local tests. It is not a security certificate.

## Inputs and protected data

| Input                | Source                     | Control                                                                                   |
| -------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| Source path          | Argument or terminal input | Must be a regular file. The real path is used. Options after `--` are file names.         |
| Source file contents | Any file                   | FFprobe and FFmpeg accept only the `file` protocol and a list of video container formats. |
| FFprobe JSON         | FFprobe output             | Parsed without trust. Unknown or malformed values become empty values or an error.        |
| Start time           | Terminal input             | Strict format check. Must be less than the duration.                                      |
| Result path          | Terminal input             | Absolute, `.mp4`, no control characters, existing directory, no existing entry.           |
| `PATH` and Homebrew  | User environment           | Only absolute directories. FFprobe must be in the same directory as FFmpeg.               |

The protected data is the source video and other files next to it.
The program reads the source file and writes one new file.
It does not send data to a network.

## Subprocesses

- FFmpeg, FFprobe, and `/usr/bin/open` start with argument arrays. No shell parses the arguments.
- FFmpeg and FFprobe get a new environment with only a system `PATH` and `AV_LOG_FORCE_NOCOLOR`.
  User variables such as `FFREPORT` cannot add log files or change the operation.
- Paths go to FFmpeg as absolute paths with the `file:` prefix.
  A file name cannot become an option or select another protocol.
- `-protocol_whitelist file` and `-format_whitelist` block playlists, concat lists, and network protocols.
  A playlist with an `.mkv` extension does not open.
- FFmpeg starts with `-nostdin`. It cannot read terminal input.
- FFmpeg starts with `-n`. It does not replace an existing file.

## File system

- The program examines the result path with `lstat`. A dangling symbolic link counts as an existing file.
- FFmpeg writes into a new directory from `mkdtemp`, with mode 0700, next to the result.
  No other user can put a link at the temporary path.
- The finished file goes to the result path with a hard link. A hard link never replaces an existing entry.
- Some volumes, such as exFAT, do not support hard links.
  On these volumes, the program examines the path and then renames the file.
  A different process can make the same name between the check and the rename. Then that file is replaced.
- The temporary directory is removed after success, an error, and Ctrl+C.
- The source file is opened only for reading.

## Terminal

- File names, stream titles, and FFmpeg messages pass through a filter that replaces control characters.
- Colors respect `NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR=0`.
- Prompts restore the raw mode and the input handlers after an answer, Ctrl+C, and an error.
- Without a TTY, the program stops before FFmpeg starts.

## Trust assumptions

- The FFmpeg installation is trusted. The program starts the first `ffmpeg` in `/opt/homebrew/bin`, `/usr/local/bin`, or an absolute `PATH` directory.
  A user who can write to these directories can replace FFmpeg. The program shows the path that it uses.
- FFmpeg decoders process untrusted file contents. A defect in a decoder can affect the user account.
  Keep FFmpeg up to date with `brew upgrade ffmpeg`.
- The free space check is an estimate. A full disk stops FFmpeg with an error, and the partial file is removed.

## Recovery

The program does not change the source file. To repeat a conversion, start the program again.
After a crash or a power failure, remove the hidden `.recast-*` directory next to the result.

## Distribution

The package has no runtime dependencies and no installation scripts.
The `files` list contains only the compiled modules, README.md, SECURITY.md, and LICENSE.
