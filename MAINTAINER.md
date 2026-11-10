# DevSarathi — Maintainer Guide

> For the owner (sole maintainer) and the owner's build agents.

## 1. Cutting a Release

1. Make sure all tests pass, including `devsarathi selftest` and the real-repo checks on Angular, Java and Python.
2. Update `CHANGELOG.md`. Mark any template changes, because they affect `migrate`.
3. Bump the version with semantic versioning:
   - **patch** for bug fixes,
   - **minor** for new commands, profiles or features,
   - **major** for breaking changes to config, the graph format or the template structure.
4. If the template or graph format changed, add a migration step in `packages/core/migrate/`.
5. Run `npm version <patch|minor|major>`. This creates the git tag.
6. Run `npm publish --access public`. The `--access public` flag is required for the first publish of the scoped package and is harmless afterwards.
7. Run `git push --follow-tags`.
8. Smoke test: run `npm i -g @ravikiranm/dev-sarathi@latest` on a clean machine or container, then run `devsarathi selftest`.

## 2. Rolling Back a Bad Release

1. Publish a fixed patch as quickly as possible. This is preferred.
2. Meanwhile, tell users to run:
   `npm i -g @ravikiranm/dev-sarathi@<previous-good-version>`, then `devsarathi migrate`.
3. Optionally, run `npm deprecate @ravikiranm/dev-sarathi@<bad> "<reason>, use <good>"`.
4. Avoid `npm unpublish`. It is restricted and breaks pinned installs.

## 3. Adding a New Stack Profile

1. Create `templates/profiles/<stack>/` containing:
   - `detect.json`: manifest files, dependency names and extensions that identify the stack,
   - `ds-stack-<stack>.md`: the strict template rules for the stack,
   - `persona.json`: the title fragment (for example "PHP") and the category (frontend or backend),
   - `commands.json`: the test, lint and build commands,
   - `security.json`: stack-specific risky patterns.
2. Extend Drishti in `brain/` to parse the stack, and record the change in `brain/CHANGES.md`.
3. Add a fixture under `test-fixtures/<stack>/` with planted problems.
4. Prove the profile on at least one real repo before release (the same standard as version 1).
5. Release as a **minor** version.

## 4. The Company Overlay

- Company-specific rules live in `overlays/` and are **not** part of the public package.
- Distribute the overlay separately, for example as a one-time committed team baseline (`devsarathi export-baseline`) or as a private package.

## 5. Before the First Public Publish

- [ ] Choose a license and add `LICENSE`.
- [ ] Confirm that the npm scope `@ravikiranm` belongs to your npm account, or create a free npm org with that name.
- [ ] Give the company a courtesy heads-up, since teammates already use Drishti at work.
- [ ] Remove any company-specific content from the core package.
