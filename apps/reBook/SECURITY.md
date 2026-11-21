# reBook security notes

reBook reads a Markdown manuscript and local style files.
It writes book files into an output directory and can update `metadata.yaml`.
This file gives the controls, the trust assumptions, and the residual risks.

## Inputs and protected data

| Input            | Check                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Manuscript       | A regular text file, not empty, 64 MB or less. A link is accepted, because it is only read. |
| `metadata.yaml`  | A regular file, 1 MB or less. Pandoc reads a private copy.                                  |
| Cover            | JPEG, PNG, GIF, or WebP by extension and by file signature. 32 MB or less.                  |
| CSS              | A `.css` text file, 1 MB or less.                                                           |
| `reference.docx` | A `.docx` file with a ZIP signature, 32 MB or less.                                         |
| Formats          | Known profiles or writers that the installed Pandoc lists.                                  |
| Version and date | SemVer and a real `YYYY-MM-DD` date.                                                        |
| `init` values    | No control, format, or line separator characters. Length limits.                            |

The book text and the metadata are the protected data.
The program does not send them to a network service.

## Subprocesses

- Pandoc and EPUBCheck start with argument arrays and without a shell.
- The tool search uses only absolute `PATH` entries. On macOS, Homebrew directories come first.
- Only a missing file means a missing tool. A found file that cannot run, such as a file without the execute permission or a broken link, stops the program.
- Pandoc options use the `--name=value` form, and the manuscript path comes after `--`.
- The tools get a small environment: `HOME`, locale variables, `TMPDIR`, `SOURCE_DATE_EPOCH`, `JAVA_HOME`, and a system `PATH`.
  `LUA_PATH`, `LUA_CPATH`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `XDG_DATA_HOME`, proxy settings, and other variables do not go to the tools.
- On Windows, variable names are compared without letter case.
- Pandoc gets an empty private `--data-dir`. User templates, defaults files, filters, and `init.lua` from the Pandoc data directory are not used.
- Only the packaged Lua filter runs. The program does not accept other filters or Pandoc defaults files.
- Each tool run has a time limit of 10 minutes.

## File system

- The work directory is a private `mkdtemp` directory. It is deleted after success, failure, and Ctrl+C.
- Pandoc writes into the work directory, not into the output directory.
- The output directory must not be a link or a file. A missing directory is made.
- A result path must be free or a regular file. A link or a directory at the path stops the build.
- A result goes into a temporary file in the output directory first.
  Without `--overwrite`, a hard link creates the result name only when the name is free.
  With `--overwrite`, a rename replaces the file. A rename replaces a link, not its target.
  The temporary file starts with mode `0600` and then gets the permission bits of the replaced file, so a private result stays private.
- A result file with an ACL is not replaced, because the new file would not get its access restrictions.
  On macOS and Linux, the program reads the ACL state from the output of `/bin/ls`. A failed check stops the build.
  On Windows, there is no ACL check. The new file gets the ACL that the output directory gives to new files.
- The owner and extended attributes of the replaced file are not copied.
- `--overwrite` allows the replacement of any result path. An interactive confirmation covers only the files that the plan showed as existing.
  A result file that appears after the confirmation stops the build.
- Until the end of the build, a hidden hard link keeps each replaced result.
  If a later step fails, the old results come back and new result names are removed.
  A path changes back only while it holds the file of this build. A newer file from another process stays,
  and the old result stays in the hidden copy. The error message shows its path.
- `init` writes a temporary file and then makes a hard link with the target name. A hard link does not follow a link at the target and does not replace an existing entry.
- The `metadata.yaml` update refuses a link and a file with other hard links.
  The build does this check before Pandoc starts, and again before each write.
  The new text goes into a temporary file before the results move. Its rename is the last step.
- The update changes only the top-level `version` and `date` lines and the `version` line directly under a top-level `ibooks:`.
  It skips block scalars and deeper keys. It refuses repeated `version`, `date`, `ibooks`, and `ibooks.version` keys,
  and block scalars, anchors, aliases, tags, and flow values in these fields.
  Pandoc reads the metadata before and after the change. Any change of another field stops the build.
- The program never deletes files in the output directory.

## Output without questions

With `--yes`, stdout contains only result paths. Messages and tool output go to stderr.
Without a TTY and without `--yes`, the program stops before it reads files.

## Dry-run

A dry-run writes no files. Without `metadata.yaml`, it shows the text of a new file and stops.
The Pandoc commands use POSIX single quotes, so `$(…)` and backticks in a title stay text in a copied command.

## Terminal

Paths, titles, and Pandoc messages can contain control characters.
The program replaces them before output and before it adds colors.
Colors respect `NO_COLOR`, `FORCE_COLOR=0`, and `TERM=dumb`.
Questions restore the raw mode and remove their handlers after an answer, a cancellation, or an error.

## Trust assumptions

- The manuscript, `metadata.yaml`, the cover, and the style files come from the user.
- Pandoc reads files that the manuscript references, such as images. It can also download images from `http` and `https` addresses.
  The `--sandbox` option of Pandoc 3.1 stops the DOCX writer, so the program does not use it.
- `metadata.yaml` can contain Pandoc fields that read local files, such as `cover-image`.
- The installed Pandoc and EPUBCheck are trusted. `JAVA_HOME` selects the Java runtime for EPUBCheck.

## Residual risks

- A manuscript from another person can make Pandoc read local files that it references, or make network requests.
  Check such a manuscript before the build.
- Another process of the same user can change files during the run. The checks make the time window small but do not remove it.
- EPUBCheck is optional. Without it, an EPUB file is not validated.
  A found EPUBCheck that cannot start, stops on a signal, or exceeds the time limit stops the build.

## Distribution

The package contains the compiled modules, `assets/epub.css`, `assets/reference.docx`, `assets/scene-breaks.lua`, `README.md`, `SECURITY.md`, and `LICENSE`.
The assets contain no author, title, identifier, or other book data.
The package has no runtime dependencies and no installation scripts.
