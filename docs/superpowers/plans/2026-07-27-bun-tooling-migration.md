# Bun Tooling Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the repository's migration to Bun, `bun:test`, TypeScript
7.0.2, oxlint, oxfmt, and Bun-based GitHub Actions.

**Architecture:** Keep the library's CommonJS output and public API intact.
Use Bun for dependency installation, test execution, local scripts, CI, and
publication. Treat `package.json` scripts as the single local and CI interface.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, `bun:test`, oxlint 1.75.0, oxfmt
0.60.0, GitHub Actions.

## Global Constraints

- Keep `typescript` pinned to exact version `7.0.2`, the npm `latest` version
  verified on July 27, 2026.
- Preserve CommonJS output, declaration generation, the `dist` layout, the
  public API, and GELF wire behavior.
- Keep strict TypeScript checking and the existing `skipLibCheck` value.
- Fix oxlint findings in code. Do not suppress them.
- Use `bun.lock` as the only package-manager lockfile.
- Keep publication on `v*` tags and authenticate with the existing `NPM_TOKEN`
  GitHub secret.
- Do not publish a package, create a tag, or push commits.
- Execute inline in the current session. Do not dispatch subagents.

---

### Task 1: Make the existing suite pass under Bun and TypeScript 7

**Files:**

- Modify: `src/config.ts:1-4`
- Modify: `test/src/main.test.ts:1-3`
- Modify: `tsconfig.json:2-18`
- Modify: `test/tsconfig.json:2-18`

**Interfaces:**

- Consumes: existing `Client`, `Transport`, and snapshot behavior.
- Produces: Bun-native test imports and TypeScript projects with explicit
  runtime type packages.

- [ ] **Step 1: Re-run the existing RED test signal**

Run:

```bash
bun test
```

Expected: five failures whose root cause is `TypeError: assert is not a
function`.

- [ ] **Step 2: Re-run the TypeScript 7 RED signal**

Run:

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit --incremental false
./node_modules/.bin/tsc -p test/tsconfig.json --incremental false
```

Expected: both commands fail because TypeScript 7 defaults `types` to `[]`.
Diagnostics include missing Node built-ins and globals; the test project also
reports missing `test` and `expect`.

- [ ] **Step 3: Import Bun's test API and a callable Node assertion**

At the start of `test/src/main.test.ts`, use:

```typescript
import { expect, test } from "bun:test";
import { Client, Level } from "../../src";
import { Transport } from "../../src/config";
import { TestTransport } from "./TestTransport";
```

At the start of `src/config.ts`, replace the assertion namespace import with:

```typescript
import { ok as assert } from "node:assert";
```

Do not change the five test bodies or their asserted values in this step.

- [ ] **Step 4: Declare TypeScript 7 ambient types**

Add this option to the source `compilerOptions` in `tsconfig.json`:

```json
"types": ["node"]
```

Add this option to the test `compilerOptions` in `test/tsconfig.json`:

```json
"types": ["bun", "node"]
```

- [ ] **Step 5: Verify GREEN runtime and compiler signals**

Run:

```bash
bun test
./node_modules/.bin/tsc -p tsconfig.json --noEmit --incremental false
./node_modules/.bin/tsc -p test/tsconfig.json --incremental false
./node_modules/.bin/tsc --version
```

Expected: five tests pass, both TypeScript projects pass, and the version is
`7.0.2`.

- [ ] **Step 6: Check the mutation boundary**

Confirm from the RED and GREEN outputs:

- reverting the callable assert import restores the Bun runtime failure;
- removing explicit `types` restores the TypeScript 7 diagnostics;
- removing the `bun:test` import restores missing test API diagnostics.

Do not add tests that assert source text or configuration contents.

- [ ] **Step 7: Commit the runtime and compiler migration**

```bash
git add src/config.ts test/src/main.test.ts tsconfig.json test/tsconfig.json
git commit -m "test: migrate suite to Bun and TypeScript 7"
```

### Task 2: Replace legacy package scripts and dependency metadata

**Files:**

- Modify: `package.json:26-44`
- Modify: `bun.lock`
- Modify: `.gitignore:1-19`
- Modify: `README.md:6-8`
- Delete: `jest.config.js`
- Delete: `tslint.json`
- Delete: `.travis.yml`
- Delete: `.yarnrc.yml`

**Interfaces:**

- Consumes: the passing Bun suite and TypeScript projects from Task 1.
- Produces: stable local commands used by developers and GitHub Actions.

- [ ] **Step 1: Replace scripts and dependency sections**

Use this script map in `package.json`:

```json
"scripts": {
  "clean": "rimraf dist tsconfig.tsbuildinfo",
  "build": "bun run clean && tsc",
  "build:watch": "tsc -w",
  "test": "bun test",
  "test:watch": "bun test --watch",
  "test:typecheck": "tsc -p test/tsconfig.json",
  "lint": "oxlint .",
  "lint:fix": "oxlint --fix .",
  "fmt": "oxfmt .",
  "fmt:check": "oxfmt --check .",
  "check": "bun run fmt:check && bun run lint && bun run test:typecheck && bun run test && bun run build",
  "postversion": "git push --tags && git push"
}
```

Use one development dependency section:

```json
"devDependencies": {
  "@types/bun": "^1.3.14",
  "@types/node": "^26.1.1",
  "oxfmt": "^0.60.0",
  "oxlint": "^1.75.0",
  "rimraf": "^6.1.3",
  "typescript": "7.0.2"
}
```

Remove the empty runtime `dependencies` section.

- [ ] **Step 2: Remove obsolete tooling files**

Delete:

```text
jest.config.js
tslint.json
.travis.yml
.yarnrc.yml
```

Remove the Yarn-specific block and `yarn-*.log` entry from `.gitignore`. Keep
the common ignored paths.

Change the README installation command to:

```markdown
`bun add gelf-client`
```

- [ ] **Step 3: Regenerate package metadata with Bun**

Run:

```bash
bun install
bun ci
```

Expected: Bun updates `bun.lock`, removes Jest-related packages, and accepts the
result as frozen.

- [ ] **Step 4: Verify the new runtime and compiler scripts**

Run:

```bash
bun run test
bun run test:typecheck
bun run build
bun run test:watch --help
```

Expected: tests, test type-checking, and build pass. The watch command prints
Bun test help and exits instead of invoking Jest.

- [ ] **Step 5: Commit the package-manager cleanup**

```bash
git add package.json bun.lock .gitignore README.md
git add -u jest.config.js tslint.json .travis.yml .yarnrc.yml
git commit -m "build: replace legacy tooling with Bun scripts"
```

### Task 3: Make oxlint and oxfmt authoritative

**Files:**

- Modify: `.oxlintrc.json`
- Modify: `.oxfmtrc.json`
- Modify: `src/Client.ts:4`
- Modify: `src/Interface.ts:1-3`
- Modify: `src/TransportAbstract.ts:1-3`
- Modify: `src/Transport/TCPTransport.ts:1-3`
- Modify: `src/Transport/UDPTransport.ts:1-3`
- Modify: `src/config.ts:59-63`
- Modify: `test/src/main.test.ts:48-53`
- Format: tracked files supported by oxfmt

**Interfaces:**

- Consumes: `lint`, `lint:fix`, `fmt`, and `fmt:check` scripts from Task 2.
- Produces: one clean oxlint configuration and a repeatable oxfmt tree.

- [ ] **Step 1: Capture the lint and format RED signals**

Run:

```bash
bun run lint
bun run fmt:check
```

Expected: oxlint reports the known unused imports and variables plus
`unicorn/no-new-array`; oxfmt reports the unformatted tracked files.

- [ ] **Step 2: Fix the oxlint findings without suppressions**

Apply these source changes:

```typescript
// src/Client.ts
import { TransportAbstract } from "./TransportAbstract";

// src/Interface.ts
// Remove the unused TransportCtor import.

// src/TransportAbstract.ts
// Remove the unused Url import.

// src/Transport/TCPTransport.ts and src/Transport/UDPTransport.ts
// Remove the unused Url imports.

// src/config.ts
// Remove the unused alwaysStrictChecks declaration.

// test/src/main.test.ts
const chunks = Array.from({ length: written.length }, () => Buffer.alloc(0));
```

Keep the current oxlint categories and plugins. Do not add disable comments or
turn off rules.

- [ ] **Step 3: Format the tracked tree**

Run:

```bash
bun run fmt
```

Review the diff. Keep formatting-only changes and reject behavior changes not
listed in the plan.

- [ ] **Step 4: Verify GREEN quality signals**

Run:

```bash
bun run fmt:check
bun run lint
bun run test:typecheck
bun run test
bun run build
git diff --check
```

Expected: every command exits successfully.

- [ ] **Step 5: Commit the lint and format migration**

```bash
git add .oxlintrc.json .oxfmtrc.json package.json README.md src test tsconfig.json docs
git commit -m "style: enforce oxlint and oxfmt"
```

### Task 4: Add Bun CI and migrate tag publication

**Files:**

- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: `bun ci` and `bun run check`.
- Produces: branch and pull-request CI plus tag-triggered npm publication.

- [ ] **Step 1: Create the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
    push:
        branches:
            - "**"
    pull_request:

permissions:
    contents: read

concurrency:
    group: ci-${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true

jobs:
    ci:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v7
            - uses: oven-sh/setup-bun@v2
            - run: bun ci
            - run: bun run check
```

- [ ] **Step 2: Replace the publish workflow**

Use this content in `.github/workflows/publish.yml`:

```yaml
name: Publish

on:
    push:
        tags:
            - "v*"

permissions:
    contents: read

jobs:
    publish:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v7
            - uses: oven-sh/setup-bun@v2
            - run: bun ci
            - run: bun run check
            - run: bun publish
              env:
                  NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 3: Format and parse both workflows**

Run:

```bash
bun run fmt
bun -e 'for (const file of [".github/workflows/ci.yml", ".github/workflows/publish.yml"]) Bun.YAML.parse(await Bun.file(file).text())'
bun run fmt:check
```

Expected: YAML parsing and format checking pass.

- [ ] **Step 4: Verify the complete local CI contract**

Run:

```bash
bun ci
bun run check
bun pm pack --dry-run
git diff --check
```

Expected: frozen installation, all quality gates, build, tests, and package
dry-run pass. The dry-run must list `dist`, `README.md`, and `LICENSE` without
requiring registry authentication or publishing.

- [ ] **Step 5: Check that legacy tooling no longer drives the repository**

Run:

```bash
rg -n "jest|ts-jest|tslint|yarn|actions/setup-node|npm publish" package.json bun.lock .github README.md .gitignore src test/tsconfig.json --glob "!test/src/__snapshots__/**"
```

Expected: no matches.

- [ ] **Step 6: Commit the workflows**

```bash
git add .github/workflows/ci.yml .github/workflows/publish.yml
git commit -m "ci: run checks and publish with Bun"
```

- [ ] **Step 7: Run the final verification matrix**

Run:

```bash
bun ci
bun run fmt:check
bun run lint
bun run test:typecheck
bun test
bun run build
bun run check
bun pm pack --dry-run
bun -e 'for (const file of [".github/workflows/ci.yml", ".github/workflows/publish.yml"]) Bun.YAML.parse(await Bun.file(file).text())'
git diff --check
git status --short --branch
```

Expected: all executable checks pass, five tests pass, TypeScript reports
version 7.0.2 through the pinned local compiler, the package dry-run succeeds,
both workflow files parse, and the working tree is clean.
