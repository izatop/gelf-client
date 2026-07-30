# npm Trusted Publishing Design

## Goal

Publish `gelf-client` from GitHub Actions through npm Trusted Publishing. The
release workflow will use short-lived OIDC credentials instead of the
`NPM_TOKEN` repository secret.

The change must publish the existing `v0.1.12` tag without moving the tag or
creating a replacement version.

## Current State

The `v0.1.12` tag points to commit
`40d4fe595f8dd744678ed92f392a6f6d3130ad92`. Its Publish workflow passed
installation, formatting, linting, type-checking, tests, build, and package
consumer checks. `bun publish` then received a `404 Not Found` response from
npm while using `NPM_CONFIG_TOKEN`.

npm still reports `gelf-client@0.1.11` as the latest published version.

## Workflow Design

`.github/workflows/publish.yml` will keep Bun for dependency installation and
repository checks:

```text
bun ci
bun run check
```

The workflow will add:

- `permissions.id-token: write` so GitHub can mint an OIDC identity token;
- `actions/setup-node` with Node 24 and the public npm registry;
- `npm publish` as the only publication command;
- a `workflow_dispatch` input named `tag` for recovery of an existing tag.

The workflow will remove `NPM_CONFIG_TOKEN` and all references to
`secrets.NPM_TOKEN`.

On tag pushes, checkout will use `github.ref`. On a manual run, checkout will
build `refs/tags/<tag>` from the required `tag` input. The recovery run will
pass `v0.1.12`, so the workflow publishes the package contents already
associated with that tag while executing the current `publish.yml` definition
from `master`. A manual run cannot select a branch or commit SHA.

The workflow will continue to run on GitHub-hosted `ubuntu-latest` runners.

## npm Configuration

The package owner will configure one Trusted Publisher for `gelf-client` on
npmjs.com with these values:

| Field                | Value          |
| -------------------- | -------------- |
| Provider             | GitHub Actions |
| Organization or user | `izatop`       |
| Repository           | `gelf-client`  |
| Workflow filename    | `publish.yml`  |
| Environment          | empty          |
| Allowed action       | `npm publish`  |

The filename contains no path. npm matches it against
`.github/workflows/publish.yml`.

The repository already declares
`https://github.com/izatop/gelf-client` in `package.json`, which matches the
GitHub source used by the trusted publisher.

## Release Recovery

After the workflow change reaches `master` and the npm Trusted Publisher is
configured:

1. dispatch the Publish workflow from `master`;
2. set `tag` to `v0.1.12`;
3. wait for `bun run check` and `npm publish`;
4. confirm that npm reports `gelf-client@0.1.12`.

The recovery process will not force-push or recreate `v0.1.12`. It will not
change the package version.

After the OIDC publication succeeds, the owner may delete the unused
`NPM_TOKEN` repository secret and configure npm to disallow token-based
publishing.

## Validation

Local validation will:

- parse both GitHub Actions workflow files as YAML;
- verify that the Publish workflow contains `id-token: write`,
  `workflow_dispatch`, Node 24, and `npm publish`;
- verify that the workflow contains no `NPM_TOKEN`, `NPM_CONFIG_TOKEN`, or
  `bun publish` reference;
- run `bun run check`;
- run `bun pm pack --dry-run`.

Remote validation will:

- run the manually dispatched workflow for `v0.1.12`;
- confirm that the publish job completes successfully;
- query npm for the published version.

## Failure Handling

An OIDC authentication failure should be investigated against these exact
identifiers:

- GitHub owner: `izatop`;
- repository: `gelf-client`;
- workflow filename: `publish.yml`;
- environment: unset;
- requested tag: `v0.1.12`.

The job must retain `id-token: write`, run on a GitHub-hosted runner, and use a
Trusted Publishing-capable npm CLI. `npm whoami` is not an OIDC diagnostic
because npm exchanges the identity token only during publication.

## Acceptance Criteria

- Bun remains the package manager and check runner in CI.
- GitHub Actions publishes with `npm publish` and OIDC.
- The Publish workflow contains no long-lived npm credential.
- A manual run can target the existing `v0.1.12` tag.
- The tag remains unchanged.
- `gelf-client@0.1.12` appears on npm after the recovery run.

## Out of Scope

- changing package contents or public APIs;
- publishing a new `0.1.13` version;
- moving or recreating `v0.1.12`;
- adding an npm Environment in GitHub;
- changing the regular CI workflow.
