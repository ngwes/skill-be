---
name: release-notes
description: How to write the release notes of a version from its list of changes, in this team's format.
---

# Release notes

Release notes are for the people who use the product, not for the people who build it. Write them from the list of changes in the version.

## Format

Start with one heading line: `## <version> — <date>`, with the date as YYYY-MM-DD.

Then these sections, in this order. Leave out a section that has no entry:

1. `### Breaking changes`
2. `### New`
3. `### Fixed`

## Entries

- One bullet per change a user can notice. Leave out changes to tests, CI and build scripts, refactors, and dependency updates that change no behavior.
- Say what the user can now do, or no longer sees, in the present tense: "The export command writes JSON with `--format json`", not "Added JSON export" or "feat(export): json".
- No commit hashes, issue numbers, branch names or author names.
- Every breaking change says what to do: end its bullet with "To migrate, " and the step.

## Example

```md
## 2.4.0 — 2026-10-12

### Breaking changes

- The `--out` option is now `--output`. To migrate, rename the option in your scripts.

### Fixed

- Reports with more than 1000 rows no longer stop at row 1000.
```
