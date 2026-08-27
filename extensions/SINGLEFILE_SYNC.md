# SingleFile MV3 upstream mirror

`singlefile-mv3/` is a byte-for-byte source snapshot of
[`gildas-lormeau/SingleFile-MV3`](https://github.com/gildas-lormeau/SingleFile-MV3),
apart from the generated `.upstream-commit` marker. It is kept here so a normal
clone of Script Toolbox contains a directly loadable Chromium extension without
requiring Git submodules.

## Update policy

The `Sync SingleFile MV3` GitHub Actions workflow runs every Monday and can also
be started manually. It:

1. clones the upstream `main` branch;
2. replaces `extensions/singlefile-mv3/` with that exact tree;
3. records the full source revision in `.upstream-commit`;
4. runs the upstream ESLint and extension build checks; and
5. force-updates the dedicated `automation/sync-singlefile-mv3` branch and opens
   or refreshes a pull request.

The workflow never pushes an upstream update directly to the default branch.
Review the pull request before merging it, especially when the manifest,
permissions, network destinations, or build scripts change.

For automatic pull-request creation, enable **Settings → Actions → General →
Workflow permissions → Allow GitHub Actions to create and approve pull
requests** in the GitHub repository. The workflow itself grants write access
only to the mirror-and-PR job; the job that executes upstream code is read-only.

Do not maintain local patches inside `singlefile-mv3/`; the next synchronization
will replace them. Keep Script Toolbox-specific wrappers or automation beside
the mirror and submit generally useful extension changes upstream first.

## Loading the extension

Open `chrome://extensions` or `edge://extensions`, enable developer mode, choose
**Load unpacked**, and select `extensions/singlefile-mv3/`.

SingleFile MV3 is licensed under AGPL-3.0-or-later. Its bundled `LICENSE`, source
notices, authorship, and upstream history remain authoritative; Script Toolbox's
repository-level MIT license does not replace those terms.
