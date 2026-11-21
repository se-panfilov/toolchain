# reBook

reBook builds an electronic book from one Markdown manuscript.
It runs Pandoc and makes EPUB, DOCX, and HTML files.
It also makes a new `metadata.yaml` file for a book.
The manuscript does not change. The results go into an output directory.
The user interface uses Russian.

Use [SECURITY.md](SECURITY.md) for security controls and limits.

## Requirements

- Node.js 24.12 or later.
- Pandoc 3.0 or later: `brew install pandoc`.
- Optional: EPUBCheck: `brew install epubcheck`. Without it, the EPUB check is skipped.
  An installed EPUBCheck that cannot start or exceeds the time limit stops the build.
- An ANSI terminal for the interactive mode.

macOS is the main platform. Linux also works. On Windows, the EPUB check is skipped.

## Start

Run the published package:

```sh
npx tx-rebook
npx tx-rebook init
npx tx-rebook build "book.md"
```

Run the local build from the Toolchain root:

```sh
npm ci --ignore-scripts
npm run start --workspace tx-rebook
npm run start --workspace tx-rebook -- build "/path/to/book.md"
```

The start script builds the application before it starts `dist/src/cli.js`.
A build failure stops the start.

Without a command, the program shows a menu: build a book or make `metadata.yaml`.
When `metadata.yaml` is not in the current directory, the menu selects the second item.

## Make metadata.yaml

`tx-rebook init` asks for these values:

| Field          | Default                                        | Rule                                     |
| -------------- | ---------------------------------------------- | ---------------------------------------- |
| `title`        | none                                           | Necessary.                               |
| `creator.text` | none                                           | Necessary. The role is `author`.         |
| `lang`         | `ru-RU`                                        | A BCP 47 language code, such as `en-US`. |
| `description`  | empty                                          | Optional.                                |
| `rights`       | `Unpublished manuscript. All rights reserved.` | Optional.                                |

The program makes `identifier` itself: `urn:uuid:` and a random UUID version 4.
EPUB 3 requires a unique `dc:identifier` that does not change between versions of the same book.
Without an ISBN or a DOI, a UUID in the `urn:uuid:` form is the usual identifier.
Keep this value for all later versions of the book. Make a new value only for a different book.

`date` and `version` stay empty. The build asks for them.
Empty optional fields stay as YAML comments, because Pandoc writes empty EPUB elements for empty values.
The program never replaces an existing file.

| Option               | Purpose                                                         |
| -------------------- | --------------------------------------------------------------- |
| `--metadata PATH`    | The new file. The default is `metadata.yaml`.                   |
| `--title TEXT`       | The book title.                                                 |
| `--author TEXT`      | The author.                                                     |
| `--lang CODE`        | The language. The default is `ru-RU`.                           |
| `--description TEXT` | The description. Use `--description=` for an empty value.       |
| `--rights TEXT`      | The rights statement. Use `--rights=` for an empty value.       |
| `--dry-run`          | Shows the file text and does not write it.                      |
| `-y`, `--yes`        | Runs without questions. `--title` and `--author` are necessary. |

## Build a book

`tx-rebook build` asks only for the values that the options do not give.

| Option                 | Purpose                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `FILE`                 | The Markdown manuscript. If the directory has one `.md` file, it is the default.   |
| `--metadata PATH`      | The metadata file. The default is `metadata.yaml` in the current directory.        |
| `--output DIRECTORY`   | The output directory. The default is `build`.                                      |
| `--cover PATH`         | The EPUB cover: JPEG, PNG, GIF, or WebP. Without it, EPUB has no cover.            |
| `--css PATH`           | A CSS file for EPUB and HTML in place of the default file.                         |
| `--reference-doc PATH` | A DOCX style template in place of the default `reference.docx`.                    |
| `--formats LIST`       | Formats with commas: `epub`, `docx` (or `word`), `html`. The default is all three. |
| `--mode MODE`          | `beta` (default) or `production`.                                                  |
| `--book-version X`     | The book version in SemVer form.                                                   |
| `--book-date DATE`     | The book date in `YYYY-MM-DD` form.                                                |
| `--overwrite`          | Replaces result files that exist.                                                  |
| `--dry-run`            | Shows the plan and the Pandoc commands in shell quoting. No file is written.       |
| `-y`, `--yes`          | Runs without questions. `FILE` is necessary.                                       |
| `--`                   | Ends the options. Use it for a file name that starts with `-`.                     |

Options accept `--name value` and `--name=value`.
A repeated, unknown, or empty option stops the program before it reads a file.
`--formats` also accepts other output formats of the installed Pandoc, such as `odt`. They get no special options.

The build does these steps:

1. It reads and checks the metadata with Pandoc.
2. It asks for the version and the date. The current values are the defaults.
3. It shows the plan and asks for confirmation.
4. It makes each format in a private temporary directory.
5. It runs EPUBCheck on each EPUB file. An EPUBCheck error stops the build.
6. It puts the results into the output directory.
7. It writes a new `version`, `ibooks.version`, or `date` into `metadata.yaml`, if they changed.

Steps 6 and 7 are one operation. If step 7 fails, the earlier result files come back.
A failure before step 6 does not change the output directory or `metadata.yaml`.
In a dry-run without `metadata.yaml`, the program shows the new file and stops. It does not write the file.
Empty text fields in `metadata.yaml` stop the build. Fill or remove them.

File names have the form `<title> - beta - <version>.<extension>`.
A production build has no `beta` part. Dots in the version become `_`.

### Beta and production

A beta build adds a notice at the start of the book: the title, `Beta <version>`, the build date, and a draft warning.
The notice uses Russian for a Russian book and English for other languages.
The beta EPUB has no Pandoc title page.
The manuscript does not change. The program writes the changed text into a temporary file.

### Default styles

The package contains `assets/epub.css`, `assets/reference.docx`, and `assets/scene-breaks.lua`.
These files contain no book data.

`reference.docx` must contain these paragraph styles for the semantic blocks:
`Scene Break`, `First Paragraph`, `Book Page`, `Book Page Title`, `Book Page Subheading`, `Story Title`, `Interlude Title`.

The HTML file contains the CSS, the images, and the other resources. It does not need other files.

## Manuscript structure

The Lua filter supports these Markdown blocks:

| Markdown                         | Meaning                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| `\*\*\*` in a separate paragraph | A scene break. It becomes a centered `* * *` block, not a horizontal rule.  |
| `# Name {.story-title}`          | A story title. It starts a new page.                                        |
| `# ❦ {.interlude-title}`         | An interlude title. The EPUB table of contents adds a hidden `Interlude N`. |
| `::: {.book-page}` … `:::`       | A separate book page, such as the title page of a part.                     |

The paragraph after a scene break or a title has no first-line indent.
A scene break next to a level 1 heading or a book page is removed.

```markdown
::: {.book-page}

# Part one

## The first steps

:::

# I {.story-title}

The first paragraph.

\*\*\*

The next scene.

# ❦ {.interlude-title}

The interlude.
```

## Use without questions

```sh
tx-rebook init --yes --title "Title" --author "Author"
tx-rebook build book.md --yes --book-version 0.1.0 --book-date 2024-01-02 --cover cover.png
```

Without questions, stdout contains only the paths of the results, one in each line.
Messages, Pandoc warnings, and errors go to stderr.
Without `--book-version` and `--book-date`, the values from `metadata.yaml` are used. An empty value stops the build.
The program never replaces a result file without `--overwrite`.

## Results and recovery

- The manuscript, the cover, and the style files do not change.
- The program writes into `metadata.yaml` only `version`, `ibooks.version`, and `date`, and only after a successful build.
  It changes only the top-level `version` and `date` lines and the `version` line directly under a top-level `ibooks:`.
  Each value must be on one line. Pandoc reads the file before and after the change. A change of another field stops the build before it writes files.
  It shows the old values before the build. To go back, write the old values into the file.
- `metadata.yaml` must be a regular file without other hard links for this update. Use version control to keep its history.
- A result file is replaced only with `--overwrite` or after a confirmation. The new file gets the permission bits of the old file.
  Keep copies of earlier results if you need them.
- The program does not delete files in the output directory and does not add files to Git.
- Ctrl+C stops the build. The temporary directory is deleted.

## Package structure

| Path              | Content                                             |
| ----------------- | --------------------------------------------------- |
| `src/cli.ts`      | Arguments, help, and the menu.                      |
| `src/flows.ts`    | The `init` and `build` procedures.                  |
| `src/metadata.ts` | The metadata template, checks, and the update.      |
| `src/book.ts`     | Formats, file names, Pandoc arguments, and results. |
| `src/tools.ts`    | Pandoc and EPUBCheck search and start.              |
| `src/prompts.ts`  | Terminal questions.                                 |
| `assets/`         | The default CSS, DOCX template, and Lua filter.     |

## Checks

```sh
npm test --workspace tx-rebook
npm run build --workspace tx-rebook
node apps/reBook/dist/src/cli.js --help
```

Tests that start Pandoc are skipped when Pandoc is not installed.
