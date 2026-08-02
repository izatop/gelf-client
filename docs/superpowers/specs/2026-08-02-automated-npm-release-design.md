# Automated npm Release

## Goal

Let a maintainer publish a new `gelf-client` version from the GitHub Actions
Publish workflow without preparing the version commit or tag by hand. The
manual form offers `patch`, `minor`, and `major`, with `patch` selected by
default.

The workflow keeps Bun as the package manager, build tool, test runner, and
dependency auditor. npm remains the publication client because npm Trusted
Publishing uses the existing `publish.yml` OIDC identity.

## Problem Before Implementation

`package.json` and npm both report version `0.1.13`. The repository has a
`v0.1.13` tag, but it has no `v0.1.14` tag.

The Publish workflow accepted a tag name during `workflow_dispatch` and asked
`actions/checkout` to fetch that tag. Entering `v0.1.14` failed during checkout
because the workflow did not create the version commit or tag. Entering
`v0.1.13` reached the dependency audit, but that historical tag did not define
the newer `security` package script.

`package.json` also defined `postversion` as `git push --tags && git push`. Bun
ran that script even when `bun pm version` received
`--no-git-tag-version`. The release workflow could not use that script because
it pushed refs before the workflow validated their exact names and relationship.

## Implemented Decision

The implementation uses three jobs in `.github/workflows/publish.yml`:

| Job        | Responsibility                                                      |
| ---------- | ------------------------------------------------------------------- |
| `prepare`  | Validate `main`, create the version commit and tag, push both refs  |
| `validate` | Check the immutable tag, run Bun gates, create and hash the tarball |
| `publish`  | Verify the tarball digest and publish it through npm OIDC           |

The three-job split replaced the earlier two-job proposal. Repository code no
longer runs in the job that has `id-token: write`. The publish job receives no
checkout permission, Bun installation, dependency installation, or repository
script. It downloads the tarball created by `validate`, checks the SHA-256
digest, and calls npm with lifecycle scripts disabled.

`scripts/release.ts` implements the release state rules. `prepareRelease`
validates the bump, base SHA, changed-file set, npm state, annotated tag, and
release parent. `inspectRelease` checks the tag against the checked-out package
and npm. `pushRelease` provides the atomic-push contract used by integration
tests. `scripts/release-cli.ts` exposes these operations to GitHub Actions and
writes typed results to `GITHUB_OUTPUT`.

The workflow itself performs the final Git push so `github.token` exists in one
hook-disabled step. Both checkouts use `persist-credentials: false`. The push
step clears inherited credential helpers, limits token delivery to
`github.com`, and names the `main` and tag refs in one atomic command.

The implementation removed the `postversion` push hook. A full workflow rerun
uses an artifact name that includes `github.run_attempt`; a failed publish-only
rerun reuses the artifact and outputs from its successful validation job. An
existing npm version causes validation and publication to exit without a
second publish.

Local verification on 2026-08-02 produced these results:

- `bun run check`: 67 tests passed, 0 failed, with 100% function and line
  coverage; the command also built and consumed the `.mjs` and `.cjs` package;
- `bun audit`: `No vulnerabilities found`;
- reviewers confirmed fixes for all six release-hardening findings and found no
  new Critical or Important issue.

The remote `patch` rollout remained pending when this record was written.
Version `0.1.14`, tag `v0.1.14`, npm publication, and the GitHub-hosted run need
remote verification after the implementation reaches `main`.

## Workflow Inputs and Triggers

The Publish workflow retains the `push.tags: v*` trigger for maintainers
who create a release tag outside GitHub Actions.

The `workflow_dispatch` form replaces the free-form `tag` field with a
required `bump` choice:

- `patch`, selected by default;
- `minor`;
- `major`.

A manual release must start from `main`. The prepare job compares the event
ref with `refs/heads/main` and stops before changing Git history when they differ.
It uses the event's `GITHUB_SHA` as the release base. GitHub keeps that SHA
when a maintainer reruns the workflow.

## Prepare Job

The `prepare` job runs only for `workflow_dispatch` and performs these steps:

1. Checks out the event SHA with full tag history and without persisted credentials.
2. Installs the Bun version declared by `packageManager` and runs `bun ci`.
3. Runs `bun audit` and `bun run check`.
4. Calls `bun pm version <bump> --no-git-tag-version`.
5. Reasserts that `HEAD` still equals the event SHA.
6. Reads the resulting version from `package.json` and derives tag `v<version>`.
7. Verifies the changed-file set.
8. Checks Git tags and the npm registry for the target version.
9. Creates `release: prepare version <version>` and an annotated tag, then verifies
   that its commit parent is the event SHA.
10. Pushes `main` and the tag with one `git push --atomic` command.

The repository has no `postversion` script. The workflow owns each Git
operation and names both pushed refs in the command.

The checkout does not retain the write credential while dependencies or
repository scripts execute. Only the final atomic-push step receives the
short-lived `github.token`. That step disables Git hooks, uses Git's
credential protocol so the token is absent from process arguments and errors,
resets inherited credential helpers, refuses token requests for hosts other than
`github.com`, and pushes directly to
`https://github.com/<github.repository>.git`.

The current `bun.lock` workspace entry does not store the root package version.
The version command should therefore change only `package.json`. The prepare job
fails if another tracked file changes.

The atomic push protects both refs from partial release state. Git rejects
the push if another commit reaches `main` after the event SHA. The maintainer can
start a new release from the updated branch in that case.

## Validation Job

The `validate` job consumes the tag produced by `prepare` during a manual
release. For a `v*` push, it uses `github.ref`. The job has
`contents: read` and no OIDC permission.

The job checks out the exact tag without persisted credentials, installs Bun
and Node 24, then runs:

```text
bun ci
bun audit
bun run check
```

The direct `bun audit` call also works for an older tag that lacks the
`security` package script. CI on `main` uses
`bun run security` as the repository-facing command.

Before packaging, the job confirms that:

- the ref has the form `v<semver>`;
- the tag version equals `package.json.version`;
- the package name remains `gelf-client`;
- the target version does not conflict with npm state.

When npm does not contain the target version, the validation job runs
`mkdir -p .release && bun pm pack --filename .release/package.tgz --ignore-scripts`,
calculates its SHA-256 digest, and uploads it as a one-day workflow artifact. The
artifact name is `npm-package-<version>-<github.run_attempt>` and flows
to `publish` through the `validate` job's `artifact-name` output. The upload
action uses a full commit SHA.

## Publication Job

The `publish` job receives `id-token: write` and no repository-content
permission. It does not check out the release tag, install package dependencies,
or run repository scripts.

The job installs Node 24, downloads the validated tarball through a pinned
official artifact action, and compares its SHA-256 digest with the validation-job
output. It then runs:

```text
npm publish .release/package.tgz --ignore-scripts --provenance
```

`--ignore-scripts` prevents package lifecycle code from running in the job that
can request an npm OIDC token. The workflow does not run `npm pkg fix`; the
tarball manifest must match the validated tag.

## Idempotency and Failure Handling

The workflow puts every Publish run in one concurrency group and does not
cancel an active release.

The prepare job handles an existing target tag as a retry only when all of
these checks pass:

- the tag names the version derived from the original event SHA and bump;
- the tagged commit contains that version in `package.json`;
- the tagged release commit has the original event SHA as its parent.

If those checks pass, the job reuses the tag instead of creating another
version. A conflicting tag stops the workflow.

The validation job queries npm before packaging. If npm already contains the
version and the local tag checks pass, it reports the release as present and
skips artifact upload. The publication job then skips. A maintainer may
therefore rerun either failed jobs or the full workflow without publishing a
second version.

A full workflow rerun increments `github.run_attempt`, so validation uploads a
new immutable artifact instead of colliding with the earlier attempt. A rerun
of only the failed `publish` job retains the original successful `validate`
outputs and downloads the original attempt's artifact.

Failures have these outcomes:

| Failure point                            | Repository and npm state                                | Recovery                                        |
| ---------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| Install, audit, or checks                | No release commit, tag, or npm version                  | Fix the failure and dispatch again              |
| Version validation                       | No pushed refs or npm version                           | Correct the conflict and dispatch again         |
| Atomic push                              | Neither release ref changes                             | Dispatch from the new `main` head               |
| Publish after push                       | Release commit and tag exist; npm version may be absent | Rerun the workflow; it reuses the validated tag |
| Response lost after npm accepted publish | Commit, tag, and npm version exist                      | Rerun; the registry check exits successfully    |

## Permissions

GitHub creates a short-lived `GITHUB_TOKEN` for each workflow run. Maintainers
do not create or store this token as a repository secret.

The workflow grants permissions per job:

| Job        | Permissions       | Purpose                                       |
| ---------- | ----------------- | --------------------------------------------- |
| `prepare`  | `contents: write` | Push the release commit and tag               |
| `validate` | `contents: read`  | Check the tag and create the package artifact |
| `publish`  | `id-token: write` | Publish the validated tarball through OIDC    |

The prepare and validation jobs cannot request an npm OIDC token. The publish
job cannot read Git refs or execute code from the release checkout.

Both checkouts set `persist-credentials: false`. The prepare job's write token
exists only in the final hook-disabled atomic-push step; validation never gets a
write credential.

Repository or organization policy can cap `GITHUB_TOKEN` permissions. If that
policy blocks `contents: write`, the atomic push fails with no npm publish.
The maintainer can then inspect **Settings -> Actions -> General -> Workflow
permissions** or the applicable organization policy. No token secret is needed.

## Verification

Local verification performs these checks:

- Parses `publish.yml` as YAML.
- Asserts the trigger, input choices, concurrency group, job conditions,
  job-level permissions, checkout refs, and credential persistence flags.
- Asserts the exact pack command, attempt-specific artifact output/upload/download
  wiring, validation outputs, and publish idempotency condition.
- Exercises the version and tag validation logic in a temporary Git repository.
- Rejects a version lifecycle that commits another tracked file and moves HEAD.
- Verifies tarball digest checks and the absence of checkout or Bun steps from
  the OIDC-enabled job.
- Smoke-tests the exact script-disabled pack command in a temporary directory and
  runs `bun audit`, `bun run check`, and `bun pm pack --dry-run`.
- Confirms that `package.json` has no `postversion` script.

Remote verification remains pending. Dispatch a `patch` release from `main`
while npm and `package.json` remain at `0.1.13`. The run must create the release
commit and `v0.1.14`, publish `gelf-client@0.1.14`, and finish with all jobs
green.

## Acceptance Criteria

- Publish offers `patch`, `minor`, and `major`; `patch` is the default.
- A manual run from `main` creates one version commit and matching annotated
  tag.
- Bun installs dependencies, audits them, runs checks, and builds both package
  formats.
- The validation job verifies the package version against the tag and produces
  a hashed tarball artifact.
- The OIDC-enabled job does not check out or execute release code.
- npm Trusted Publishing uses `publish.yml` and a job-scoped OIDC token.
- The workflow stores no npm or GitHub write token in repository secrets.
- Parallel or repeated runs cannot create conflicting versions.
- A failed publish can reuse its existing validated tag.
- A tag-push release still works.

## Out of Scope

- prerelease identifiers such as `beta` or `rc`;
- changelog generation or GitHub Release creation;
- a release pull request bot;
- automatic selection of `minor` or `major` from commit messages;
- npm staged publishing or a GitHub deployment environment.

## References

- [Bun package manager utilities](https://bun.sh/docs/pm/cli/pm)
- [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub workflow reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
- [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm publish](https://docs.npmjs.com/cli/publish/)
