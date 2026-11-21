# reBook security notes

reBook reads a Markdown manuscript and local style files.
It writes book files into an output directory and can update `metadata.yaml`.
For PDF, it also starts typst.
This file gives the controls, the trust assumptions, and the residual risks.

## Inputs and protected data

| Input                   | Check                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manuscript              | A regular text file, not empty, 64 MB or less. A link is accepted, because it is only read.                                                                          |
| `metadata.yaml`         | A regular file, 1 MB or less. Pandoc reads a private copy.                                                                                                           |
| Typograf Core whitelist | A regular `.json` file, not empty, 256 KB or less. Every rule name must exist in the installed Typograf Core and match the whitelist locale. `*` masks are rejected. |
| Cover                   | JPEG, PNG, GIF, or WebP by extension and by file signature. 32 MB or less.                                                                                           |
| CSS                     | A `.css` text file, 1 MB or less.                                                                                                                                    |
| `reference.docx`        | A `.docx` file with a ZIP signature, 32 MB or less.                                                                                                                  |
| Formats                 | Known profiles or writers that the installed Pandoc lists.                                                                                                           |
| Version and date        | SemVer and a real `YYYY-MM-DD` date.                                                                                                                                 |
| `init` values           | No control, format, or line separator characters. Length limits.                                                                                                     |

The book text, the metadata, and the Typograf Core whitelist are the protected data.
The program does not send them to a network service.

## Typograf Core

- Typograf Core is a local, in-process library. The program does not start a subprocess, a shell command,
  or a network request to apply typography rules.
- Every Typograf Core rule starts disabled. Only the rule names listed in the whitelist turn on.
  The program never passes `*` or another mask as an enabled rule; only the whitelist loader can expand a
  profile into its full, explicit rule list.
- The whitelist JSON is parsed with `JSON.parse` and read as data. It is never evaluated or passed to a
  shell, a template engine, or `eval`.
- A whitelist file is checked for a regular-file type, a `.json` extension, and a size limit before the
  parse. The checks and the read use one file descriptor. The open does not block on a FIFO.
  A missing file, a directory, or a link to a missing target is rejected.
- A new whitelist file must also have a `.json` name. It goes to disk only with the results of a successful build,
  after the confirmation. Writing it never replaces an existing file at the same path.
- The formatted manuscript (`*.formatted.md`) and a new whitelist use the same placement step as the result files:
  a temporary file in the target directory, a rename or a hard link, and a rollback when a later step fails.
  A link, a directory, or a file with an ACL at the target path stops the build before Pandoc starts.
- The formatted manuscript never gets wider permission bits than the manuscript. Its temporary file starts with mode `0600`.
  A new file gets the bits of the manuscript without the execute bits. A replaced file keeps only the bits that
  both the old file and the manuscript allow.
- Pandoc reads a private copy of the formatted text in the work directory, not the `*.formatted.md` file.
  A change of that file during the build cannot reach the results.
- No written file can be an input of the same build, and two written files cannot share a path. The check
  compares real paths and, for existing files, the device and inode. Another spelling of a path, a link in a
  directory name, or a hard link cannot hide a collision. The check runs before Pandoc starts.
- A Typograf Core error stops the build before Pandoc runs. A failed or cancelled build changes no file.

## Subprocesses

- Pandoc, typst, and EPUBCheck start with argument arrays and without a shell.
- The tool search uses only absolute `PATH` entries. On macOS, Homebrew directories come first.
- Only a missing file means a missing tool. A found file that cannot run, such as a file without the execute permission or a broken link, stops the program.
- Pandoc options use the `--name=value` form, and the manuscript path comes after `--`.
- The tools get a small environment: `HOME`, locale variables, `TMPDIR`, `SOURCE_DATE_EPOCH`, `JAVA_HOME`, and a system `PATH`.
  `LUA_PATH`, `LUA_CPATH`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `XDG_DATA_HOME`, proxy settings, and other variables do not go to the tools.
- On Windows, variable names are compared without letter case.
- Pandoc gets an empty private `--data-dir`. User templates, defaults files, filters, and `init.lua` from the Pandoc data directory are not used.
- Only the packaged Lua filter runs. The program does not accept other filters or Pandoc defaults files.
- Each tool run has a time limit of 10 minutes.
- typst is found by the same search as Pandoc. It is necessary only when PDF is in the format list.
  Without typst, the default format list has no PDF. An explicit PDF request stops the build before Pandoc starts.
- For PDF, Pandoc writes Typst markup into a private `pdf` directory in the work directory and copies the
  images into it (`--extract-media`). typst gets `--root` with that directory, so the markup can read only
  the files in it and cannot read other files of the user. typst writes the PDF into the work directory.
  The typst arguments use `--root=value`, and the input and output paths come after `--`.
- PDF needs Pandoc 3.2 or later. In earlier versions, `--extract-media` can write files outside the media
  directory (CVE-2023-35936 and CVE-2023-38745, fixed in Pandoc 3.1.6). The check reads only the major and
  minor version, so the limit is 3.2. Other formats keep the Pandoc 3.0 minimum, because they do not use `--extract-media`.
- `TYPST_ROOT`, `TYPST_FONT_PATHS`, `TYPST_PACKAGE_PATH`, and other typst variables do not go to typst.

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

A dry-run writes no files: no result file, no `*.formatted.md` file, and no new whitelist file.
Without `metadata.yaml`, it shows the text of a new file and stops.
The Pandoc commands use POSIX single quotes, so `$(…)` and backticks in a title stay text in a copied command.

## Terminal

Paths, titles, and Pandoc messages can contain control characters.
The program replaces them before output and before it adds colors.
Colors respect `NO_COLOR`, `FORCE_COLOR=0`, and `TERM=dumb`.
Questions restore the raw mode and remove their handlers after an answer, a cancellation, or an error.

## Trust assumptions

- The manuscript, `metadata.yaml`, the cover, the style files, and the Typograf Core whitelist come from the user.
- Pandoc reads files that the manuscript references, such as images. It can also download images from `http` and `https` addresses.
  The `--sandbox` option of Pandoc 3.1 stops the DOCX writer, so the program does not use it.
- `metadata.yaml` can contain Pandoc fields that read local files, such as `cover-image`.
- The installed Pandoc, typst, and EPUBCheck are trusted. `JAVA_HOME` selects the Java runtime for EPUBCheck.
- The `typograf` npm package is trusted at the pinned version. It runs in-process; it is not a subprocess.

## Residual risks

- A manuscript from another person can make Pandoc read local files that it references, or make network requests.
  Check such a manuscript before the build.
- Raw Typst blocks in the manuscript (` ```{=typst} `) go into the PDF markup without a change.
  Such a block can import a typst package with `@preview/…`. typst then downloads the package from the
  typst package registry and runs it inside the typst compiler. Pandoc output without raw Typst blocks has no imports.
  The `--root` limit still applies: a package cannot read files outside the private PDF directory.
- typst reads the installed system fonts. A font selected with `mainfont` must be installed.
- Another process of the same user can change files during the run. The checks make the time window small but do not remove it.
- EPUBCheck is optional. Without it, an EPUB file is not validated.
  A found EPUBCheck that cannot start, stops on a signal, or exceeds the time limit stops the build.
- Typograf Core matches text with regular expressions, not a Markdown parser. An enabled rule can still
  change text inside a fenced or inline code block, a link title, or an HTML attribute if it matches the
  rule's pattern. For example, `literary-markdown` puts non-breaking spaces into code and changes a YAML
  end marker `...` into `…`. Review the formatted file with `git diff` before publishing a book.
- Typograf Core runs in the CLI process without a time limit. The manuscript size limit (64 MB) bounds the work.
  A 4 MB manuscript takes less than one second with the `default` profile.

## Distribution

The package contains the compiled modules, `assets/epub.css`, `assets/pdf.yaml`, `assets/reference.docx`, `assets/scene-breaks.lua`, `README.md`, `SECURITY.md`, and `LICENSE`.
The assets contain no author, title, identifier, or other book data.
The package has one runtime dependency, `typograf`, pinned to an exact version, and no installation scripts.
No manuscript, whitelist, or other user data is bundled into the package.
