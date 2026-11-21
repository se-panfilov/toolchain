# reBook

reBook builds an electronic book from one Markdown manuscript.
Before Pandoc runs, Typograf Core applies a small, explicit set of Russian typography rules to the
manuscript and writes the result into a sibling `*.formatted.md` file. Pandoc then builds EPUB, DOCX,
HTML, FB2, and PDF from that formatted file.
It also makes a new `metadata.yaml` file for a book.
The manuscript does not change. The results go into an output directory.
The user interface uses Russian.

Use [SECURITY.md](SECURITY.md) for security controls and limits.

## Requirements

- Node.js 24.12 or later.
- Pandoc 3.0 or later: `brew install pandoc`.
- For PDF: typst (`brew install typst`) and Pandoc 3.2 or later. Without them, the default format list has no PDF, and an explicit PDF request stops the build.
- Optional: EPUBCheck: `brew install epubcheck`. Without it, the EPUB check is skipped.
  An installed EPUBCheck that cannot start or exceeds the time limit stops the build. So does an `epubcheck` file without the execute permission.
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

| Option                    | Purpose                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FILE`                    | The Markdown manuscript. If the directory has one `.md` file, it is the default. A generated `*.formatted.md` file never counts as this default. |
| `--metadata PATH`         | The metadata file. The default is `metadata.yaml` in the current directory.                                                                      |
| `--output DIRECTORY`      | The output directory. The default is `build`.                                                                                                    |
| `--cover PATH`            | The EPUB and FB2 cover: JPEG, PNG, GIF, or WebP. Without it, EPUB and FB2 have no cover.                                                         |
| `--css PATH`              | A CSS file for EPUB and HTML in place of the default file.                                                                                       |
| `--reference-doc PATH`    | A DOCX style template in place of the default `reference.docx`.                                                                                  |
| `--formats LIST`          | Formats with commas: `epub`, `docx` (or `word`), `html`, `fb2`, `pdf`. The default is all five, or all but `pdf` without typst.                  |
| `--mode MODE`             | `beta` (default) or `production`.                                                                                                                |
| `--book-version X`        | The book version in SemVer form.                                                                                                                 |
| `--book-date DATE`        | The book date in `YYYY-MM-DD` form.                                                                                                              |
| `--typograf-rules PATH`   | A Typograf Core whitelist file in place of the one next to the manuscript.                                                                       |
| `--typograf-profile NAME` | `default` or `literary-markdown`. Used only to build a whitelist that does not exist yet.                                                        |
| `--overwrite`             | Replaces result files that exist.                                                                                                                |
| `--dry-run`               | Shows the plan and the Pandoc commands in shell quoting. No file is written.                                                                     |
| `-y`, `--yes`             | Runs without questions. `FILE` is necessary.                                                                                                     |
| `--`                      | Ends the options. Use it for a file name that starts with `-`.                                                                                   |

Options accept `--name value` and `--name=value`.
A repeated, unknown, or empty option stops the program before it reads a file.
`--formats` also accepts other output formats of the installed Pandoc, such as `odt`. They get no special options.
The name `typst` selects the Pandoc Typst writer and gives a `.typst` markup file, not a PDF.

### FB2 and PDF

All formats are selected by default, in the format question and without `--formats`.
PDF needs typst and Pandoc 3.2 or later. Without them, the question shows PDF without a check mark and
with the reason, such as `PDF (нужен typst)`. A run without `--formats` builds the other formats and
shows a warning. `--formats pdf` without them stops the build.

FB2 gets the cover from `--cover`. FB2 readers usually show only JPEG and PNG covers; for GIF and WebP the program shows a warning.
A horizontal rule (`***` without escapes) becomes a `* * *` paragraph in FB2, because FB2 shows a rule as an empty line.

PDF has two steps. Pandoc writes Typst markup into a private directory and copies the images there.
Then typst makes the PDF from that markup. The default page is A5 with 2 cm margins and an 11 pt font.
The page settings come from `assets/pdf.yaml`. To change them, add the same fields to `metadata.yaml`:

```yaml
papersize: a4
margin:
  x: 2.5cm
  y: 2cm
fontsize: 12pt
mainfont: 'PT Serif'
```

The fonts built into typst contain Cyrillic letters. `mainfont` selects an installed system font.
FB2 and PDF have no other style options: `--css` and `--reference-doc` do not apply to them.

EPUB reads authors from `creator` entries. For FB2 and PDF, the Lua filter copies the `creator` entries
with the `author` role, or without a role, into `author`, if `metadata.yaml` has no `author` field.

The build does these steps:

1. It reads and checks the metadata with Pandoc.
2. It asks for the version and the date. The current values are the defaults.
3. It finds the Typograf Core whitelist, or selects a profile for a new one (see below).
4. It shows the plan and asks for confirmation.
5. It runs Typograf Core once over the manuscript in a private temporary directory.
6. It makes each format from the formatted text in the same directory. For PDF, typst makes the PDF from Pandoc's Typst markup.
7. It runs EPUBCheck on each EPUB file. An EPUBCheck error stops the build.
8. It puts the results, `*.formatted.md`, and a new whitelist into place.
9. It writes a new `version`, `ibooks.version`, or `date` into `metadata.yaml`, if they changed.

Steps 8 and 9 are one operation. If step 9 fails, the earlier files come back and new files are removed.
A failure or a cancellation before step 8 changes no file: not the output directory, not `*.formatted.md`,
not `metadata.yaml`, and no new whitelist is written.
In a dry-run without `metadata.yaml`, the program shows the new file and stops. It does not write the file.
Empty text fields in `metadata.yaml` stop the build. Fill or remove them.

File names have the form `<title> - beta - <version>.<extension>`.
A production build has no `beta` part. Dots in the version become `_`.

### Typograf Core

Before Pandoc runs, the build applies [Typograf Core](https://github.com/typograf/typograf) 7.9.1 to the
manuscript text and writes the result into a sibling file: `book.md` becomes `book.formatted.md`.
Every Typograf Core rule starts disabled. Only the rule names listed in a whitelist file turn on, so an
update of the dependency cannot silently enable a new rule.

The whitelist is a JSON file, `typograf.rules.json` by default, next to the manuscript:

```json
{
  "schemaVersion": 1,
  "locale": "ru",
  "enabledRules": ["common/punctuation/hellip", "ru/dash/izpod"]
}
```

`--typograf-rules PATH` points to a whitelist file in another place.
`--typograf-profile default|literary-markdown` builds a whitelist only when one does not exist yet.
It has no effect on an existing file; the program prints a warning instead of replacing it.

When the manuscript has no whitelist next to it:

- In an interactive run, the program asks the user to choose a profile. It writes the file with the results of a successful build.
- With `--yes` and `--typograf-profile`, the program writes the file with the results, without a question.
- With `--yes` and no `--typograf-profile`, the build stops with an error. It never guesses a profile.

Two built-in profiles are available:

| Profile             | Rules | Purpose                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`           | 85    | The rules that Typograf Core 7.9.1 enables by default for the `common` and `ru` locales.                                                                                                                                                                                                                                                                                                                             |
| `literary-markdown` | 10    | A conservative set for Russian fiction: an ellipsis, a UTF-8 BOM removal, a non-breaking space after a word of one or two letters (`в доме`, `и так`), and a small, closed list of Russian dash words (`из-за`, `из-под`, `кое-`, `кто-то`, `как-то`, `-таки`, `-то`). The non-breaking space replaces only one ordinary space between two words. Blank lines, line breaks, indents, and list markers do not change. |

`default` is not aware of Markdown. It can change text inside a fenced or inline code block, a link
title, or an HTML attribute, because Typograf Core matches text with regular expressions, not a
Markdown parser. Use `literary-markdown` or a custom whitelist for a manuscript where this risk
matters. `literary-markdown` has the same limit on a smaller scale: it puts non-breaking spaces into
inline and fenced code, and it changes a YAML end marker `...` into `…`. End a YAML block with `---`.
The non-breaking spaces are U+00A0 characters, not `&nbsp;` entities. Neither profile is a full implementation of Russian typography; both only apply the rules
they name.

The formatted file is always replaced on a successful run, independently of `--overwrite`, which
only controls the result files. It never gets wider permission bits than the
manuscript: a manuscript with mode `0600` gives a formatted file with mode `0600`.
A failed run does not change the formatted file, and the build never reads an old formatted file.

A `*.formatted.md` or `*.formatted.markdown` name is rejected as manuscript input (`FILE` or the
directory default), so the program cannot read its own generated output as the source by mistake.

Compare the source and the formatted text after a build:

```sh
git diff --no-index --word-diff=plain manuscript.md manuscript.formatted.md
```

### Beta and production

A beta build adds a notice at the start of the book: the title, `Beta <version>`, the build date, and a draft warning.
The notice uses Russian for a Russian book and English for other languages.
The beta EPUB has no Pandoc title page. The notice itself is added after Typograf Core runs, so it is
never formatted.
The manuscript does not change. The program writes the changed text into a temporary file.

### Default styles

The package contains `assets/epub.css`, `assets/pdf.yaml`, `assets/reference.docx`, and `assets/scene-breaks.lua`.
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
tx-rebook build book.md --yes --book-version 0.1.0 --book-date 2024-01-02 --cover cover.png --typograf-profile literary-markdown
```

Without a whitelist next to the manuscript and without `--typograf-profile`, `--yes` stops the build
with an error instead of asking a question.

Without questions, stdout contains only the paths of the results, one in each line.
Messages, Pandoc warnings, errors, and the Typograf Core configuration summary go to stderr.
Without `--book-version` and `--book-date`, the values from `metadata.yaml` are used. An empty value stops the build.
The program never replaces a result file without `--overwrite`.

## Results and recovery

- The manuscript, the cover, and the style files do not change.
- The formatted manuscript, `*.formatted.md`, is replaced on every successful build, independently of
  `--overwrite`. It is a derived file: review it with `git diff` and do not edit it by hand.
- The program writes into `metadata.yaml` only `version`, `ibooks.version`, and `date`, and only after a successful build.
  It changes only the top-level `version` and `date` lines and the `version` line directly under a top-level `ibooks:`.
  Each value must be on one line. Pandoc reads the file before and after the change. A change of another field stops the build before it writes files.
  It shows the old values before the build. To go back, write the old values into the file.
- `metadata.yaml` must be a regular file without other hard links for this update. Use version control to keep its history.
- A result file is replaced only with `--overwrite` or after a confirmation. A confirmation covers only the files in the plan.
  The new file gets the permission bits of the old file. A file with an ACL is not replaced.
  Keep copies of earlier results if you need them.
- The program does not delete files in the output directory and does not add files to Git.
- Ctrl+C stops the build. The temporary directory is deleted.

## Package structure

| Path              | Content                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `src/cli.ts`      | Arguments, help, and the menu.                                       |
| `src/flows.ts`    | The `init` and `build` procedures.                                   |
| `src/metadata.ts` | The metadata template, checks, and the update.                       |
| `src/book.ts`     | Formats, file names, Pandoc arguments, and results.                  |
| `src/typograf.ts` | Typograf Core profiles, the whitelist, and the formatted manuscript. |
| `src/tools.ts`    | Pandoc, typst, and EPUBCheck search and start.                       |
| `src/prompts.ts`  | Terminal questions.                                                  |
| `assets/`         | The default CSS, DOCX template, PDF page settings, and Lua filter.   |

## Checks

```sh
npm test --workspace tx-rebook
npm run build --workspace tx-rebook
node apps/reBook/dist/src/cli.js --help
```

Tests that start Pandoc are skipped when Pandoc isn't installed.
Most PDF tests use a synthetic typst. The test with a real typst is skipped when typst isn't installed.
