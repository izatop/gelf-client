# Automated npm Release Design

## Goal

Let a maintainer publish a new `gelf-client` version from the GitHub Actions
Publish workflow without preparing the version commit or tag by hand. The
manual form will offer `patch`, `minor`, and `major`, with `patch` selected by
default.

The workflow will keep Bun as the package manager, build tool, test runner, and
dependency auditor. npm will remain the publication client because npm Trusted
Publishing uses the existing `publish.yml` OIDC identity.

## Current State

`package.json` and npm both report version `0.1.13`. The repository has a
`v0.1.13` tag, but it has no `v0.1.14` tag.

The Publish workflow accepts a tag name during `workflow_dispatch` and asks
`actions/checkout` to fetch that tag. Entering `v0.1.14` fails during checkout
because the workflow does not create the version commit or tag. Entering
`v0.1.13` reaches the dependency audit, but that historical tag does not define
the newer `security` package script.

`package.json` also defines `postversion` as `git push --tags && git push`. Bun
runs that script even when `bun pm version` receives
`--no-git-tag-version`. The release workflow cannot use that script because it
pushes refs before the workflow validates their exact names and relationship.

## Workflow Inputs and Triggers

The Publish workflow will retain the `push.tags: v*` trigger for maintainers
who create a release tag outside GitHub Actions.

The `workflow_dispatch` form will replace the free-form `tag` field with a
required `bump` choice:

- `patch`, selected by default;
- `minor`;
- `major`.

A manual release must start from `main`. The prepare job will compare the event
ref with `refs/heads/main` and stop before changing Git history when they differ.
It will use the event's `GITHUB_SHA` as the release base. GitHub keeps that SHA
when a maintainer reruns the workflow.

## Prepare Job

The `prepare` job will run only for `workflow_dispatch`. It will:

1. check out the event SHA with full tag history;
2. install the Bun version declared by `packageManager` and run `bun ci`;
3. run `bun audit` and `bun run check`;
4. call `bun pm version <bump> --no-git-tag-version`;
5. read the resulting version from `package.json` and derive tag `v<version>`;
6. verify the changed-file set;
7. check Git tags and the npm registry for the target version;
8. create `release: prepare version <version>` and an annotated tag;
9. push `main` and the tag with one `git push --atomic` command.

The repository will remove `postversion`. The workflow will own each Git
operation and name both pushed refs in the command.

The current `bun.lock` workspace entry does not store the root package version.
The version command should therefore change only `package.json`. The prepare job
will fail if another tracked file changes.

The atomic push protects both refs from partial release state. Git will reject
the push if another commit reaches `main` after the event SHA. The maintainer can
start a new release from the updated branch in that case.

## Validation Job

The `validate` job will consume the tag produced by `prepare` during a manual
release. For a `v*` push, it will use `github.ref`. The job will have
`contents: read` and no OIDC permission.

The job will check out the exact tag, install Bun and Node 24, then run:

```text
bun ci
bun audit
bun run check
```

The direct `bun audit` call also works for an older tag that lacks the
`security` package script. CI on `main` will continue to use
`bun run security` as the repository-facing command.

Before packaging, the job will confirm that:

- the ref has the form `v<semver>`;
- the tag version equals `package.json.version`;
- the package name remains `gelf-client`;
- the target version does not conflict with npm state.

When npm does not contain the target version, the validation job will create
`.release/package.tgz` with `bun pm pack --ignore-scripts`, calculate its
SHA-256 digest, and upload it as a one-day workflow artifact. The upload action
will use a full commit SHA.

## Publication Job

The `publish` job will receive `id-token: write` and no repository-content
permission. It will not check out the release tag, install package dependencies,
or run repository scripts.

The job will install Node 24, download the validated tarball through a pinned
official artifact action, and compare its SHA-256 digest with the validation-job
output. It will then run:

```text
npm publish .release/package.tgz --ignore-scripts --provenance
```

`--ignore-scripts` prevents package lifecycle code from running in the job that
can request an npm OIDC token. The workflow will not run `npm pkg fix`; the
tarball manifest must match the validated tag.

## Idempotency and Failure Handling

The workflow will put every Publish run in one concurrency group and will not
cancel an active release.

The prepare job will handle an existing target tag as a retry only when all of
these checks pass:

- the tag names the version derived from the original event SHA and bump;
- the tagged commit contains that version in `package.json`;
- the tagged release commit has the original event SHA as its parent.

If those checks pass, the job will reuse the tag instead of creating another
version. A conflicting tag will stop the workflow.

The validation job will query npm before packaging. If npm already contains the
version and the local tag checks pass, it will report the release as present and
skip artifact upload. The publication job will then skip. A maintainer may
therefore rerun either failed jobs or the full workflow without publishing a
second version.

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

The workflow will grant permissions per job:

| Job        | Permissions       | Purpose                                       |
| ---------- | ----------------- | --------------------------------------------- |
| `prepare`  | `contents: write` | Push the release commit and tag               |
| `validate` | `contents: read`  | Check the tag and create the package artifact |
| `publish`  | `id-token: write` | Publish the validated tarball through OIDC    |

The prepare and validation jobs cannot request an npm OIDC token. The publish
job cannot read Git refs or execute code from the release checkout.

Repository or organization policy can cap `GITHUB_TOKEN` permissions. If that
policy blocks `contents: write`, the atomic push will fail with no npm publish.
The maintainer can then inspect **Settings -> Actions -> General -> Workflow
permissions** or the applicable organization policy. No token secret is needed.

## Validation

Local validation will:

- parse `publish.yml` as YAML;
- assert the trigger, input choices, concurrency group, job conditions, and
  job-level permissions;
- exercise the version and tag validation logic in a temporary Git repository;
- verify tarball digest checks and the absence of checkout or Bun steps from
  the OIDC-enabled job;
- run `bun audit`, `bun run check`, and `bun pm pack --dry-run`;
- confirm that `package.json` has no `postversion` script.

Remote validation will dispatch a `patch` release from `main`. The expected
release is `0.1.14` while npm and `package.json` remain at `0.1.13`. The run must
create the release commit and `v0.1.14`, publish `gelf-client@0.1.14`, and finish
with all jobs green.

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
