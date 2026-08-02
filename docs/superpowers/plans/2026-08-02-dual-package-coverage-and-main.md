# Dual Package, Full Coverage, and Main Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `.mjs` and `.cjs` entrypoints built by Bun, enforce 100% Bun
coverage, audit all dependencies in CI, and rename the default branch to
`main`.

**Architecture:** Bun bundles `src/index.ts` once per module format while
TypeScript checks both module configurations and emits shared declarations. Bun
tests exercise source behavior and real loopback transports. A packed-package
test runs Node.js ESM and CommonJS consumers before the GitHub branch rename.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, Node.js 24, `bun:test`, GitHub
Actions, GitHub CLI.

## Global Constraints

- Keep the public GELF client methods and wire format unchanged.
- Build JavaScript with `bun build --target=node`.
- Publish `dist/index.mjs` and `dist/index.cjs` with linked source maps.
- Apply syntax minification only. Do not minify whitespace or identifiers.
- Use TypeScript only for type-checking and declaration output.
- Require coverage value `1` for lines, functions, and statements under
  `src/**`.
- Run `bun audit` without a severity filter, production-only filter, or ignored
  advisory.
- Keep GitHub Action references pinned to full commit hashes.
- Do not publish npm, create a tag, or change the package version.
- Execute inline in the current session. Do not dispatch subagents.

---

### Task 1: Build and Verify the Dual Package

**Files:**

- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `tsconfig.esnext.json`
- Create: `tsconfig.cjs.json`
- Modify: `test/package-consumer.ts`

**Interfaces:**

- Consumes: `src/index.ts` default export `Client` plus named exports `Client`
  and `Level`.
- Produces: `dist/index.mjs`, `dist/index.cjs`, linked maps, and
  `dist/types/index.d.ts`; package conditions `import`, `require`, and `types`.

- [ ] **Step 1: Make the package-consumer check demand the dual artifacts**

Add `access` to the `node:fs/promises` imports and define:

```typescript
const assertFile = (path: string) => access(path);
```

After unpacking the tarball, assert these files:

```typescript
await Promise.all(
    [
        "dist/index.mjs",
        "dist/index.mjs.map",
        "dist/index.cjs",
        "dist/index.cjs.map",
        "dist/types/index.d.ts",
    ].map((path) => assertFile(join(installedPackageDirectory, path))),
);
```

Assert the packed manifest export map:

```typescript
const rootExport = packedPackageJson.exports?.["."];
if (
    rootExport?.types !== "./dist/types/index.d.ts" ||
    rootExport?.import !== "./dist/index.mjs" ||
    rootExport?.require !== "./dist/index.cjs"
) {
    throw new Error("The packed package does not expose the dual entrypoints");
}
```

Write `index.mjs` and `index.cjs` consumers in the temporary directory:

```typescript
await writeFile(
    join(consumerDirectory, "index.mjs"),
    [
        `import GELFClient, { Client, Level } from "${packageJson.name}";`,
        'if (GELFClient !== Client) throw new Error("ESM default export mismatch");',
        'if (Level.INFO !== 6) throw new Error("ESM named export mismatch");',
        "",
    ].join("\n"),
);
await writeFile(
    join(consumerDirectory, "index.cjs"),
    [
        `const { default: GELFClient, Client, Level } = require("${packageJson.name}");`,
        'if (GELFClient !== Client) throw new Error("CJS default export mismatch");',
        'if (Level.INFO !== 6) throw new Error("CJS named export mismatch");',
        "",
    ].join("\n"),
);
```

Run both after the existing TypeScript consumer check:

```typescript
await run(["node", "index.mjs"], consumerDirectory);
await run(["node", "index.cjs"], consumerDirectory);
```

- [ ] **Step 2: Run the package-consumer check and capture RED**

Run:

```bash
bun run test:package
```

Expected: FAIL because the current build creates `dist/index.js` and has no
root `exports` map.

- [ ] **Step 3: Split the TypeScript target settings**

Keep shared options in `tsconfig.json`, remove `module`, and prevent direct
JavaScript emission:

```json
{
    "compilerOptions": {
        "target": "esnext",
        "rootDir": "src",
        "declaration": true,
        "sourceMap": true,
        "types": ["node"],
        "strict": true,
        "strictNullChecks": true,
        "forceConsistentCasingInFileNames": true,
        "noImplicitThis": true,
        "noImplicitAny": true,
        "strictPropertyInitialization": true,
        "strictFunctionTypes": true,
        "skipLibCheck": true,
        "incremental": true,
        "noEmit": true
    },
    "exclude": ["node_modules"],
    "include": ["src"]
}
```

Create `tsconfig.esnext.json`:

```json
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "module": "esnext",
        "moduleResolution": "bundler",
        "outDir": "dist/types",
        "tsBuildInfoFile": "dist/tsconfig.esnext.tsbuildinfo"
    }
}
```

Create `tsconfig.cjs.json`:

```json
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "module": "commonjs",
        "outDir": "dist/cjs-types",
        "tsBuildInfoFile": "dist/tsconfig.cjs.tsbuildinfo"
    }
}
```

- [ ] **Step 4: Replace the TypeScript JavaScript build with Bun builds**

Set the package entry fields and export map:

```json
"main": "./dist/index.cjs",
"module": "./dist/index.mjs",
"types": "./dist/types/index.d.ts",
"typings": "./dist/types/index.d.ts",
"exports": {
    ".": {
        "types": "./dist/types/index.d.ts",
        "import": "./dist/index.mjs",
        "require": "./dist/index.cjs",
        "default": "./dist/index.mjs"
    }
}
```

Use these scripts:

```json
"clean": "rimraf dist tsconfig.tsbuildinfo",
"typecheck:source": "tsc -p tsconfig.esnext.json && tsc -p tsconfig.cjs.json",
"build:types": "tsc -p tsconfig.esnext.json --noEmit false --emitDeclarationOnly",
"build:esm": "bun build src/index.ts --target=node --format=esm --packages=external --sourcemap=linked --minify-syntax --outdir=dist --entry-naming=index.mjs",
"build:cjs": "bun build src/index.ts --target=node --format=cjs --packages=external --sourcemap=linked --minify-syntax --outdir=dist --entry-naming=index.cjs",
"build": "bun run clean && bun run typecheck:source && bun run build:types && bun run build:esm && bun run build:cjs"
```

Keep the existing test, format, lint, example, package-consumer, and
`postversion` scripts in this step.

- [ ] **Step 5: Run focused dual-package verification**

Run:

```bash
bun run build
bun run test:package
node --enable-source-maps -e 'import("./dist/index.mjs").then((m) => { if (m.default !== m.Client) process.exit(1); })'
node --enable-source-maps -e 'const m = require("./dist/index.cjs"); if (m.default !== m.Client) process.exit(1)'
```

Expected: both build formats, declarations, package type-check, ESM runtime, and
CommonJS runtime pass.

- [ ] **Step 6: Verify minification and maps without asserting source text in tests**

Run:

```bash
test -f dist/index.mjs.map
test -f dist/index.cjs.map
rg 'class Client|class Serializer' dist/index.mjs dist/index.cjs
```

Expected: both maps exist and Bun preserved public class names. The build
commands contain `--minify-syntax` and omit `--minify-whitespace` and
`--minify-identifiers`.

- [ ] **Step 7: Commit the dual package**

```bash
git add package.json tsconfig.json tsconfig.esnext.json tsconfig.cjs.json test/package-consumer.ts
git commit -m "build: publish dual Bun bundles"
```

### Task 2: Reach and Enforce 100% Source Coverage

**Files:**

- Modify: `bunfig.toml`
- Modify: `test/src/main.test.ts`
- Create: `test/src/config.test.ts`
- Create: `test/src/serializer.test.ts`
- Modify: `test/src/tcp.test.ts`
- Create: `test/src/udp.test.ts`

**Interfaces:**

- Consumes: public `Client`, `Level`, `Serializer`, `TCPTransport`,
  `UDPTransport`, `Transport`, and `parseConnectionString` behavior.
- Produces: a loopback-only test suite with Bun coverage thresholds of `1` for
  lines, functions, and statements.

- [ ] **Step 1: Record the coverage RED signal**

Run:

```bash
bun test --coverage
```

Expected baseline: 14 tests pass while aggregate coverage reports 80.19% of
functions and 93.22% of lines.

- [ ] **Step 2: Limit coverage accounting to production source and set the gate**

Extend `bunfig.toml`:

```toml
[install]
minimumReleaseAge = 259200

[test]
coverage = true
coverageSkipTestFiles = true
coveragePathIgnorePatterns = ["test/**"]
coverageThreshold = { lines = 1, functions = 1, statements = 1 }
```

Run:

```bash
bun test
```

Expected: existing assertions pass, but the command exits nonzero because
production coverage is below 100%.

- [ ] **Step 3: Cover connection parsing and transport registration**

Create `test/src/config.test.ts` with table-driven assertions for:

```typescript
import { expect, test } from "bun:test";
import { parseConnectionString, Transport } from "../../src/config";
import { TestTransport } from "./TestTransport";

test("Connection strings apply defaults and flags", () => {
    expect(parseConnectionString("udp://localhost")).toMatchObject({
        compress: false,
        host: "localhost",
        maxChunkSize: 1400,
        minCompressSize: 1400,
        port: 12201,
        protocol: "udp",
    });
    expect(
        parseConnectionString(
            "udp://graylog:65535/?compress&strict&maxChunkSize=2048&minCompressSize=4096",
        ),
    ).toMatchObject({
        compress: true,
        host: "graylog",
        maxChunkSize: 2048,
        minCompressSize: 4096,
        port: 65535,
        protocol: "udp",
        strictChecks: true,
    });
});

test.each([
    ["tcp://localhost:0", 12201],
    ["tcp://localhost:65536", 12201],
    ["tcp://localhost:not-a-port", 12201],
    ["tcp://localhost/?maxChunkSize=1", 1400],
    ["tcp://localhost/?minCompressSize=NaN", 1400],
])("Connection strings replace invalid numeric values in %s", (dsn, expected) => {
    const parsed = parseConnectionString(dsn);
    const actual = dsn.includes("maxChunkSize")
        ? parsed.maxChunkSize
        : dsn.includes("minCompressSize")
          ? parsed.minCompressSize
          : parsed.port;
    expect(actual).toBe(expected);
});

test("Connection strings require a host and protocol", () => {
    expect(() => parseConnectionString("udp:///missing-host")).toThrow("Empty hostname");
    expect(() => parseConnectionString("//localhost:12201")).toThrow("Empty protocol");
});

test("Transport rejects unknown protocols", () => {
    expect(() => Transport.get("missing")).toThrow("Transport for protocol missing doesn't exists");
    expect(() => Transport.get(123 as unknown as string)).toThrow();
});

test("Transport accepts custom protocols", () => {
    Transport.add("coverage-test", TestTransport);
    expect(Transport.get("coverage-test")).toBe(TestTransport);
});
```

Run:

```bash
bun test test/src/config.test.ts
```

Expected: all parsing and registry cases pass.

- [ ] **Step 4: Cover serializers and asynchronous transport errors**

Create `test/src/serializer.test.ts`. Use a helper that returns complete
`ConnectionOptions`, then add these cases:

```typescript
const options = (overrides: Partial<ConnectionOptions> = {}): ConnectionOptions => ({
    compress: false,
    host: "127.0.0.1",
    maxChunkSize: 1400,
    minCompressSize: 1400,
    port: 12201,
    protocol: "udp",
    strictChecks: true,
    ...overrides,
});

test("Serializer returns a small payload unchanged", async () => {
    const payload = Buffer.from("small");
    expect(await new Serializer(options()).serialize(payload)).toEqual([payload]);
});

test("Serializer chunks an uncompressed payload", async () => {
    const chunks = await new Serializer(
        options({ maxChunkSize: 20, minCompressSize: 1 }),
    ).serialize(Buffer.from("abcdefghijklmnopq"));
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.subarray(12).toString()).join("")).toBe("abcdefghijklmnopq");
});

test("Serializer compresses a chunked payload", async () => {
    const chunks = await new Serializer(
        options({ compress: true, maxChunkSize: 20, minCompressSize: 1 }),
    ).serialize(Buffer.from("payload".repeat(100)));
    expect(chunks[0].subarray(0, 2)).toEqual(Buffer.from([0x1e, 0x0f]));
});

test("Serializer rejects more than 128 chunks", async () => {
    await expect(
        new Serializer(options({ maxChunkSize: 13, minCompressSize: 1 })).serialize(
            Buffer.alloc(129),
        ),
    ).rejects.toThrow("Cannot log messages bigger than 128 bytes");
});
```

Add a `FailingTransport` in the same test file whose `write()` throws and whose
`destroy()` records closure. Await `send()`, listen for `error`, and assert the
error plus `destroy()` call. Run:

```bash
bun test test/src/serializer.test.ts
```

Expected: direct, chunked, compressed, size-error, enqueue-error, and close
paths pass.

- [ ] **Step 5: Cover every client helper and TestTransport shutdown**

Add one table-driven test to `test/src/main.test.ts`:

```typescript
test("Client level helpers send every GELF severity", async () => {
    const client = Client.factory(dsn, { app: "test" });
    const calls = [
        ["emergency", Level.EMERGENCY],
        ["alert", Level.ALERT],
        ["critical", Level.CRITICAL],
        ["error", Level.ERROR],
        ["warning", Level.WARNING],
        ["notice", Level.NOTICE],
        ["info", Level.INFO],
        ["debug", Level.DEBUG],
    ] as const;

    for (const [method, level] of calls) {
        await client[method]({ message: method });
        const payload = JSON.parse(
            (client.transport as TestTransport).written.at(-1)!.toString("utf-8"),
        );
        expect(payload.level).toBe(level);
    }

    client.close();
    expect((client.transport as TestTransport).destroyed).toBe(true);
});
```

Add this production-mode parsing case in `config.test.ts`:

```typescript
test("Production connection strings disable strict checks by default", async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = "production";
        const productionConfig = await import(`../../src/config.ts?production=${Date.now()}`);
        expect(productionConfig.parseConnectionString("udp://localhost").strictChecks).toBe(false);
    } finally {
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = savedNodeEnv;
        }
    }
});
```

Run:

```bash
bun test test/src/main.test.ts test/src/config.test.ts
```

Expected: all client helpers, client close, and both strict-check defaults pass.

- [ ] **Step 6: Cover TCP error forwarding and shutdown**

Export a `TestableTCPTransport` subclass from `test/src/tcp.test.ts` that
exposes the protected socket through `getSocket()`. Add a test that listens for
the transport `error` event, emits a synthetic socket error, and compares the
same error object:

```typescript
class TestableTCPTransport extends TCPTransport {
    public getSocket() {
        return this.socket;
    }
}
```

Use a loopback server so construction connects before the synthetic error. End
the transport and server in `finally`. Run:

```bash
bun test test/src/tcp.test.ts
```

Expected: the three frame tests and the error-forwarding case pass.

- [ ] **Step 7: Add UDP loopback, error, and close coverage**

Create `test/src/udp.test.ts` with a UDP server bound to
`127.0.0.1` and port `0`. Send a client message, receive one datagram, parse the
JSON payload, and assert host, level, message, timestamp, and version. Use a
five-second timeout and close the client plus server in `finally`.

Expose the protected socket through:

```typescript
class TestableUDPTransport extends UDPTransport {
    public getSocket() {
        return this.socket;
    }
}
```

Add a second test that emits a synthetic socket error and asserts that the
transport forwards the same object. Close the transport after the assertion.

Run:

```bash
bun test test/src/udp.test.ts
```

Expected: the UDP datagram test and socket-error test pass on loopback without
extra permissions.

- [ ] **Step 8: Close the remaining coverage gaps**

Run:

```bash
bun test
```

Expected: Bun prints 100.00 for aggregate lines and functions and exits zero
with the statements threshold satisfied. Do not add coverage-ignore comments or
exclude any `src/**` file.

- [ ] **Step 9: Commit the coverage suite**

```bash
git add bunfig.toml test/src/main.test.ts test/src/config.test.ts test/src/serializer.test.ts test/src/tcp.test.ts test/src/udp.test.ts
git commit -m "test: enforce full source coverage"
```

### Task 3: Add the Strict Bun Security Gate

**Files:**

- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: the installed dependency graph recorded in `bun.lock`.
- Produces: `bun run security`, plus named CI and publish audit steps.

- [ ] **Step 1: Run the audit command before adding the script**

Run:

```bash
bun audit
```

Expected: exit zero with `No vulnerabilities found`. If Bun reports an
advisory, inspect its package path and update the smallest compatible direct
dependency before continuing. Do not add an ignore or severity filter.

- [ ] **Step 2: Add the package security script**

Add this script without changing the audit arguments:

```json
"security": "bun audit"
```

Keep `security` separate from `check` so developers can run formatting, tests,
and builds offline. Both GitHub workflows will call it.

- [ ] **Step 3: Add explicit workflow steps**

In both `.github/workflows/ci.yml` and `.github/workflows/publish.yml`, place
this step after `bun ci` and before `bun run check`:

```yaml
- name: Audit dependencies
  run: bun run security
```

- [ ] **Step 4: Verify the script and workflow text**

Run:

```bash
bun run security
rg -n -U 'bun ci\n\s+- name: Audit dependencies\n\s+run: bun run security\n\s+- run: bun run check' .github/workflows/ci.yml .github/workflows/publish.yml
```

Expected: audit exits zero and the search prints one ordered block from each
workflow.

- [ ] **Step 5: Commit the security gate**

```bash
git add package.json .github/workflows/ci.yml .github/workflows/publish.yml
git commit -m "ci: audit dependencies with Bun"
```

### Task 4: Update Branch References and Run the Complete Gate

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-28-documentation-and-release-design.md`
- Modify: `docs/superpowers/specs/2026-07-30-npm-trusted-publishing-design.md`
- Modify: `docs/superpowers/plans/2026-07-28-documentation-and-release.md`
- Modify: `docs/superpowers/plans/2026-07-30-npm-trusted-publishing.md`

**Interfaces:**

- Consumes: existing repository links and release commands that name
  `master`.
- Produces: links and actionable workflow instructions that name `main`.

- [ ] **Step 1: Replace active branch references**

Change the three README example URLs from `/blob/master/` to `/blob/main/`.
Change release instructions, workflow dispatch refs, push commands, upstream
comparisons, and expected clean-branch text in the four completed workflow
documents from `master` to `main`.

Keep `master` in the August 1 migration design and this implementation plan
where the text describes the old branch name or the rename operation.

- [ ] **Step 2: Verify no active reference remains**

Run:

```bash
rg -n '\bmaster\b|origin/master|refs/heads/master' README.md docs/superpowers \
  -g '!specs/2026-08-01-dual-package-coverage-and-main-design.md' \
  -g '!plans/2026-08-02-dual-package-coverage-and-main.md'
```

Expected: no output.

- [ ] **Step 3: Run formatting and static checks**

Run:

```bash
bun run fmt
bun run fmt:check
bun run lint
bun run test:typecheck
bun run examples:typecheck
```

Expected: formatter leaves a repeatable tree and every static check passes.

- [ ] **Step 4: Run runtime, coverage, package, and build checks**

Run:

```bash
bun test
bun run build
bun run test:package
bun run check
bun run security
git diff --check
```

Expected: coverage reaches the enforced threshold, both packed runtime formats
pass under Node.js, the complete project gate passes, the audit finds no
advisory, and Git reports no whitespace errors.

- [ ] **Step 5: Commit documentation and formatting changes**

Review `git status --short` and stage only files that belong to this plan:

```bash
git add README.md \
  docs/superpowers/specs/2026-07-28-documentation-and-release-design.md \
  docs/superpowers/specs/2026-07-30-npm-trusted-publishing-design.md \
  docs/superpowers/plans/2026-07-28-documentation-and-release.md \
  docs/superpowers/plans/2026-07-30-npm-trusted-publishing.md
git diff --cached --check
git commit -m "docs: prepare repository for main branch"
```

Skip the commit if Task 4 has no uncommitted files after earlier focused
commits.

### Task 5: Rename the GitHub Default Branch and Local Branch

**Files:**

- Update remote repository state: `izatop/gelf-client` default branch
- Update local Git metadata: branch name, upstream, and `origin/HEAD`

**Interfaces:**

- Consumes: a clean tested `master` branch whose commits include Tasks 1 to 4.
- Produces: default branch `main`, local branch `main`, upstream `origin/main`,
  and remote HEAD `origin/main`.

- [ ] **Step 1: Inspect authentication and branch rules**

Run:

```bash
gh auth status
gh repo view izatop/gelf-client --json nameWithOwner,defaultBranchRef
gh api repos/izatop/gelf-client/rulesets
git status --short --branch
```

Expected: GitHub authentication has repository administration access, GitHub
reports `master` as default, and the worktree is clean. Record any ruleset that
names `master` before the rename.

- [ ] **Step 2: Push all tested commits to the current default branch**

Run:

```bash
git push origin master
```

Expected: `origin/master` advances to the tested local HEAD. Do not rename a
remote branch that lacks the implementation commits.

- [ ] **Step 3: Rename the branch through GitHub**

Run:

```bash
gh api --method POST repos/izatop/gelf-client/branches/master/rename -f new_name=main
```

Expected: the response contains `"name": "main"`. If GitHub returns a ruleset
or administration error, stop and report it without creating or deleting
branches by hand.

- [ ] **Step 4: Update the local clone**

Run:

```bash
git branch -m master main
git fetch origin
git branch --unset-upstream
git branch -u origin/main main
git remote set-head origin -a
git remote prune origin
```

Expected: local `main` tracks `origin/main`, and the stale `origin/master`
tracking ref disappears after pruning.

- [ ] **Step 5: Verify local and remote completion**

Run:

```bash
git status --short --branch
git branch -avv
git symbolic-ref refs/remotes/origin/HEAD
gh repo view izatop/gelf-client --json defaultBranchRef,url
git rev-parse main
git rev-parse origin/main
```

Expected:

```text
## main...origin/main
refs/remotes/origin/main
```

The two commit hashes must match, and GitHub must report `main` as its default
branch.

- [ ] **Step 6: Report the handoff**

Report the generated artifact paths, exact coverage totals, audit result, full
gate result, commits created, and GitHub default branch. Include this update
command for other existing clones:

```bash
git branch -m master main
git fetch origin
git branch -u origin/main main
git remote set-head origin -a
```
