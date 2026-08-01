# Dual Package, Full Coverage, and Main Branch Design

## Goal

Publish `gelf-client` as a Node.js dual package with `.mjs` and `.cjs`
entrypoints, build both JavaScript artifacts with Bun, enforce 100% source
coverage, run a strict dependency audit in CI, and rename the default branch
from `master` to `main`.

## Current State

The package publishes TypeScript's CommonJS output from `dist/index.js` and
points `main`, `types`, and `typings` at that directory. The source
`tsconfig.json` contains the CommonJS build settings. Bun runs tests and package
scripts, but `tsc` creates the JavaScript release files.

The suite has 14 passing tests. Bun reports 80.19% function coverage and 93.22%
line coverage. TCP tests use a loopback server. The suite has no UDP socket
test, and several public client helpers and error paths lack coverage.

GitHub and the local clone use `master` as the default branch. The README and
completed workflow documents contain links or commands that name `master`.

## Package Contract

The package will publish these files:

| Consumer   | Package condition | File                    |
| ---------- | ----------------- | ----------------------- |
| ES modules | `import`          | `dist/index.mjs`        |
| CommonJS   | `require`         | `dist/index.cjs`        |
| TypeScript | `types`           | `dist/types/index.d.ts` |

`package.json` will add an `exports` map for the package root. The `main`,
`module`, `types`, and `typings` fields will point at the same artifacts for
tools that do not use `exports`. Explicit `.mjs` and `.cjs` extensions avoid a
package-wide `type` switch and keep each runtime format unambiguous.

The default and named exports must retain their current meaning in both module
systems. Existing CommonJS callers can continue to read the `default` export,
while named exports such as `Client` and `Level` remain available.

## Build Configuration

The root `tsconfig.json` will hold shared strict compiler settings and source
boundaries. Two target configs will extend it:

- `tsconfig.esnext.json` checks the source with ES module semantics and provides
  the declaration build settings.
- `tsconfig.cjs.json` checks the same source with CommonJS semantics.

The build command will clean `dist`, type-check both targets, emit declarations
from the ESNext config, and call `bun build` once per JavaScript format. Both Bun
builds will use `src/index.ts`, `target: node`, external packages, linked source
maps, and explicit output files.

Bun will bundle the library into one file per format. The library has no runtime
package dependencies, and Bun will keep Node built-ins external under the Node
target. A package-consumer test will guard this behavior because Bun still marks
its CommonJS bundler format as experimental.

## Minification

Both Bun builds will enable syntax minification only. Bun may fold constants and
shorten equivalent expressions, but it will keep class and function names and
will not collapse the output through identifier or whitespace minification.
Linked source maps will map runtime failures back to TypeScript sources.

This setting reduces the release files without obscuring a public library or
making stack traces depend on mangled names. Full production minification and
bytecode output stay outside this change.

## Test and Coverage Design

`bun test` will run with coverage enabled. `bunfig.toml` will exclude `test/**`
from coverage accounting and require a value of `1` for lines, functions, and
statements. Production files under `src/**` remain in scope. CI will fail when
any supported metric drops below 100%.

The tests will cover behavior rather than source text:

- connection parsing will cover defaults, flags, numeric bounds, and invalid
  host or protocol input;
- client tests will exercise every level helper, cloned defaults, strict and
  non-strict fields, close behavior, and serialization failures;
- serializer tests will cover direct payloads, compressed payloads, chunking,
  and the maximum chunk-count error;
- TCP and UDP tests will exchange GELF data through loopback sockets and verify
  transport error forwarding and shutdown;
- transport test doubles will exercise their write and destroy implementations
  even though test files do not count toward the threshold.

Socket tests will bind to `127.0.0.1` on an operating-system-selected port. They
will set timeouts and close clients, accepted sockets, and servers in `finally`
blocks so a failure cannot leave an open handle.

## Packed-Package Verification

The package-consumer check will build and pack the repository into a temporary
directory under `.local`. It will inspect the packed manifest and verify that
the tarball contains both JavaScript formats, declaration files, and source
maps.

The check will execute small Node.js consumers against the unpacked tarball:

- an ESM consumer imports the default and named exports;
- a CommonJS consumer requires the default and named exports;
- a TypeScript consumer resolves the declarations through the package export
  map.

Each runtime consumer will create a client with a test-safe custom transport or
inspect exports without sending data to an external Graylog instance. The check
will fail on export-shape or module-resolution regressions.

## Dependency Security

`package.json` will expose `bun run security`, which invokes `bun audit` without
an audit-level filter or ignored advisories. The audit will include development
dependencies because CI and the release job execute them.

The CI and publish workflows will run the security command after `bun ci` and
before the build and test gate. Any advisory reported by Bun will stop the job.
The workflows will keep pinned action commit hashes and their existing minimal
permissions.

## Default Branch Rename

Code and documentation changes will land before the rename. The migration will
then use GitHub's branch rename operation to rename the default branch from
`master` to `main`. GitHub will move the default-branch setting, open pull
request bases, and compatible branch rules as part of that operation.

The local clone will rename its branch, fetch the remote, track `origin/main`,
and refresh `origin/HEAD`. Repository links and actionable commands that point
at `master` will use `main`. A final check will confirm that GitHub reports
`main` as default, `origin/main` matches the local branch, and the worktree has
no pending changes.

If GitHub rejects the rename because an organization ruleset requires a higher
role, implementation will stop after the tested local changes and report the
specific permission requirement. It will not create a second long-lived branch
or delete a protected branch as a workaround.

## Acceptance Criteria

- `bun run build` creates `dist/index.mjs`, `dist/index.cjs`, their linked source
  maps, and declarations under `dist/types`.
- The build uses Bun for both JavaScript formats and TypeScript only for checks
  and declarations.
- Node.js runs the packed package through both `import` and `require`.
- TypeScript resolves the packed package's declarations.
- `bun test` reports 100% for lines, functions, and statements and enforces the
  threshold.
- TCP and UDP loopback tests pass without external services.
- `bun run security` passes with no reported advisory at any severity.
- `bun run check` and the packed-package check pass.
- CI and publish workflows run the strict Bun security audit.
- GitHub and the local clone use `main`; `origin/HEAD` points to
  `origin/main`.
- Tracked links and actionable commands do not refer to `master`.

## Out of Scope

- Publishing a new npm version or creating a release tag.
- Changing the GELF wire format or public client methods.
- Browser bundles, standalone Bun executables, or Bun bytecode.
- A third-party coverage service or dependency-scanning action.

## References

- [Bun bundler](https://bun.com/docs/bundler)
- [Bun minifier](https://bun.com/docs/bundler/minifier)
- [Bun code coverage](https://bun.com/docs/test/code-coverage)
- [Bun audit](https://bun.com/docs/pm/cli/audit)
- [GitHub branch rename](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/renaming-a-branch)
