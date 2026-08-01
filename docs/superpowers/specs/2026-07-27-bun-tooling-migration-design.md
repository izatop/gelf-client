# Bun Tooling Migration Design

## Goal

Complete the repository's partial migration from Yarn, Jest, TSLint, Travis CI,
and TypeScript 4.9 tooling to Bun, `bun:test`, oxlint, oxfmt, GitHub Actions,
and TypeScript 7 without changing the public GELF client API.

## Current State

The repository already pins Bun 1.3.14 and TypeScript 7.0.2. The npm registry
marks TypeScript 7.0.2 as `latest` on July 27, 2026. The repository also
contains `bun.lock`, oxlint, and oxfmt configuration. The migration is
incomplete:

- `bun test` discovers all five tests, but every test fails because
  `import * as assert from "assert"` is not callable under Bun's module
  interop.
- The lint script still invokes the removed `tslint` dependency.
- The build script still invokes Yarn.
- Jest configuration, Jest types, TSLint configuration, Travis configuration,
  and Yarn configuration remain tracked.
- The existing publish workflow installs Node and invokes Yarn.
- TypeScript 7 no longer loads ambient type packages by default. Both tsconfig
  files omit explicit Node and Bun types, so the compiler reports missing
  built-in modules, `Buffer`, `process`, and test globals.
- oxlint reports eight errors, and oxfmt reports formatting drift in tracked
  source and configuration files.

## Test Migration

`test/src/main.test.ts` will explicitly import `expect` and `test` from
`bun:test`. The existing behavioral coverage remains unchanged: transport
registration, client construction, strict field validation, serialization, and
chunk snapshots.

The existing external snapshot remains the expected source of truth. It may be
rewritten only if Bun requires a canonical snapshot representation; the
asserted payload must not change.

`src/config.ts` will use a Bun- and Node-compatible named assert function
instead of calling a module namespace. This is the only production-code change
required by the test-runner migration.

Jest-specific dependencies and `jest.config.js` will be removed. The test
TypeScript project will resolve `bun:test` types from `@types/bun`.

## Package Scripts and Dependencies

`package.json` will expose these commands:

| Script           | Command                               | Purpose                                      |
| ---------------- | ------------------------------------- | -------------------------------------------- |
| `clean`          | `rimraf dist tsconfig.tsbuildinfo`    | Remove build output and incremental state    |
| `build`          | `bun run clean && tsc`                | Produce CommonJS JavaScript and declarations |
| `build:watch`    | `tsc -w`                              | Rebuild during development                   |
| `test`           | `bun test`                            | Run the Bun test suite once                  |
| `test:watch`     | `bun test --watch`                    | Run tests in watch mode                      |
| `test:typecheck` | `tsc -p test/tsconfig.json`           | Type-check source and tests without emitting |
| `test:package`   | `bun test/package-consumer.ts`        | Type-check the packed package as a consumer  |
| `lint`           | `oxlint .`                            | Lint the repository                          |
| `lint:fix`       | `oxlint --fix .`                      | Apply safe lint fixes                        |
| `fmt`            | `oxfmt .`                             | Format tracked repository files              |
| `fmt:check`      | `oxfmt --check .`                     | Check formatting without writing             |
| `check`          | chained read-only checks plus `build` | Reproduce the complete CI gate locally       |

`check` will run formatting, lint, test type-checking, tests, the build, and the
packed-package consumer check in that order.

`@types/jest` will be removed. `@types/bun` and `@types/node` are development
dependencies. The public declarations expose Node's `Buffer` and `EventEmitter`
types, so Node-targeted consumers are expected to provide Node type declarations.
The package-consumer check provides them explicitly before compiling the packed
package. The generated entry declaration preserves an explicit Node type
reference so that TypeScript 7 loads those ambient declarations despite its new
empty `types` default. `bun install` will update `bun.lock` after the manifest
changes.

## TypeScript 7 Migration

`package.json` and `bun.lock` already pin `typescript` to the current stable
version, 7.0.2. The implementation will retain the exact pin and adapt the
repository to the compiler's new defaults.

The source tsconfig will list `node` in `compilerOptions.types`. The test
tsconfig will list `bun` and `node`. Both projects keep strict checking. The
package build keeps its CommonJS output, declaration files, and existing
`dist` layout.

The migration will fix TypeScript 7 diagnostics in configuration or source
without weakening strictness or skipping library checks beyond the existing
`skipLibCheck` setting. `build`, `build:watch`, and `test:typecheck` will use the
project-local TypeScript 7 executable.

This repository does not call the TypeScript compiler API, so it does not need
the TypeScript 6 compatibility package.

## Linting and Formatting

The existing oxlint correctness category and TypeScript, Unicorn, and Oxc
plugins remain enabled. Reported errors will be fixed in source and tests
instead of suppressed.

oxfmt will format all tracked files it supports. Generated output,
`node_modules`, and ignored files remain outside the formatting scope. The
formatter configuration and formatted tree must make `bun run fmt:check`
repeatable with no diff.

`tslint.json` is removed because oxlint becomes the only linter.

## GitHub Actions

### Continuous Integration

`.github/workflows/ci.yml` will run for branch pushes and pull requests. It will:

1. grant only `contents: read`;
2. check out the repository with the verified `actions/checkout` v7 commit;
3. install the Bun version pinned by `packageManager` with
   the verified `oven-sh/setup-bun` v2 commit;
4. install exactly `bun.lock` with `bun ci`;
5. run `bun run check`.

Concurrent runs for the same branch or pull request will cancel older runs.

### Publishing

`.github/workflows/publish.yml` remains tag-driven for `v*` tags. It will use
the same checkout, Bun setup, frozen installation, and full check as CI, then
run `bun publish`.

Publishing authenticates with the existing `NPM_TOKEN` repository secret via
`NPM_CONFIG_TOKEN`, which Bun officially supports. No Node or Yarn setup is
required.

The obsolete `.travis.yml` and `.yarnrc.yml` files will be removed.

## Documentation

README installation instructions will use Bun instead of Yarn. No public API
examples or package metadata change.

## Acceptance Criteria

- `bun ci` accepts `package.json` and `bun.lock`.
- `bun run fmt:check` exits successfully.
- `bun run lint` exits successfully without suppressed existing findings.
- `bun run test:typecheck` exits successfully.
- `bun run test:package` compiles a clean consumer against the packed tarball.
- `bun test` passes all existing behavior and snapshot assertions.
- `bun run build` produces the package output successfully.
- `tsc --version` reports 7.0.2, and both tsconfig projects compile with
  TypeScript 7.
- `bun run check` reproduces all local CI gates successfully.
- Both workflow files parse as valid YAML and use only Bun for install, test,
  build, checks, and publication.
- No Jest, TSLint, Travis, or Yarn tooling remains in tracked configuration or
  package dependencies.

## Out of Scope

- Changes to the public client API or wire format.
- New test cases unrelated to proving the Bun migration.
- Version release, tag creation, package publication, or workflow execution on
  GitHub.

## References

- [Bun CI installation](https://bun.sh/docs/pm/cli/install)
- [Bun package publication](https://bun.sh/docs/pm/cli/publish)
- [setup-bun](https://github.com/oven-sh/setup-bun)
- [actions/checkout](https://github.com/actions/checkout)
- [TypeScript 7 release notes](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [TypeScript latest registry metadata](https://registry.npmjs.org/typescript/latest)
