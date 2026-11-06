# moveToRepo

moveToRepo copies local files into a GitHub repository.
It puts the files on a new branch and opens a pull request into the target branch.
The target branch does not change until a person merges the pull request.
The program is not interactive. All inputs are command line arguments.
Messages use Russian.

Use [SECURITY.md](SECURITY.md) for security controls and limits.

## Requirements

- macOS or Linux.
- Node.js 24.12 or later.
- Git.
- GitHub CLI (`gh`), signed in with `gh auth login`. The account must have write access to the repository.
- A Git user name and email in the Git configuration. The commit uses them.
  The program ignores `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables. When `commit.gpgSign` is set, Git signs the commit.

## Start

Run the published package:

```sh
npx tx-movetorepo --repo https://github.com/OWNER/REPO --base main \
  --dest to-A ./from-A/some1.txt ./from-A/some2.txt ./from-A/some3.txt \
  --dest to-B ./from-B/some4.txt ./from-B/some5.txt
```

The program uses your write access to all your repositories. Give a fixed version, for example `npx tx-movetorepo@0.1.1`,
so that a different later release does not start without your check.

This example makes one pull request with these files:

| Local file           | Path in the repository |
| -------------------- | ---------------------- |
| `./from-A/some1.txt` | `to-A/some1.txt`       |
| `./from-A/some2.txt` | `to-A/some2.txt`       |
| `./from-A/some3.txt` | `to-A/some3.txt`       |
| `./from-B/some4.txt` | `to-B/some4.txt`       |
| `./from-B/some5.txt` | `to-B/some5.txt`       |

Run the local build from the Toolchain root:

```sh
npm ci --ignore-scripts
npm run start --workspace tx-movetorepo -- --help
```

The start script builds the application before it starts `dist/src/cli.js`.
A build failure stops the start.

## Arguments

| Argument      | Purpose                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `--repo URL`  | Necessary. `https://github.com/OWNER/REPO` or `git@github.com:OWNER/REPO.git`. Only github.com.             |
| `--base NAME` | The target branch of the pull request. The default is the default branch of the repository.                 |
| `--dest DIR`  | A directory in the repository. The next files go into it with their file names. `.` is the repository root. |
| `FILE`        | A file in the current directory or its subdirectories. Each file must come after a `--dest`.                |
| `--dry-run`   | Shows the plan. It does not make a commit, push a branch, or open a pull request. It reads the repository.  |
| `--version`   | Shows the version.                                                                                          |
| `--help`      | Shows the help in Russian.                                                                                  |

Options accept `--name value` and `--name=value`.
Each `--dest` needs one or more files. A file before the first `--dest` stops the program.
A repeated `--repo`, `--base`, or `--dry-run`, an unknown option, or an empty value stops the program.

## Rules for files

The program stops before any network access when one of these rules fails:

- Paths are relative. `..`, `.`, empty segments, and absolute paths are not permitted.
- A path segment cannot start with a dot. For example, `.env`, `.git`, and `.github` are not permitted.
- The current directory cannot be inside a directory that starts with a dot, for example `~/.docker` or `~/.config/gh`.
  The program checks the real path, after links.
- Paths contain only ASCII letters, digits, `_`, `+`, `@`, `-`, `.`, and single spaces inside a name.
- A file and each directory in its path cannot be a symbolic link. A file with hard links is not permitted.
- Typical secret files are not permitted, for example `*.pem`, `*.key`, `*.p12`, `id_rsa`, `credentials.json`, and `*.env`.
  All extensions of a name are checked, so `terraform.tfstate.backup` is not permitted too.
- Contents with a private key or a known token format are not permitted. UTF-16 text is checked too.
- Two files cannot go to the same repository path, also when only the letter case is different.
- Limits: 100 files, 10 MiB for each file, 50 MiB in total.

## What the program does

1. Checks the arguments and reads the local files.
2. Asks `gh` for the repository. It checks write access, the archive state, and the default branch.
3. Makes a shallow clone of the target branch in a private temporary directory. It does not write a work tree.
4. Shows the plan. `+` is a new file, `~` replaces an existing file, `=` is the same file.
5. Makes one commit on top of the target branch. The commit message is the list of changed files.
6. Pushes the commit to a new branch `movetorepo/<random>`. It never pushes to an existing branch and never forces a push.
7. Opens a pull request with `gh pr create`. The title and the body list the files.
8. Writes the pull request URL to stdout and removes the temporary directory.

When all files are the same as in the target branch, the program stops without a commit.
Messages go to stderr. Only the pull request URL goes to stdout.

## Recovery

The program does not change the target branch or the local files.

- To cancel the change, close the pull request on GitHub and delete its branch.
- If `gh pr create` fails after the push, the program shows the branch name and a compare page.
  Open the pull request on that page, or delete the branch on GitHub.
- If you stop the program with Ctrl+C during the push or the pull request step, the branch can exist on GitHub without a pull request.
  Open the pull request on GitHub, or delete the branch.

## Exit codes

| Code  | Meaning                                              |
| ----- | ---------------------------------------------------- |
| `0`   | The pull request is open, or no change is necessary. |
| `1`   | An error. The message shows the reason.              |
| `130` | Stopped with Ctrl+C, or the terminal closed.         |
