# Automated npm Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual existing-tag input with a safe `patch`/`minor`/`major` release that creates the version commit and tag, then publishes that exact tag through npm Trusted Publishing.

**Architecture:** A tested Bun module will own version, Git-tag, retry, and npm-state validation. The workflow has three jobs: `prepare` creates the release state and performs a credential-scoped atomic push, `validate` checks the exact tag and produces a digest-checked attempt-specific artifact, and `publish` consumes only that tarball through OIDC. The workflow will keep tag-push support and make reruns idempotent.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, `bun:test`, Git, GitHub Actions, Node.js 24, npm Trusted Publishing.

## Global Constraints

- The manual input is a required `patch`, `minor`, or `major` choice; `patch` is the default.
- Manual releases start only from `refs/heads/main` and use the event `GITHUB_SHA` as their base.
- Bun runs dependency installation, the strict audit, tests, type checks, and both package builds.
- `prepare` receives only `contents: write`; `validate` receives only `contents: read`; `publish` receives only `id-token: write`.
- Release commit and annotated tag refs are pushed together with `git push --atomic`.
- Prepare and validation checkouts use `persist-credentials: false`; only the final atomic-push step receives `github.token`.
- The token is provided through a host-restricted Git credential helper after inherited helpers are reset, Git hooks are disabled for the push, and the remote is the canonical `github.repository` URL.
- Validation names artifacts with `github.run_attempt` and passes the exact name to `publish` through a job output.
- The workflow publishes through `npm publish --provenance`; it contains no long-lived npm token.
- The direct validation audit is `bun audit`, so tag validation does not depend on a package script.
- The tagged `package.json` is immutable during publish; remove `npm pkg fix` from the workflow.
- The OIDC-enabled job receives a validated tarball artifact, verifies its SHA-256 digest, and runs no release checkout or package script.
- Publish the tarball with `npm publish .release/package.tgz --ignore-scripts --provenance`.
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
- Modify `.github/workflows/publish.yml`: add the three-job prepare/validate/publish pipeline and automatic bump input.

---

### Task 1: Tested Release State Engine

**Files:**

- Create: `scripts/release.ts`
- Create: `test/src/release.test.ts`
- Modify: `test/tsconfig.json`

**Interfaces:**

- Consumes: Git CLI, `bun pm version`, `npm view`, a repository path, `Bump`, and an event base SHA.
- Produces: `prepareRelease(options): Promise<PreparedRelease>`, `pushRelease(options): Promise<void>`, and `inspectRelease(options): Promise<InspectedRelease>` for the CLI and workflow.

- [ ] **Step 1: Add failing public-contract tests**

Create `test/src/release.test.ts` with a temporary Git repository helper. The
helper must use filesystem APIs, configure a local Git identity, and create a
base commit at version `1.2.3`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    inspectRelease,
    lookupNpmVersion,
    prepareRelease,
    pushRelease,
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

describe("pushRelease", () => {
    test("pushes main and the release tag to a bare remote", async () => {
        const repository = await createRepository();
        const remote = await mkdtemp(join(tmpdir(), "gelf-release-remote-"));
        directories.push(remote);
        await command(remote, "git", "init", "--bare", "--initial-branch=main");
        await command(repository.cwd, "git", "remote", "add", "origin", remote);
        await command(
            repository.cwd,
            "git",
            "push",
            "origin",
            `${repository.baseSha}:refs/heads/main`,
        );
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });

        await pushRelease({ cwd: repository.cwd, tag: prepared.tag });

        const remoteMain = await command(remote, "git", "rev-parse", "refs/heads/main");
        const remoteTag = await command(remote, "git", "rev-parse", "refs/tags/v1.2.4^{commit}");
        expect(remoteMain).toBe(remoteTag);
    });

    test("leaves main unchanged when the remote rejects the tag", async () => {
        const repository = await createRepository();
        const remote = await mkdtemp(join(tmpdir(), "gelf-release-remote-"));
        directories.push(remote);
        await command(remote, "git", "init", "--bare", "--initial-branch=main");
        await command(repository.cwd, "git", "remote", "add", "origin", remote);
        await command(
            repository.cwd,
            "git",
            "push",
            "origin",
            `${repository.baseSha}:refs/heads/main`,
        );
        const hook = join(remote, "hooks", "pre-receive");
        await writeFile(
            hook,
            '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/tags/*) exit 1;; esac\ndone\n',
        );
        await chmod(hook, 0o755);
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });

        await expect(pushRelease({ cwd: repository.cwd, tag: prepared.tag })).rejects.toThrow();
        expect(await command(remote, "git", "rev-parse", "refs/heads/main")).toBe(
            repository.baseSha,
        );
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

Export `pushRelease({ cwd, tag })`. It must validate the stable tag format and
execute this argument vector through the checked command runner:

```ts
["git", "push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`];
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
assert(
    (await git("rev-parse", "HEAD")) === options.baseSha,
    "Release base does not match HEAD after versioning",
);
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

Before returning, resolve `${tag}^{commit}^` and require it to equal
`options.baseSha`.

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

| Setup                                               | Expected message                                           |
| --------------------------------------------------- | ---------------------------------------------------------- |
| Package name is `other-package`                     | `Release package must be gelf-client`                      |
| Package version is `1.2.3-beta.1`                   | `Release package version must be stable semver`            |
| Existing retry tag contains a different version     | `v1.2.4 does not contain package version 1.2.4`            |
| Checkout HEAD differs from the supplied publish tag | `Checked-out commit does not match v1.2.4`                 |
| Version lifecycle commits another tracked file      | `Release base does not match HEAD after versioning`        |
| A commit hook moves the newly created release tag   | `v1.2.4 is not a release commit based on the workflow SHA` |
| A child process exits nonzero in a checked command  | Include the command and stderr in the thrown error         |

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
- Modify: `test/src/release.test.ts`
- Modify: `.github/workflows/publish.yml`
- Modify: `bunfig.toml`
- Modify: `package.json`

**Interfaces:**

- Consumes: `prepareRelease`, `inspectRelease`, GitHub's event SHA/ref, job output file, and a step-scoped `github.token` used only by the final atomic push.
- Produces: prepare outputs `action`, `tag`, and `version`; validation outputs `published`, `version`, `package-sha256`, and `artifact-name`; an automatic release workflow whose OIDC job consumes only the validated tarball.

- [ ] **Step 1: Write failing workflow and CLI contract tests**

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
        prepare: {
            if: string;
            permissions: Record<string, string>;
        };
        validate: {
            needs: string;
            if: string;
            permissions: Record<string, string>;
            steps: Array<{
                name?: string;
                uses?: string;
                run?: string;
            }>;
        };
        publish: {
            needs: string;
            if: string;
            permissions: Record<string, string>;
            steps: Array<{
                name?: string;
                uses?: string;
                run?: string;
            }>;
        };
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
        expect(workflow.jobs.validate.permissions).toEqual({ contents: "read" });
        expect(workflow.jobs.publish.permissions).toEqual({ "id-token": "write" });
    });

    test("serializes releases and preserves tag pushes", () => {
        expect(workflow.on.push.tags).toEqual(["v*"]);
        expect(workflow.concurrency).toEqual({
            group: "npm-publish-${{ github.repository }}",
            "cancel-in-progress": false,
        });
    });

    test("routes manual preparation through validation", () => {
        expect(workflow.jobs.prepare.if).toBe("github.event_name == 'workflow_dispatch'");
        expect(workflow.jobs.validate.needs).toBe("prepare");
        expect(workflow.jobs.validate.if).toBe(
            "always() && (github.event_name == 'push' || needs.prepare.result == 'success')",
        );
        expect(workflow.jobs.publish.needs).toBe("validate");
    });

    test("removes the push-on-version package hook", () => {
        expect(packageJson.scripts.postversion).toBeUndefined();
    });

    test("keeps release code outside the OIDC job", () => {
        const privilegedSteps = workflow.jobs.publish.steps;
        expect(privilegedSteps.map((step) => step.uses).filter(Boolean)).toEqual([
            "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
            "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        ]);
        expect(privilegedSteps.map((step) => step.run).filter(Boolean)).toEqual([
            `printf '%s  %s\\n' "$EXPECTED_SHA256" ".release/package.tgz" | sha256sum --check --strict`,
            "npm publish .release/package.tgz --ignore-scripts --provenance",
        ]);
    });
});
```

The YAML tests guard parsed workflow invariants and the allowlist for the two
commands that run with OIDC authority. They also assert both checkout refs and
`persist-credentials` flags, validation outputs and step conditions, the exact
pack command, attempt-specific artifact output/upload/download wiring, the
publish idempotency condition, and the step-scoped token/hook/canonical-remote
boundary. Do not grep the workflow source. Task 1's temporary bare-remote tests
prove the atomic Git behavior. Add subprocess tests to
`test/src/release.test.ts` for the CLI adapter: start a local HTTP server that
returns npm-compatible `404` responses, set `NPM_CONFIG_REGISTRY` to its URL,
run `prepare` with a temporary `GITHUB_OUTPUT` file, and assert these literal
outputs:

```text
action=create
name=gelf-client
version=1.2.4
tag=v1.2.4
```

Run `inspect v1.2.4` from the created release commit and assert
`published=false`. Run `push v1.2.4` against the temporary bare remote from
Task 1 and assert that both remote refs resolve to the release commit.

- [ ] **Step 2: Run the workflow test and confirm failure**

Run:

```bash
bun test test/src/publish-workflow.test.ts
```

Expected on the pre-implementation baseline: tests fail because the workflow
requires `tag`, lacks the prepare/validate split, and `package.json` defines
`postversion`; the CLI subprocess cases fail because `scripts/release-cli.ts`
does not exist. During the security fix round, the new OIDC-boundary test fails
because the former two-job workflow checked out release code in `publish`.

- [ ] **Step 3: Add the CLI adapter**

Create `scripts/release-cli.ts` as a process adapter. It must accept only these
commands:

```text
bun scripts/release-cli.ts prepare <patch|minor|major> <base-sha>
bun scripts/release-cli.ts push <v-semver-tag>
bun scripts/release-cli.ts inspect <v-semver-tag>
```

For `prepare`, call `prepareRelease({ cwd: process.cwd(), bump, baseSha })`. For
`push`, call `pushRelease({ cwd: process.cwd(), tag })`. For `inspect`, call
`inspectRelease({ cwd: process.cwd(), tag })`. Append every result property to
the file at `process.env.GITHUB_OUTPUT` as `key=value`. Print the JSON result
when that variable is absent. Catch errors, print the error message to stderr,
and set `process.exitCode = 1`.

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
                  persist-credentials: false
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
                  RELEASE_REPOSITORY: ${{ github.repository }}
                  GH_TOKEN: ${{ github.token }}
                  GIT_CONFIG_GLOBAL: /dev/null
                  GIT_CONFIG_SYSTEM: /dev/null
                  GIT_CONFIG_COUNT: "4"
                  GIT_CONFIG_KEY_0: core.hooksPath
                  GIT_CONFIG_VALUE_0: /dev/null
                  GIT_CONFIG_KEY_1: credential.username
                  GIT_CONFIG_VALUE_1: x-access-token
                  GIT_CONFIG_KEY_2: credential.helper
                  GIT_CONFIG_VALUE_2: ""
                  GIT_CONFIG_KEY_3: credential.helper
                  GIT_CONFIG_VALUE_3: '!f() { if test "$1" = get && grep -qx "host=github.com"; then printf ''%s\n'' "password=$GH_TOKEN"; fi; }; f'
                  GIT_TERMINAL_PROMPT: "0"
              run: >-
                  git push --atomic "https://github.com/${RELEASE_REPOSITORY}.git"
                  "HEAD:refs/heads/main" "refs/tags/${RELEASE_TAG}"

    validate:
        needs: prepare
        if: always() && (github.event_name == 'push' || needs.prepare.result == 'success')
        runs-on: ubuntu-latest
        permissions:
            contents: read
        outputs:
            published: ${{ steps.release.outputs.published }}
            version: ${{ steps.release.outputs.version }}
            package-sha256: ${{ steps.package.outputs.sha256 }}
            artifact-name: ${{ steps.package.outputs.artifact-name }}
        steps:
            - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
              with:
                  ref: ${{ github.event_name == 'push' && github.ref || needs.prepare.outputs.tag }}
                  fetch-depth: 0
                  persist-credentials: false
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
            - name: Pack validated package
              if: steps.release.outputs.published != 'true'
              run: mkdir -p .release && bun pm pack --filename .release/package.tgz --ignore-scripts
            - id: package
              name: Record package digest
              if: steps.release.outputs.published != 'true'
              env:
                  ARTIFACT_NAME: npm-package-${{ steps.release.outputs.version }}-${{ github.run_attempt }}
              run: |
                  echo "artifact-name=$ARTIFACT_NAME" >> "$GITHUB_OUTPUT"
                  echo "sha256=$(sha256sum .release/package.tgz | cut -d ' ' -f1)" >> "$GITHUB_OUTPUT"
            - name: Upload validated package
              if: steps.release.outputs.published != 'true'
              uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
              with:
                  name: ${{ steps.package.outputs.artifact-name }}
                  path: .release/package.tgz
                  if-no-files-found: error
                  retention-days: 1
                  compression-level: 0

    publish:
        needs: validate
        if: needs.validate.result == 'success' && needs.validate.outputs.published != 'true'
        runs-on: ubuntu-latest
        permissions:
            id-token: write
        steps:
            - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
              with:
                  node-version: 24
                  registry-url: "https://registry.npmjs.org"
                  package-manager-cache: false
            - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
              with:
                  name: ${{ needs.validate.outputs.artifact-name }}
                  path: .release
            - name: Verify package digest
              env:
                  EXPECTED_SHA256: ${{ needs.validate.outputs.package-sha256 }}
              run: printf '%s  %s\n' "$EXPECTED_SHA256" ".release/package.tgz" | sha256sum --check --strict
            - name: Publish package
              run: npm publish .release/package.tgz --ignore-scripts --provenance
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
release_smoke_dir="$(mktemp -d)"
git archive --format=tar HEAD | tar -xf - -C "$release_smoke_dir"
(
    cd "$release_smoke_dir"
    mkdir -p .release && bun pm pack --filename .release/package.tgz --ignore-scripts
)
test -f "$release_smoke_dir/.release/package.tgz"
rm -rf "$release_smoke_dir"
bun pm pack --dry-run
git diff --check
```

Expected: Bun reports no advisories; 100% coverage and all package consumers
pass; the exact script-disabled pack command creates the requested tarball in a
temporary tree; the dry-run lists both `.mjs` and `.cjs`; Git reports no
whitespace errors.

- [ ] **Step 8: Commit the automatic workflow**

```bash
git add \
  .github/workflows/publish.yml \
  bunfig.toml \
  package.json \
  scripts/release-cli.ts \
  test/src/release.test.ts \
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

- [ ] **Step 4: Monitor all release jobs**

Expected:

- `prepare` passes install, audit, checks, version validation, and atomic push;
- `validate` checks out `v0.1.14`, repeats the gates, validates the tag, and
  uploads the hashed package tarball without OIDC permission;
- `publish` verifies the downloaded tarball digest and completes
  `npm publish .release/package.tgz --ignore-scripts --provenance` without a
  repository checkout.

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
| Validation pack command            | Temporary-tree exact pack smoke                  | `.release/package.tgz` exists                  |
| Package contents                   | `bun pm pack --dry-run`                          | `.mjs`, `.cjs`, maps, and declarations present |
| CI                                 | GitHub Actions CI for pushed implementation head | Green                                          |
| Release refs                       | `git show v0.1.14`                               | Matching version commit and parent             |
| npm                                | `npm view gelf-client@0.1.14 version --json`     | `"0.1.14"`                                     |
