# Changesets

This repo uses Changesets for versioning and release notes.

## Common commands

- `pnpm changeset` - create a new changeset
- `pnpm changeset:version` - bump package versions + update changelogs
- `pnpm changeset:publish` - publish packages to npm

## Notes

- Use one changeset per logical change, list all affected packages.
- Changesets live in `.changeset/` and should be committed with the code change.
