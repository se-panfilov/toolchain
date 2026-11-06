# reHistory

reHistory changes the metadata of commits in the current Git branch.
Each run does one of three flows: commit dates, commit authors, or commit messages.
It can make an export without changes to the source repository.
The user interface uses Russian.

Use [TERMINOLOGY.md](TERMINOLOGY.md) for technical terms and documentation rules.
Use [SECURITY.md](SECURITY.md) for security controls and limits.

## Package structure

| Path                | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `src/`              | TypeScript application modules.                                  |
| `test/`             | Vitest unit, integration, and build regression tests.            |
| `scripts/build.mjs` | Type checking, Vite build, and safe output publication.          |
| `dist/src/`         | Compiled runtime modules for local execution and npx.            |
| `tsconfig.json`     | Application paths and aliases extending the shared base.         |
| `vite.config.mjs`   | Application entries and namespace using the shared CLI preset.   |
| `vitest.config.mjs` | Application root and alias mapping using the shared test preset. |

Shared tool versions and the only lockfile belong to the Toolchain root.
Shared configuration is in `configs/` at that root.
Run dependency installation from the Toolchain root.

The package is a CLI without a public import API.
Its exports map is empty.
Source module imports use `@reHistory/*`.
For example, `@reHistory/engine` resolves `src/engine.ts` during the Vite build.
Vitest shares the Vite alias configuration.
The tsconfig paths mapping resolves the same source for type checks.
Vite converts these aliases to relative JavaScript imports in `dist/`.
The installed package needs no source aliases or custom loader.

## Safety

**CAUTION: Keep a complete repository copy in a different location before you change a repository.**
A changed history has different object IDs.

**CAUTION: Stop other Git operations before you start this program.**
Close Git tools that can change the same repository.

**CAUTION: Push the current branch before a history change.**
The server copy keeps the initial history if a local change goes wrong.

Changed dates do not show the time of the work.
Other copies can keep the initial dates.
Files, messages, tag names, and submodules can also contain dates.
The program does not examine file contents for these dates.
You can replace commit messages with one selected message.
You can replace the names and email addresses of all authors and committers.

## Requirements

- Node.js 24.12 or later.
- Git 2.39 or later.
- An ANSI terminal for a history change or an export.
- A complete repository with a local branch that contains a commit.
- Git in an absolute PATH directory. Empty and relative PATH entries are ignored.
- No configured clean, process, or smudge filters for rewrite and export.
- For a history change, branch commits in a remote-tracking ref, or an explicit confirmation without remote-tracking refs.

macOS is the test platform.
Native Linux and Windows checks are configured in CI.
Local verification does not establish results for those platforms.
Local development requires the locked build dependencies.
The published package has no runtime dependencies.

An interactive terminal is not necessary for the audit, export check, or demo.
The interactive modes do not operate with `TERM=dumb`.

## Command paths

Replace the example paths with your paths.
Put paths that contain spaces in double quotes.

Install build dependencies from the Toolchain root:

```sh
cd /path/to/toolchain
npm ci --ignore-scripts
npm run build --workspace tx-rehistory
```

Compile the application before execution.
Local execution and npx use the same entry point, `dist/src/cli.js`.
Rebuild after source changes.
From the Toolchain root, use `npm run start --workspace tx-rehistory -- --help` to build and run the application.
A build error stops this command before application startup.

Without `--repo`, the program uses the current process directory.
If this directory is a subdirectory of a working tree, the program uses the top-level directory of that working tree.
An npm workspace script runs in the application directory.
Supply `--repo /path/to/project` when you start through an npm script.

```sh
node /path/to/toolchain/apps/reHistory/dist/src/cli.js --help
```

## Audit procedure

1. Start the audit.

   ```sh
   node /path/to/toolchain/apps/reHistory/dist/src/cli.js --repo /path/to/project --audit
   ```

2. Read the report.

The audit does not write files or Git objects.
You can use it with a dirty working tree, a stash, or detached HEAD.

The report includes these items:

- All local refs, including hidden refs and remote-tracking refs.
- Loose symbolic refs whose targets are missing. These make the audit incomplete.
- Commit dates and tagger dates in the available object store.
- Objects not reachable from the current branch.
- Unreachable objects and reflog entries.
- Backup refs, recovery files, and a lock file.
- Shallow clone data, partial clone data, grafts, and alternates.
- Additional worktrees and not complete Git operations.
- Submodule entries at the current HEAD.

The report gives timestamps in Unix seconds with the initial time zone offset.
It does not examine the server.
The audit does not get missing objects from the network.

For a JSON report, use this command:

```sh
node /path/to/toolchain/apps/reHistory/dist/src/cli.js --repo /path/to/project --audit --json
```

The JSON fields include `refs`, `commits`, `tags`, `reflog`, `unreachable`, `metadata`, and `warnings`.
The report can contain personal data.
Keep report files in a location with restricted access.

## History change procedure

**CAUTION: Do a dry-run first.**
The dry-run gives a plan without writes.

1. Start the dry-run.

   ```sh
   node /path/to/toolchain/apps/reHistory/dist/src/cli.js --repo /path/to/project --dry-run
   ```

2. Select one flow at `Что переписать?`.
3. Enter the required values.
4. Do a check of the plan.
5. Start the program without `--dry-run`.

   ```sh
   node /path/to/toolchain/apps/reHistory/dist/src/cli.js --repo /path/to/project
   ```

6. Select the same flow and enter the same values again.
7. If the plan is correct, select Yes to give permission for the change.
8. Push the result before you start a different flow.

### Flows

One run changes one type of metadata.
The program asks only the questions of the selected flow.

| Flow (`Что переписать?`) | Changes                                    | Keeps                                            |
| ------------------------ | ------------------------------------------ | ------------------------------------------------ |
| `Время коммитов`         | Author and committer dates, and tag dates. | Identities, messages, and taggers.               |
| `Авторы коммитов`        | Author and committer names and emails.     | Dates, time zones, messages, and tag dates.      |
| `Сообщения коммитов`     | All commit messages.                       | Dates, time zones, identities, and all tag data. |

To change more than one type of metadata, run the flows one after the other.
Push the result of each flow before you start the next flow.

These questions are the same for all flows:

| Item                | Initial value               | Effect                                                   |
| ------------------- | --------------------------- | -------------------------------------------------------- |
| Flow                | `Время коммитов`            | Select the type of metadata to change.                   |
| Backup              | Yes                         | Keep the initial branch and the selected tags.           |
| Backup branch       | `rehistory-backup/original` | Stop if there is a branch with this name.                |
| Final push          | No                          | Offer a separate server operation after a local rewrite. |
| Permission to write | No                          | Write only after a specified Yes.                        |

The `Время коммитов` flow asks these questions:

| Item            | Initial value | Effect                                                 |
| --------------- | ------------- | ------------------------------------------------------ |
| Commit interval | `1` second    | Use an integer from 1 to 31536000.                     |
| First date      | Today         | Use `YYYY-MM-DD`.                                      |
| First time      | `00:00:00`    | Use local time unless you add an offset.               |
| Tag date change | Yes           | Set each annotated tag date to its target commit date. |

The `Авторы коммитов` flow asks these questions:

| Item                   | Initial value | Effect                                                  |
| ---------------------- | ------------- | ------------------------------------------------------- |
| Name                   | Empty         | Use 1 to 200 characters without `<`, `>`, and controls. |
| Email                  | Empty         | Use the format `name@example.org`.                      |
| Same identity for tags | Yes           | Replace the tagger name and email of the selected tags. |

The program does not get an identity from Git config.
If you select No for tags, taggers do not change.
Tag dates do not change in this flow.

The `Сообщения коммитов` flow asks one question:

| Item        | Initial value | Effect                                                 |
| ----------- | ------------- | ------------------------------------------------------ |
| New message | Empty         | Replace all selected commit messages with one message. |

If the plan does not change an object, the program stops before the write.
It shows `Изменений нет` and makes no backup.

### Remote copy check

Before a history change, the program compares the current branch with the remote-tracking refs (`refs/remotes/*`).
It reads only local refs. It does not connect to a server.

| State                                                 | Result                                                    |
| ----------------------------------------------------- | --------------------------------------------------------- |
| All branch commits are in a remote-tracking ref.      | The program continues.                                    |
| Some branch commits are not in a remote-tracking ref. | The program stops before the first question.              |
| The repository has no remote-tracking refs.           | The program asks `Продолжить без копии на сервере?` (No). |

A dry-run shows these warnings and continues without a question.
An export does not do this check, because it does not change the source.
Uncommitted changes always stop a history change and an export.

To continue after a stop, push the branch.
If you pushed with a different tool, run `git fetch` to update the remote-tracking refs.
Remote-tracking refs can be out of date. The program cannot see server changes after the last fetch or push.

You can change the backup branch name.
The program does not add a date, time, or counter to this name.
If a branch has the selected name, the program stops.
It does not replace the branch.

### Date and time

The input has different fields for the date and time.
These time formats are permitted:

| Example          | Meaning                            |
| ---------------- | ---------------------------------- |
| `18:30`          | Local time with zero seconds.      |
| `18:30:45`       | Local time with specified seconds. |
| `18:30:45+01:00` | Time with a specified UTC offset.  |
| `17:30:45Z`      | UTC time.                          |

If a local time does not exist during a clock change, the program rejects it.
Use a specified offset for a local time that occurs twice.
The permitted UTC range is 1970 through 9999.
The program writes new dates in UTC.
The last commit can have a future date.

### Terminal controls

The initial answer has a selected checkbox.
The Yes label is `Да`.
The No label is `Нет`.
The markers are `☑` and `☐`.

- Use the arrow keys to move the focus.
- Use Space to select one answer.
- Use Enter to accept the selected answer.
- Use Esc to cancel a checkbox question.
- Use Ctrl+C to cancel an input question.

Movement of the focus does not select an answer.
Digits do not give permission to write.

A text field contains its initial value.
You can edit or remove this value.
Ctrl+U clears the line.
If you clear the line, the program gives an empty value to the validator.
It does not insert the removed value again.

The input fields do not keep a readline history.
The program restores the terminal state after a question.

The terminal uses color for questions, results, warnings, and errors.
Selection is visible without color.
`NO_COLOR` or `FORCE_COLOR=0` disables color.
Pipe output and JSON reports contain no color codes.

### Change scope

The program changes all commits reachable from the current local branch.
It also changes tags whose target commits are in that history.
Other branches and remote-tracking refs keep their values.
Tags not in that history keep their values.
Tags that point to blobs or trees also keep their values.

A tag is different from a branch.
A tag on a shared ancestor can change although another branch stays with no changes.

The program keeps trees, file contents, empty commits, and the order of parent links.
It keeps commit messages unless you select the `Сообщения коммитов` flow.
The replacement is nonempty UTF-8 text with a final newline.
Input is limited to 64 KiB and cannot contain hidden control characters.
The engine also accepts line breaks and tabs.
The terminal question accepts one line.
Old encoding headers are removed when messages change.

In the `Время коммитов` flow, the program puts each parent before its child in the date sequence.
Each pair of adjacent commits has the selected interval.
A parent and child can have a larger interval in a merge graph.
The author date and committer date are equal for each new commit.

The `Авторы коммитов` and `Сообщения коммитов` flows keep each initial date and UTC offset.
The program keeps each initial identity unless you select the `Авторы коммитов` flow.

The program keeps annotated tag names and messages.
It changes the target object and the tagger fields of the selected flow.
In the `Время коммитов` flow, a nested tag uses the date of its target commit.
As an alternative, you can keep the initial tagger date and offset.
A tag without a tagger causes the program to stop.

A changed commit or tag gets a new object ID, so its initial signature becomes invalid.
The program cannot make new signatures. Thus a change is possible only without signatures.
If there are signatures, the plan shows their number and the question `Удалить подписи и продолжить?`.
The initial answer is No. No stops the program without a change.
It removes `gpgsig`, `gpgsig-sha256`, `mergetag`, and standard tag signature blocks.
It does not make new signatures.
Ambiguous, nested, or multiple signature blocks stop plan creation.
The program does not discard text between signature markers.

The plan shows all selected refs.
It shows 12 characters of each object ID.
Git operations and recovery files use complete object IDs.

The normal mode does not change working files or the index.
It sends no data unless you separately select the final push.
It does not remove reflog entries or old objects.

## Optional push procedure

The push question appears after a successful local rewrite.
It does not appear after a dry-run, export, audit, or demo.
The initial answer is No.
No server request occurs when you keep this answer.

1. Select Yes at `Сделать push?`.
2. Select a configured remote if there is more than one.
3. Examine the destination URL and the complete list of refs.
4. If the program shows tags for a separate decision, examine them. Select Yes at `Отправить и эти теги?` only if you want to send them.
5. Select Yes at the final question to send the refs.

The first Yes permits a read of server refs.
The final Yes permits the push.
All questions initially select No.

These tags need a separate decision:

| Reason in the list                  | Condition                                                                                    | Risk if you send the tag                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `есть в других ветках`              | Another local branch, remote-tracking ref, or server branch contains the initial tag target. | The server tag moves out of the history of that branch, such as `master`. |
| `другие ветки сервера не проверены` | The local repository does not have the commit of another server branch.                      | The tag can move out of the history of that branch.                       |
| `нет на сервере`                    | The server does not have the tag.                                                            | The tag becomes public.                                                   |

The current branch, its remote-tracking refs, and the push destination do not count as other branches.
The program does not fetch missing server commits. Run `git fetch` before the run to let the program examine all server branches.
If you keep No, the program does not send these tags.
They stay rewritten in the local repository.
The plan also shows the number of tags that other branches contain before you apply the change.
A missing remote stops this optional step.
The program does not add a remote.

The push contains the current branch and its selected tags, except tags for a separate decision that you did not select.
The destination has the current branch name, as with `push.default=simple`.
The program does not use an upstream branch with a different name as the destination.
For example, a push of a feature branch with the upstream `master` does not change `master` on the server.
Backup refs, other branches, and other tags are excluded.
The program does not delete server refs.

After a successful push, the program updates the remote-tracking branch of the destination.
This is the same result as `git push <remote>`.
The update occurs only for the standard fetch refspec `+refs/heads/*:refs/remotes/<remote>/*`.
For other refspecs, the program shows a warning. Run `git fetch` before the next flow.

Each destination has an explicit `--force-with-lease=<ref>:<expected-object-id>`.
The server branch must be absent, already rewritten, or part of the selected initial history.
An existing server tag must match its initial or rewritten object ID.
Unknown server changes stop preparation.
A later server change stops the atomic push.
There is no fallback without atomic support or leases.

The remote must have one HTTPS or SSH push URL.
SCP syntax, such as `git@host:owner/repo.git`, keeps its home-relative path.
URL substitutions, embedded credentials, redirects, and ambiguous paths are rejected.
Credential helpers and password prompts are disabled.
Use SSH with an existing key or agent for authenticated push.
GitHub and GitLab HTTPS authentication through credential helpers is not supported.
HTTPS is available only when the server permits the operation without those credentials.
Local `http.*` settings are rejected before network access, including URL-specific settings.
SSH configuration remains part of the trust boundary.

Hooks, automatic tag following, submodule pushes, mirror pushes, and inherited push options are disabled.
Local ref or configuration changes after preparation stop the push.
A push failure does not undo the completed local rewrite.
After a connection error, examine the server before another attempt.
The server might have accepted a push before its response was lost.

A push does not erase server backups, old objects, other refs, or other clones.
Git LFS hooks do not run.
Transfer external LFS objects separately if your repository uses them.

## Export procedure

**CAUTION: Use a new destination external to the source repository.**
The destination parent directory must exist.

1. Start the export dry-run.

   ```sh
   node /path/to/toolchain/apps/reHistory/dist/src/cli.js --repo /path/to/project --export /path/to/export.git --dry-run
   ```

2. Do a check of the plan.
3. Start the export without `--dry-run`.

   ```sh
   node /path/to/toolchain/apps/reHistory/dist/src/cli.js --repo /path/to/project --export /path/to/export.git
   ```

4. Select Yes only if the plan is correct.
5. Make sure that the result shows a correct export check.

The program does not change the source repository.
The export is a bare repository without a working tree.
A previous history change in the source is not necessary for an export.
If the destination path is present, the program stops.

The export contains only the selected branch and its selected tags.
It contains new commit and tag objects and the necessary trees and blobs.
An object can keep its ID if its contents are the same as the plan.

The export does not contain these source items:

- Other branches or tags.
- Remote config or remote-tracking refs.
- Backup refs, a stash, or a reflog.
- Recovery files or unreachable objects.
- Alternates or shared hard links.

The program copies object contents without a checkout.
It does not use source file links.
The program does not change submodule entries.
The export does not include the different submodule histories.

The file `rehistory-export.json` contains the new refs, object IDs, and the flow policy.
Manifest version 2 contains the flow and only the values of that flow.
The check still accepts version 1 manifests from earlier releases. They always describe a date change.
It does not contain old commit IDs, old tag IDs, or the source path.
On POSIX systems, the file has mode `0600`.

The export check compares the refs and the full object inventory with the plan.
It examines reachability, parent order, tag signatures, and the values of the flow.
For the `Время коммитов` flow, it examines the commit and tag dates.
For the `Авторы коммитов` flow, it examines the identities.
For the `Сообщения коммитов` flow, it examines the messages.
The export has no source data. The check cannot prove that other metadata stayed the same.
It rejects unexpected files, config entries, symbolic links, hard links, and special files.
The file check includes all nested directories.
Unexpected metadata stops verification before Git reads the object store.
The selected directory must contain its own HEAD, config, objects, and refs.
The check rejects Git discovery that selects a different repository directory.
The manifest rejects unknown fields, duplicate entries, and invalid identities.
HEAD and loose refs must contain only their expected values.
The config must contain only supported settings and values, without comments or duplicate keys.
It also uses strict Git fsck with only `fsck.zeroPaddedFilemode=ignore`.

If a check fails, the program keeps the not complete destination.
Do not publish that destination.
The program does not change the source repository.

### Repeat the export check

Use this command for another check:

```sh
node /path/to/toolchain/apps/reHistory/dist/src/cli.js --verify-export /path/to/export.git
```

Add `--json` for a JSON report.
This check does not write data.
The manifest has no digital signature.
If someone changes the manifest and the objects, this check can give an incorrect result.

The verifier also supports minimal pack/idx pairs and packed refs.
Pack filenames must match their embedded checksums.
Cached peeled tag targets must match the actual tag targets.
Other pack sidecars, commit graphs, server-info files, and maintenance metadata are rejected.
An ordinary Git repack can create such files.
If a changed export fails verification, make a new export or examine the reported metadata.
The verifier does not delete files to make a check pass.

To get a working tree, use this command:

```sh
git clone --no-local /path/to/export.git /path/to/working-copy
```

## Demo procedure

**CAUTION: Use a different empty server repository for the demo.**
The demo sends generated data to that server.

1. Prepare an empty repository on your server.
2. Prepare authentication without user input.
3. Start the demo with a specified server URL.

   ```sh
   node /path/to/toolchain/apps/reHistory/dist/src/cli.js --demo --demo-remote git@example.org:owner/empty-demo.git
   ```

4. Read the result.

Without `--demo-remote`, the program stops before file creation or network access.
The demo does not make a local server.
It makes a new source directory in the system temporary directory.
As an alternative, select a new directory with `--demo-dir /path/to/new-demo`.

The demo does these operations:

1. It makes sure that the server advertises no refs.
2. It makes 10 commits on main, with date intervals of 3 seconds.
3. It makes tags for main.
4. It sends main and its tags to the server.
5. It makes three other branches, each with two commits and tags.
6. It sends all generated branches and tags to the server.
7. It changes the main dates with the normal engine and automatic demo answers.
8. It does an audit of the source.
9. It makes an export of main and its three tags.
10. It does the export check and another audit.
11. It makes sure that server refs did not change after the local history change.
12. It writes `demo-result.json`.

The source has 16 commits, four branches, and nine tags before the history change.
The export has 10 commits and three tags.
The demo changes metadata dates without delays between commits.

Server branch names start with `rehistory-demo-<UUID>/`.
Tag names also have a unique prefix.
The demo uses specified refspecs and atomic push.
It does not use force push, mirror push, or ref deletion.
It does not send the changed history, backup refs, or export to the server.

The URL must use HTTPS, SSH, or the format `git@host:owner/repo.git`.
The program rejects credentials, query strings, fragments, spaces, and unsupported path characters in the URL.
It rejects file, git, HTTP, and ext protocols.

An SSH key and a known host key are necessary.
It uses `BatchMode=yes`.
Use SSH for authenticated demo writes to GitHub or GitLab.
HTTPS requires a server that permits these writes without credential helpers or password prompts.
Local `http.*` settings are not supported.
The program keeps TLS checks and rejects HTTPS redirects.
Atomic push must be available on the server.

If the demo stops after server writes, those writes do not change.
The program keeps the demo files.
Remove server data yourself only after a check.
The program cannot examine refs that the server does not advertise.

## Recovery procedure

**CAUTION: Stop other Git operations before recovery.**
Make sure that the working tree and index are clean.

The backup branch keeps the initial branch tip.
Backup refs have the format `refs/rehistory/backups/<UUID>/...`.
The recovery file has the format `rehistory-recovery-<UUID>.json`.
Both names use random UUID v4 values without a timestamp.
The backup keeps the initial history and dates.

The recovery file contains `name`, `old`, and `new` for each selected ref.
It has mode `0600` on POSIX systems.
The program writes this file before it makes new objects.
The presence of the file does not show that the ref transaction completed.

1. Compare the refs in the repository with the recovery file.
2. Make a text file for the recovery transaction.

   ```text
   start
   option no-deref
   update <BRANCH_REF> <OLD_OID> <NEW_OID>
   option no-deref
   update <TAG_REF> <OLD_OID> <NEW_OID>
   prepare
   commit
   ```

3. Insert one `option no-deref` line before each `update` line.
4. Include every ref from the recovery file.
5. Replace each placeholder with the applicable field value.
6. Start the recovery transaction from the correct repository.

   ```sh
   git -c core.hooksPath= update-ref --stdin < /path/to/recovery-commands.txt
   ```

7. Do the integrity check.

   ```sh
   git fsck --strict
   ```

If a ref in the repository is different from `new`, stop.
Do not remove the expected object ID from the command.
This value prevents loss of commits made after the history change.
The backup refs stay in place after recovery.
A `reset --hard` operation is not necessary for metadata recovery.

Without backup refs, the recovery file contains only object IDs.
Garbage collection can remove the initial objects.
The recovery file cannot restore objects that are not available.

### A remaining lock file

1. Make sure that no reHistory process is active.
2. Read the PID in `rehistory.lock`.
3. Make sure that this PID does not identify an active reHistory process.
4. Keep the recovery file.
5. Examine the refs in the repository.
6. Remove the lock file only after these checks.

An existing lock error shows its PID when readable.
Ctrl+C is recorded during local application, including signals queued during JavaScript work.
The handler crosses the next poll phase before cleanup, including when keyboard input starts application.
After successful application and lock cleanup, interruption exits with code 130 without a push question.
The completed local rewrite remains saved.
An interrupted Git subprocess can still abort the atomic ref transaction.
Forced termination, a crash, or power loss can leave the lock.
Do not remove an active lock file.
The program does not remove another lock file automatically.

## Object validation and resource use

Rewrite and export check filters in initialized nested submodules before status.
The check accepts at most 256 working trees and requires UTF-8 index paths.

Commit or tag metadata containing NUL is not supported.
Planning rejects NUL in selected source commits before it writes data.
Generated metadata containing NUL is also rejected.
Other binary message bytes remain unchanged unless you select message replacement.
Git validates the metadata pack with `index-pack --strict` before the ref transaction.
The program does not bypass validation with `--literally`.

Export preserves historical tree modes with leading zeros, such as `040000`.
Content import and final verification ignore only the `zeroPaddedFilemode` diagnostic.
Other structural errors remain blocking.
Tree and blob bytes and their object IDs remain unchanged.

Planning reads commits in groups and computes object IDs in Node.js.
Applying a plan writes the generated metadata through one pack import.
Export transfers trees and blobs through a temporary pack file.
It does not capture complete blob contents in Node.js stdout buffers.
A file larger than 256 MiB can therefore be exported.
Git, available disk space, metadata limits, and verification can still limit large repositories.
Temporary packs use private directories and are removed after normal completion or handled errors.
Forced termination can leave temporary files.

JSON reports escape C1 and Unicode format controls.
Parsing the JSON restores the original values.

## Rejected source states

A history change and an export reject these states:

- A dirty index or working tree, including untracked files and changed submodules.
- Detached HEAD or a branch without a commit.
- A shallow clone or partial clone config, including a promisor entry set to false.
- Grafts or additional worktrees.
- Incomplete merge, rebase, cherry-pick, revert, sequencer, or bisect operations.
- Symbolic local branches or tags.
- Unsupported refs, including stash, notes, and replace refs.

A history change also rejects branch commits that are not in a remote-tracking ref.
See [Remote copy check](#remote-copy-check).

The program does not change ignored files.
You can use SHA-1 and SHA-256 repositories.
You can also use complete bare repositories.

The program can use `refs/codex/*` service refs.
It keeps their values and includes them in the audit.
These refs can keep the initial history.
The export excludes these refs.

## Exit codes

| Code  | Meaning                                           |
| ----- | ------------------------------------------------- |
| `0`   | The operation completed, or the user selected No. |
| `1`   | An error occurred, or the export check failed.    |
| `2`   | The audit inventory is not complete.              |
| `130` | The user canceled an interactive question.        |

An audit result of `0` does not show that all old dates are absent.
Read the warnings and object data in the report.

## Package preparation

The package has no runtime dependencies.
The npm package and bin name is `tx-rehistory`.
The source directory remains `apps/reHistory`.
After npm publication, use this command:

```sh
npx tx-rehistory --help
```

1. Open the Toolchain root.

   ```sh
   cd /path/to/toolchain
   ```

2. Install the locked build dependencies.

   ```sh
   npm ci --ignore-scripts
   ```

3. Do the tests.

   ```sh
   npm test --workspace tx-rehistory
   ```

4. Make the JavaScript build.

   ```sh
   npm run build --workspace tx-rehistory
   ```

5. Examine the package contents.

   ```sh
   npm pack --workspace tx-rehistory --dry-run
   ```

6. Make a local archive.

   ```sh
   npm pack --workspace tx-rehistory --pack-destination /path/to/package-directory
   ```

The build runs `tsc --noEmit` with the application tsconfig.json, then Vite.
That config extends `configs/tsconfig.base.json` at the Toolchain root.
Both stages complete before files enter `dist/`.
Vite alone does not check types.
The TypeScript configuration uses ES2023, ESNext modules, Bundler resolution, and Node.js types.
Vite targets Node.js 24 and emits ESM modules.
It also checks unused code, implicit returns, overrides, and switch fallthrough.
A type error prevents output changes.
The build checks output paths before and after compilation.
Existing symbolic links, hard links, and special files at output paths stop the build.

The local start command and npm bin use the same `dist/src/cli.js` file.
Vitest transforms source tests without adding them to `dist/`.
Unknown output files stop the build and require separate review.
After successful compilation, the build removes known flat files from the earlier output layout.
The package file allowlist excludes tests, configuration files, and build tools.
The `prepack` script makes the build.
There are no install lifecycle scripts.

Use the archive name from the npm output for a local bin check.
Replace `PACKAGE.tgz` with that archive name.

```sh
npx --offline --yes --package /path/to/PACKAGE.tgz tx-rehistory --help
```

### Publish the current version

The recommended release path is the GitHub Actions Release workflow with `app=reHistory`.
Increase the version and merge the change to `master` first.
Start the workflow with `dry_run=true`, then start it again with `dry_run=false`.
See the [GitHub Actions guide](../../docs/GITHUB_ACTIONS.md#release).

The manual procedure follows.
Run these release commands from the application directory after installing dependencies at the Toolchain root.
Run `npm run check` from the root before release.
Configure npm authentication separately with `npm login`.

Check the release without publishing:

```sh
npm run release:dry-run
```

Publish the current version:

```sh
npm run release
```

From the Toolchain root, use `npm run release --workspace tx-rehistory`.
The command runs this sequence:

```sh
npm pack --ignore-scripts && node scripts/publish.mjs
```

The separate root check includes formatting, lint, TypeScript, the Vite build, and all application tests.
The release command does not build or test automatically.
A failed step stops the sequence.
Packing and publishing skip lifecycle scripts, so they do not repeat the build.
The dry-run command adds `--dry-run` to the final npm publish step.

The pack step writes `tx-rehistory-<version>.tgz` in the application directory.
A repeated pack replaces the archive with the same name.
The publish helper sends that exact archive to the public npm registry.
It runs `npm publish ./tx-rehistory-<version>.tgz` with lifecycle scripts disabled.
The helper uses Node.js to resolve the version on macOS, Linux, and Windows.
It accepts only --dry-run and rejects missing archives and linked files.
Do not change source files or the archive while release runs.
The command does not increment the version, create Git commits or tags, or push Git refs.
The npm authentication and two-factor authentication requirements still apply.
The narrow package file allowlist controls archive contents.
Inspect permitted files for secrets before publication.
After a connection error, inspect the registry before repeating publication.

## Development checks

```sh
cd /path/to/toolchain
npm run format
npm run lint
npm run typecheck
npm test --workspace tx-rehistory
```

Use `npm run format:check` for a read-only formatting check.
Use `npm run lint:fix` for explicit ESLint fixes.
Use `npm run check` for formatting checks, lint, type checks, and the complete test suite.
The lint command rejects warnings as well as errors.
The root Prettier discovery file and .prettierignore select shared formatting and exclusions.
ESLint settings, TypeScript defaults, and build and test presets live in the root configs directory.
ESLint uses the recommended JavaScript and TypeScript rules with Node.js globals.
It also checks import order, type imports and exports, return types, and unsafe spread operations.
Runtime imports use the @reHistory/* alias. Test fixtures can use relative imports.
Lint checks permit CLI state changes and the getter used for deferred interruption signals.
eslint-config-prettier disables conflicting style rules. Prettier runs separately.
Generated output, dependencies, coverage, and reports stay outside these checks.

All existing tests now use Vitest.
The unit suite covers dates, identities, signature removal, environment isolation, and terminal interaction.
The integration suite uses real Git commands in different temporary repositories.
The subprocess tests also exercise the built JavaScript modules.

From the root, use `npm run test:unit --workspace tx-rehistory` for unit and terminal tests.
Use `npm run test:watch --workspace tx-rehistory` to watch those source-only suites.
Use `npm test --workspace tx-rehistory` after changes to check the build and all integration regressions.
Test files run in isolated fork processes, with at most three workers.
The worker count is capped by available CPU parallelism.
Tests inside each file remain sequential to protect process state.
The complete suite retains every integration and security regression.
The check command uses the build's mandatory TypeScript check without running it twice.
Use `npm test --workspace tx-rehistory -- --no-file-parallelism --maxWorkers=1` for sequential diagnosis.
The demo test uses a local test server through a transport adapter.
A specified network URL is necessary for the product demo.

## Technical references

- [Vite TypeScript and type checking](https://vite.dev/guide/features.html#typescript).
- [Vitest configuration](https://vitest.dev/config/).
- [TypeScript compiler configuration](https://www.typescriptlang.org/tsconfig/).
- [Git ref transactions](https://git-scm.com/docs/git-update-ref).
- [Git object inventory](https://git-scm.com/docs/git-cat-file).
- [npm package fields](https://docs.npmjs.com/cli/configuring-npm/package-json/).
