# npm Trusted Publishing Implementation Plan

> **Status update (2026-08-01):** The `v0.1.12` recovery described below was
> superseded after the failed publish exposed non-canonical repository metadata
> and the package dependency classification changed. The tag remains unchanged
> and unpublished. The corrected package will be released as `v0.1.13`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing `gelf-client@0.1.12` release through npm Trusted Publishing without a long-lived npm token.

**Architecture:** GitHub Actions will keep Bun for installation and repository checks, then use Node 24 and the npm CLI for the OIDC-authenticated publish step. A manual `tag` input will let the current workflow definition publish the unchanged `v0.1.12` tag without accepting a branch or commit SHA.

**Tech Stack:** GitHub Actions, Bun 1.3.14, Node.js 24, npm Trusted Publishing, OpenID Connect

## Global Constraints

- Keep `v0.1.12` at commit `40d4fe595f8dd744678ed92f392a6f6d3130ad92`.
- Keep Bun as the dependency installer and check runner.
- Use `npm publish` for publication.
- Do not reference `NPM_TOKEN`, `NPM_CONFIG_TOKEN`, or another long-lived npm credential.
- Run on a GitHub-hosted `ubuntu-latest` runner.
- Configure no GitHub Environment.
- Publish `0.1.12`; do not create `0.1.13`.
- Resolve manual recovery inputs under `refs/tags/` only.

---

### Task 1: Convert the Publish Workflow to OIDC

**Files:**

- Modify: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: Git tag pushes matching `v*`, or a manual `workflow_dispatch` string input named `tag`.
- Produces: A checked package published by `npm publish` with a GitHub OIDC identity token.

- [x] **Step 1: Run a failing workflow-contract check**

Run:

```bash
ruby -e '
  text = File.read(".github/workflows/publish.yml")
  required = [
    "workflow_dispatch:",
    "id-token: write",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "node-version: 24",
    "npm publish",
    "format('refs/tags/{0}', inputs.tag)"
  ]
  forbidden = ["NPM_TOKEN", "NPM_CONFIG_TOKEN", "bun publish", "inputs.ref"]
  missing = required.reject { |item| text.include?(item) }
  present = forbidden.select { |item| text.include?(item) }
  abort "missing=#{missing.inspect} forbidden=#{present.inspect}" unless missing.empty? && present.empty?
'
```

Expected: FAIL and report the missing OIDC entries plus the current token and
`bun publish` references.

- [x] **Step 2: Replace the workflow with the OIDC design**

Set `.github/workflows/publish.yml` to:

```yaml
name: Publish

on:
    push:
        tags:
            - "v*"
    workflow_dispatch:
        inputs:
            tag:
                description: "Tag to publish, for example v0.1.12"
                required: true
                type: string

permissions:
    contents: read
    id-token: write

jobs:
    publish:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
              with:
                  ref: ${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.ref }}
            - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
            - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
              with:
                  node-version: 24
                  registry-url: "https://registry.npmjs.org"
                  package-manager-cache: false
            - run: bun ci
            - run: bun run check
            - run: npm publish
```

- [x] **Step 3: Run the workflow-contract check again**

Run the Ruby command from Step 1.

Expected: exit code 0 with no output.

- [x] **Step 4: Parse the workflow as YAML**

Run:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/publish.yml")'
```

Expected: exit code 0.

- [x] **Step 5: Commit the workflow change**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: publish to npm with OIDC"
```

### Task 2: Verify the Repository and Package

**Files:**

- Verify: `.github/workflows/ci.yml`
- Verify: `.github/workflows/publish.yml`
- Verify: `package.json`
- Verify: generated package contents

**Interfaces:**

- Consumes: The OIDC workflow from Task 1.
- Produces: Local evidence that code checks and package construction remain unchanged.

- [x] **Step 1: Install the locked dependencies**

Run:

```bash
bun ci
```

Expected: exit code 0 and Bun 1.3.14 dependencies installed from `bun.lock`.

- [x] **Step 2: Run the complete repository check**

Run:

```bash
bun run check
```

Expected: formatting, oxlint, TypeScript checks, 14 Bun tests, build, and the
package-consumer test all pass.

- [x] **Step 3: Inspect the package without publishing**

Run:

```bash
bun pm pack --dry-run
```

Expected: package version `0.1.12`, 33 files, and generated declarations under
`dist/`.

- [x] **Step 4: Parse every workflow and check the diff**

Run:

```bash
ruby -e 'require "yaml"; Dir[".github/workflows/*.{yml,yaml}"].each { |path| YAML.load_file(path) }'
git diff --check HEAD^
git status --short --branch
```

Expected: YAML parsing and whitespace checks pass. The branch is ahead of
`origin/master` only by the intentional commits and the worktree is clean.

### Task 3: Configure npm and Publish the Existing Tag

**Files:**

- External configuration: npm package `gelf-client` Trusted Publisher
- External execution: GitHub Actions workflow `publish.yml`

**Interfaces:**

- Consumes: npm publisher identity `izatop/gelf-client/publish.yml` and Git tag `v0.1.12`.
- Produces: npm package `gelf-client@0.1.12` with provenance.

- [ ] **Step 1: Push the workflow commits to `master`**

Run:

```bash
git push origin master
```

Expected: `origin/master` contains the specification, plan, and OIDC workflow.

- [ ] **Step 2: Configure the npm Trusted Publisher**

Open the `gelf-client` package settings on npmjs.com and create this publisher:

```text
Provider: GitHub Actions
Organization or user: izatop
Repository: gelf-client
Workflow filename: publish.yml
Environment: empty
Allowed action: npm publish
```

Expected: npm lists GitHub Actions as the package's single trusted publisher.

- [ ] **Step 3: Dispatch the recovery publication**

Run the `Publish` workflow from the `master` branch with:

```text
tag: v0.1.12
```

The equivalent GitHub API request is:

```text
POST /repos/izatop/gelf-client/actions/workflows/publish.yml/dispatches
{"ref":"master","inputs":{"tag":"v0.1.12"}}
```

Expected: checkout resolves `v0.1.12`, Bun checks pass, and `npm publish`
completes through OIDC.

- [ ] **Step 4: Confirm the registry version**

Run:

```bash
npm view gelf-client version --json
```

Expected:

```json
"0.1.12"
```

- [ ] **Step 5: Record publication completion**

Mark all completed steps in this plan, then run:

```bash
git add docs/superpowers/plans/2026-07-30-npm-trusted-publishing.md
git commit -m "docs: record npm trusted publication"
git push origin master
```

Expected: `master` records the successful release and the worktree is clean.
