# Automated npm Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual existing-tag input with a safe `patch`/`minor`/`major` release that creates the version commit and tag, then publishes that exact tag through npm Trusted Publishing.

**Architecture:** A tested Bun module will own version, Git-tag, retry, and npm-state validation. A thin CLI will expose that module to two GitHub Actions jobs: `prepare` creates and atomically pushes release refs, while `publish` checks the tag and publishes through OIDC. The workflow will keep tag-push support and make reruns idempotent.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, `bun:test`, Git, GitHub Actions, Node.js 24, npm Trusted Publishing.

## Global Constraints

- The manual input is a required `patch`, `minor`, or `major` choice; `patch` is the default.
- Manual releases start only from `refs/heads/main` and use the event `GITHUB_SHA` as their base.
- Bun runs dependency installation, the strict audit, tests, type checks, and both package builds.
- `prepare` receives only `contents: write`; `publish` receives only `contents: read` and `id-token: write`.
- Release commit and annotated tag refs are pushed together with `git push --atomic`.
- The workflow publishes through `npm publish --provenance`; it contains no long-lived npm token.
- The direct publish audit is `bun audit`, so tag validation does not depend on a package script.
- The tagged `package.json` is immutable during publish; remove `npm pkg fix` from the workflow.
- Keep the `push.tags: v*` trigger.
- Preserve 100% line, function, and statement coverage for loaded production modules.
- Do not add a semver, release-bot, or changelog dependency.

## File Structure

- Create `scripts/release.ts`: command execution, package validation, version preparation, retry validation, and npm-state lookup.
- Create `scripts/release-cli.ts`: argument parsing, calls into `scripts/release.ts`, and GitHub job outputs.
- Create `test/src/release.test.ts`: temporary-repository integration tests and registry-result unit tests.
- Create `test/src/publish-workflow.test.ts`: YAML, permission, trigger, and package-script assertions.
- Modify `test/tsconfig.json`: type-check `scripts/**` with Bun and Node ambient types.
- Modify `bunfig.toml`: exclude only the two-line CLI process adapter from coverage accounting.
- Modify `package.json`: remove the push-on-version `postversion` hook.
- Modify `.github/workflows/publish.yml`: add the prepare/publish job split and automatic bump input.

---

### Task 1: Tested Release State Engine

**Files:**

- Create: `scripts/release.ts`
- Create: `test/src/release.test.ts`
- Modify: `test/tsconfig.json`

**Interfaces:**

- Consumes: Git CLI, `bun pm version`, `npm view`, a repository path, `Bump`, and an event base SHA.
- Produces: `prepareRelease(options): Promise<PreparedRelease>` and `inspectRelease(options): Promise<InspectedRelease>` for the CLI and workflow.

- [ ] **Step 1: Add failing public-contract tests**

Create `test/src/release.test.ts` with a temporary Git repository helper. The
helper must use filesystem APIs, configure a local Git identity, and create a
base commit at version `1.2.3`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    inspectRelease,
    lookupNpmVersion,
    prepareRelease,
    type RegistryLookup,
} from "../../scripts/release";

const directories: string[] = [];

const command = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(`${args.join(" ")} failed: ${stderr}`);
    }
    return stdout.trim();
};

const createRepository = async (versionScript?: string) => {
    const cwd = await mkdtemp(join(tmpdir(), "gelf-release-test-"));
    directories.push(cwd);
    await command(cwd, "git", "init", "--initial-branch=main");
    await command(cwd, "git", "config", "user.name", "Release Test");
    await command(cwd, "git", "config", "user.email", "release@example.com");
    const packageJson = {
        name: "gelf-client",
        version: "1.2.3",
        ...(versionScript === undefined ? {} : { scripts: { version: versionScript } }),
    };
    await writeFile(join(cwd, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    if (versionScript !== undefined) {
        await writeFile(join(cwd, "README.md"), "original\n");
    }
    await command(cwd, "git", "add", ".");
    await command(cwd, "git", "commit", "-m", "test: create release base");
    return { cwd, baseSha: await command(cwd, "git", "rev-parse", "HEAD") };
};

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

const missing: RegistryLookup = async () => false;
const present: RegistryLookup = async () => true;
```

Add these exact behavioral cases below the helper:

```ts
describe("prepareRelease", () => {
    test.each([
        ["patch", "1.2.4"],
        ["minor", "1.3.0"],
        ["major", "2.0.0"],
    ] as const)("creates a %s release", async (bump, version) => {
        const repository = await createRepository();
        const result = await prepareRelease({ ...repository, bump, lookupVersion: missing });

        expect(result).toEqual({
            action: "create",
            name: "gelf-client",
            version,
            tag: `v${version}`,
        });
        expect(
            await command(repository.cwd, "git", "show", `${result.tag}:package.json`),
        ).toContain(`"version": "${version}"`);
        expect(await command(repository.cwd, "git", "rev-parse", `${result.tag}^{commit}^`)).toBe(
            repository.baseSha,
        );
    });

    test("reuses the matching release tag on a full rerun", async () => {
        const repository = await createRepository();
        const first = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });
        await command(repository.cwd, "git", "checkout", "--detach", repository.baseSha);

        const retry = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: present,
        });
        expect(retry).toEqual({ ...first, action: "reuse" });
    });

    test("rejects an unsupported bump", async () => {
        const repository = await createRepository();
        await expect(
            prepareRelease({
                ...repository,
                bump: "prerelease" as "patch",
                lookupVersion: missing,
            }),
        ).rejects.toThrow("Unsupported release bump: prerelease");
    });

    test("rejects a release from another HEAD", async () => {
        const repository = await createRepository();
        await expect(
            prepareRelease({
                ...repository,
                baseSha: "0".repeat(40),
                bump: "patch",
                lookupVersion: missing,
            }),
        ).rejects.toThrow("Release base does not match HEAD");
    });

    test("rejects extra tracked changes", async () => {
        const repository = await createRepository(
            `bun -e "await Bun.write('README.md', 'changed\\n')"`,
        );
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("Release versioning changed files other than package.json");
    });

    test("rejects an npm version without a matching tag", async () => {
        const repository = await createRepository();
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: present }),
        ).rejects.toThrow("gelf-client@1.2.4 already exists on npm without a valid retry tag");
    });

    test("rejects a conflicting tag", async () => {
        const repository = await createRepository();
        await command(repository.cwd, "git", "tag", "-a", "v1.2.4", "-m", "conflict");
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("v1.2.4 is not a release commit based on the workflow SHA");
    });
});

describe("inspectRelease", () => {
    test("returns whether npm already contains the checked-out tag", async () => {
        const repository = await createRepository();
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });
        expect(
            await inspectRelease({
                cwd: repository.cwd,
                tag: prepared.tag,
                lookupVersion: present,
            }),
        ).toEqual({ name: "gelf-client", version: "1.2.4", tag: "v1.2.4", published: true });
    });

    test.each([
        ["release-1.2.3", "Release tag must have the form v<semver>"],
        ["v1.2.4", "Release tag v1.2.4 does not match package version 1.2.3"],
    ])("rejects invalid tag %s", async (tag, message) => {
        const repository = await createRepository();
        await expect(
            inspectRelease({ cwd: repository.cwd, tag, lookupVersion: missing }),
        ).rejects.toThrow(message);
    });
});
```

Add a unit test for npm lookup exit handling. A `0` result means present, an
`E404` result means missing, and any other failure must throw:

```ts
test("distinguishes npm presence, absence, and registry failure", async () => {
    const result =
        (exitCode: number, stdout = "", stderr = "") =>
        async () => ({ exitCode, stdout, stderr });
    expect(await lookupNpmVersion("gelf-client", "1.2.4", result(0, '"1.2.4"'))).toBe(true);
    expect(
        await lookupNpmVersion("gelf-client", "1.2.4", result(1, "", "npm error code E404")),
    ).toBe(false);
    await expect(
        lookupNpmVersion("gelf-client", "1.2.4", result(1, "", "npm error code E500")),
    ).rejects.toThrow("Could not query npm for gelf-client@1.2.4");
});
```

- [ ] **Step 2: Include the scripts in type checking**

Change `test/tsconfig.json` from:

```json
"include": ["src", "test/src", "test/package-consumer.ts"]
```

to:

```json
"include": ["src", "scripts", "test/src", "test/package-consumer.ts"]
```

- [ ] **Step 3: Run the tests and confirm the missing module failure**

Run:

```bash
bun test test/src/release.test.ts
bun run test:typecheck
```

Expected: the test and type-check commands fail because `scripts/release.ts`
does not exist.

- [ ] **Step 4: Implement the release engine**

Create `scripts/release.ts` with these exported contracts:

```ts
export type Bump = "patch" | "minor" | "major";
export type RegistryLookup = (name: string, version: string) => Promise<boolean>;
export type CommandRunner = (
    command: string[],
    cwd?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface PreparedRelease {
    action: "create" | "reuse";
    name: "gelf-client";
    version: string;
    tag: string;
}

export interface InspectedRelease {
    name: "gelf-client";
    version: string;
    tag: string;
    published: boolean;
}
```

Implement a default `CommandRunner` with `Bun.spawn`, captured output, and the
caller's environment. `lookupNpmVersion` must execute this exact command:

```ts
["npm", "view", `${name}@${version}`, "version", "--json"];
```

It returns `true` for exit code `0`, returns `false` only when stderr contains
`E404`, and throws for every other exit code.

`prepareRelease` must perform these operations in order:

```ts
assertBump(options.bump);
assert((await git("rev-parse", "HEAD")) === options.baseSha, "Release base does not match HEAD");
await checked(["bun", "pm", "version", options.bump, "--no-git-tag-version"]);
const { name, version } = await readReleasePackage(options.cwd);
const tag = `v${version}`;
await assertOnlyPackageJsonChanged(options.cwd);
const tagCommit = await optionalGitTagCommit(tag);
```

For a missing tag, query npm. Reject an existing registry version. Otherwise
run these commands and return `action: "create"`:

```ts
await checked(["git", "add", "package.json"]);
await checked(["git", "commit", "-m", `release: prepare version ${version}`]);
await checked(["git", "tag", "-a", tag, "-m", tag]);
```

For an existing tag, read `${tag}:package.json`, resolve `${tag}^{commit}^`,
and require both the expected version and `options.baseSha`. Return
`action: "reuse"` without changing the tag.

`readReleasePackage` must reject a package name other than `gelf-client` and a
version outside this pattern:

```ts
/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
```

`inspectRelease` must validate the same package contract, require an exact
`v${version}` tag, require `HEAD` to equal `${tag}^{commit}`, query npm, and
return `InspectedRelease`.

- [ ] **Step 5: Add error-path cases required by 100% coverage**

Extend `test/src/release.test.ts` until every executable line and exported
function in `scripts/release.ts` runs. Add these cases with the exact expected
messages:

| Setup                                               | Expected message                                   |
| --------------------------------------------------- | -------------------------------------------------- |
| Package name is `other-package`                     | `Release package must be gelf-client`              |
| Package version is `1.2.3-beta.1`                   | `Release package version must be stable semver`    |
| Existing retry tag contains a different version     | `v1.2.4 does not contain package version 1.2.4`    |
| Checkout HEAD differs from the supplied publish tag | `Checked-out commit does not match v1.2.4`         |
| A child process exits nonzero in a checked command  | Include the command and stderr in the thrown error |

- [ ] **Step 6: Run focused verification**

Run:

```bash
bun test test/src/release.test.ts
bun run test:typecheck
```

Expected: all release tests pass and TypeScript reports no errors.

- [ ] **Step 7: Commit the release engine**

```bash
git add scripts/release.ts test/src/release.test.ts test/tsconfig.json
git commit -m "test: cover automated release state"
```

---

### Task 2: Automatic Publish Workflow

**Files:**

- Create: `scripts/release-cli.ts`
- Create: `test/src/publish-workflow.test.ts`
- Modify: `.github/workflows/publish.yml`
- Modify: `bunfig.toml`
- Modify: `package.json`

**Interfaces:**

- Consumes: `prepareRelease`, `inspectRelease`, GitHub's event SHA/ref, job output file, and job-scoped `GITHUB_TOKEN`.
- Produces: prepare outputs `action`, `tag`, and `version`; publish output `published`; an automatic release workflow with an exact-tag publish gate.

- [ ] **Step 1: Write failing workflow contract tests**

Create `test/src/publish-workflow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

interface PublishWorkflow {
    on: {
        push: { tags: string[] };
        workflow_dispatch: {
            inputs: Record<
                string,
                {
                    required: boolean;
                    default: string;
                    type: string;
                    options: string[];
                }
            >;
        };
    };
    permissions: Record<string, never>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: {
        prepare: { permissions: Record<string, string> };
        publish: { permissions: Record<string, string> };
    };
}

const workflow = Bun.YAML.parse(
    await Bun.file(".github/workflows/publish.yml").text(),
) as PublishWorkflow;
const packageJson = (await Bun.file("package.json").json()) as {
    scripts: Record<string, string>;
};

describe("Publish workflow", () => {
    test("offers a safe bump selector", () => {
        const bump = workflow.on.workflow_dispatch.inputs.bump;
        expect(bump).toMatchObject({
            required: true,
            default: "patch",
            type: "choice",
            options: ["patch", "minor", "major"],
        });
        expect(workflow.on.workflow_dispatch.inputs.tag).toBeUndefined();
    });

    test("separates Git and npm authority", () => {
        expect(workflow.permissions).toEqual({});
        expect(workflow.jobs.prepare.permissions).toEqual({ contents: "write" });
        expect(workflow.jobs.publish.permissions).toEqual({
            contents: "read",
            "id-token": "write",
        });
    });

    test("serializes releases and preserves tag pushes", () => {
        expect(workflow.on.push.tags).toEqual(["v*"]);
        expect(workflow.concurrency).toEqual({
            group: "npm-publish-${{ github.repository }}",
            "cancel-in-progress": false,
        });
    });

    test("uses the release CLI and an atomic ref push", async () => {
        const text = await Bun.file(".github/workflows/publish.yml").text();
        expect(text).toContain('run: test "$RELEASE_REF" = "refs/heads/main"');
        expect(text).toContain(
            'bun scripts/release-cli.ts prepare "$RELEASE_BUMP" "$RELEASE_BASE_SHA"',
        );
        expect(text).toContain(
            'git push --atomic origin "HEAD:refs/heads/main" "refs/tags/$RELEASE_TAG"',
        );
        expect(text).toContain('bun scripts/release-cli.ts inspect "$RELEASE_TAG"');
    });

    test("audits the checked-out tag without mutating its manifest", async () => {
        const text = await Bun.file(".github/workflows/publish.yml").text();
        expect(text).toContain("run: bun audit");
        expect(text).toContain("run: bun run check");
        expect(text).toContain("run: npm publish --provenance");
        expect(text).not.toContain("bun run security");
        expect(text).not.toContain("npm pkg fix");
        expect(text).not.toContain("NPM_TOKEN");
        expect(text).not.toContain("NPM_CONFIG_TOKEN");
        expect(packageJson.scripts.postversion).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the workflow test and confirm failure**

Run:

```bash
bun test test/src/publish-workflow.test.ts
```

Expected: tests fail because the workflow still requires `tag`, has one job,
uses `bun run security`, and `package.json` still defines `postversion`.

- [ ] **Step 3: Add the CLI adapter**

Create `scripts/release-cli.ts` as a process adapter. It must accept only these
commands:

```text
bun scripts/release-cli.ts prepare <patch|minor|major> <base-sha>
bun scripts/release-cli.ts inspect <v-semver-tag>
```

For `prepare`, call `prepareRelease({ cwd: process.cwd(), bump, baseSha })`. For
`inspect`, call `inspectRelease({ cwd: process.cwd(), tag })`. Append every
result property to the file at `process.env.GITHUB_OUTPUT` as `key=value`. Print
the JSON result when that variable is absent. Catch errors, print the error
message to stderr, and set `process.exitCode = 1`.

Add the adapter path to `bunfig.toml` because the subprocess boundary contains
no release decisions and cannot contribute coverage to the parent `bun test`
process:

```toml
coveragePathIgnorePatterns = ["test/**", "scripts/release-cli.ts"]
```

- [ ] **Step 4: Remove the implicit Git push hook**

Delete this property from `package.json`:

```json
"postversion": "git push --tags && git push"
```

Keep `security: "bun audit"` for regular CI and local use.

- [ ] **Step 5: Replace the Publish workflow**

Set `.github/workflows/publish.yml` to this structure, keeping the currently
pinned action commit hashes:

```yaml
name: Publish

on:
    push:
        tags:
            - "v*"
    workflow_dispatch:
        inputs:
            bump:
                description: "Version increment"
                required: true
                default: patch
                type: choice
                options:
                    - patch
                    - minor
                    - major

permissions: {}

concurrency:
    group: npm-publish-${{ github.repository }}
    cancel-in-progress: false

jobs:
    prepare:
        if: github.event_name == 'workflow_dispatch'
        runs-on: ubuntu-latest
        permissions:
            contents: write
        outputs:
            action: ${{ steps.release.outputs.action }}
            tag: ${{ steps.release.outputs.tag }}
            version: ${{ steps.release.outputs.version }}
        steps:
            - name: Require main
              env:
                  RELEASE_REF: ${{ github.ref }}
              run: test "$RELEASE_REF" = "refs/heads/main"
            - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
              with:
                  ref: ${{ github.sha }}
                  fetch-depth: 0
            - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
            - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
              with:
                  node-version: 24
                  registry-url: "https://registry.npmjs.org"
                  package-manager-cache: false
            - run: bun ci
            - name: Audit dependencies
              run: bun audit
            - run: bun run check
            - name: Configure release identity
              run: |
                  git config user.name "github-actions[bot]"
                  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            - id: release
              name: Prepare version and tag
              env:
                  RELEASE_BUMP: ${{ inputs.bump }}
                  RELEASE_BASE_SHA: ${{ github.sha }}
              run: bun scripts/release-cli.ts prepare "$RELEASE_BUMP" "$RELEASE_BASE_SHA"
            - name: Push release refs
              if: steps.release.outputs.action == 'create'
              env:
                  RELEASE_TAG: ${{ steps.release.outputs.tag }}
              run: git push --atomic origin "HEAD:refs/heads/main" "refs/tags/$RELEASE_TAG"

    publish:
        needs: prepare
        if: always() && (github.event_name == 'push' || needs.prepare.result == 'success')
        runs-on: ubuntu-latest
        permissions:
            contents: read
            id-token: write
        steps:
            - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
              with:
                  ref: ${{ github.event_name == 'push' && github.ref || needs.prepare.outputs.tag }}
                  fetch-depth: 0
            - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
            - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
              with:
                  node-version: 24
                  registry-url: "https://registry.npmjs.org"
                  package-manager-cache: false
            - run: bun ci
            - name: Audit dependencies
              run: bun audit
            - run: bun run check
            - id: release
              name: Validate release tag
              env:
                  RELEASE_TAG: ${{ github.event_name == 'push' && github.ref_name || needs.prepare.outputs.tag }}
              run: bun scripts/release-cli.ts inspect "$RELEASE_TAG"
            - name: Publish package
              if: steps.release.outputs.published != 'true'
              run: npm publish --provenance
```

- [ ] **Step 6: Run workflow and type contract tests**

Run:

```bash
bun test test/src/publish-workflow.test.ts test/src/release.test.ts
bun run test:typecheck
bun -e 'Bun.YAML.parse(await Bun.file(".github/workflows/publish.yml").text())'
```

Expected: all tests pass, TypeScript reports no errors, and Bun parses the
workflow.

- [ ] **Step 7: Run the full local release gate**

Run:

```bash
bun audit
bun run check
bun pm pack --dry-run
git diff --check
```

Expected: Bun reports no advisories; 100% coverage and all package consumers
pass; the dry-run lists both `.mjs` and `.cjs`; Git reports no whitespace
errors.

- [ ] **Step 8: Commit the automatic workflow**

```bash
git add \
  .github/workflows/publish.yml \
  bunfig.toml \
  package.json \
  scripts/release-cli.ts \
  test/src/publish-workflow.test.ts
git commit -m "ci: automate npm release versions"
```

---

### Task 3: Remote Release Proof

**Files:**

- Verify: `.github/workflows/ci.yml`
- Verify: `.github/workflows/publish.yml`
- Verify: `package.json`

**Interfaces:**

- Consumes: the implementation commits on local `main`, GitHub Actions, and npm Trusted Publishing for `izatop/gelf-client/publish.yml`.
- Produces: green CI plus a release commit, `v0.1.14`, and `gelf-client@0.1.14` when the starting version remains `0.1.13`.

- [ ] **Step 1: Inspect the exact outgoing commits**

Run:

```bash
git status --short --branch
git log --oneline origin/main..main
git diff --stat origin/main..main
```

Expected: the branch contains the design, plan, release-engine, and workflow
commits; no uncommitted file remains.

- [ ] **Step 2: Push `main` and wait for CI**

Run:

```bash
git push origin main
```

Inspect the CI run for the pushed head. Expected: `bun run security` and
`bun run check` pass.

- [ ] **Step 3: Dispatch one patch release from `main`**

In GitHub Actions, open **Publish -> Run workflow**, select branch `main`, keep
`patch`, and start the run. Do not type a tag; the form no longer accepts one.

Expected prepare outputs from a `0.1.13` base:

```text
action=create
version=0.1.14
tag=v0.1.14
```

- [ ] **Step 4: Monitor both release jobs**

Expected:

- `prepare` passes install, audit, checks, version validation, and atomic push;
- `publish` checks out `v0.1.14`, repeats the gates, validates the tag, and
  completes `npm publish --provenance`.

If the atomic push returns `403`, inspect **Settings -> Actions -> General ->
Workflow permissions** and applicable organization rules. Granting repository
write access to the workflow is the only manual permission change in this
design; do not create a PAT or npm token.

- [ ] **Step 5: Verify Git and npm state**

Run:

```bash
git fetch origin main --tags
git merge --ff-only origin/main
git show --no-patch --format='%H %P %s' v0.1.14
git show v0.1.14:package.json | bun -e 'const value = await Bun.stdin.json(); console.log(value.version)'
npm view gelf-client@0.1.14 version --json
git status --short --branch
```

Expected: the tag points to `release: prepare version 0.1.14`, its parent is
the workflow event SHA, both package queries print `0.1.14`, and local `main`
matches `origin/main` with a clean worktree.

## Final Verification Matrix

| Check                              | Command or evidence                              | Expected result                                |
| ---------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Release unit and integration tests | `bun test test/src/release.test.ts`              | Pass                                           |
| Workflow structure                 | `bun test test/src/publish-workflow.test.ts`     | Pass                                           |
| Strict security                    | `bun audit`                                      | No advisories                                  |
| Repository gate                    | `bun run check`                                  | 100% coverage and both consumers pass          |
| Package contents                   | `bun pm pack --dry-run`                          | `.mjs`, `.cjs`, maps, and declarations present |
| CI                                 | GitHub Actions CI for pushed implementation head | Green                                          |
| Release refs                       | `git show v0.1.14`                               | Matching version commit and parent             |
| npm                                | `npm view gelf-client@0.1.14 version --json`     | `"0.1.14"`                                     |
