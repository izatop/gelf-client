# Documentation, Examples, and 0.1.12 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the client defaults contract, add checked TypeScript examples,
rewrite the public README, and publish `gelf-client@0.1.12`.

**Architecture:** Keep the CommonJS package and transport behavior intact.
Exercise public client behavior through the in-memory test transport, compile
copyable examples against `src/index.ts`, and let the tag-driven GitHub workflow
publish the verified package.

**Tech Stack:** Bun 1.3.14, `bun:test`, TypeScript 7.0.2, oxlint, oxfmt, GitHub
Actions, npm.

## Global Constraints

- Work directly on `main`.
- Keep the public GELF wire names and method signatures unchanged.
- Keep UDP framing, compression, chunking, and DSN syntax unchanged.
- Make TCP messages uncompressed, non-chunked, and null-delimited.
- Guarantee GELF `host` with an `app` value or system-hostname fallback.
- Write public documentation and examples in English.
- Show npm, Bun, and Yarn installation commands.
- Release exact version `0.1.12` through tag `v0.1.12`.
- Run publication through GitHub Actions. Do not run a second local publish.

---

### Task 1: Restore client defaults and consistent severity returns

**Files:**

- Modify: `test/src/main.test.ts`
- Modify: `src/Client.ts`

**Interfaces:**

- Consumes: `Client.factory(dsn, defaults)`, `Client.clone(defaults)`,
  `Client.send(data)`, and the in-memory `TestTransport`.
- Produces: merged defaults where call-specific data wins, plus a promise from
  `Client.info()`.

- [x] **Step 1: Add failing defaults, clone, info, and timestamp assertions**

Add a test that creates:

```typescript
const client = Client.factory(dsn, {
    app: "checkout",
    environment: "test",
    request_id: "factory",
});
const requestClient = client.clone({
    pid: 123,
    request_id: "clone",
});
```

Send:

```typescript
await requestClient.send({
    message: "defaults",
    request_id: "send",
});
```

Assert the serialized envelope, excluding its timestamp, equals:

```typescript
{
    host: "checkout",
    level: Level.INFO,
    short_message: "defaults",
    version: "1.1",
    _environment: "test",
    _pid: 123,
    _request_id: "send",
}
```

In the client-send test, capture whole-second bounds around `send()`:

```typescript
const startedAt = Math.floor(Date.now() / 1000);
await client.send({ message: "test" });
const finishedAt = Math.ceil(Date.now() / 1000);
expect(timestamp).toBeGreaterThanOrEqual(startedAt);
expect(timestamp).toBeLessThanOrEqual(finishedAt);
```

Add an info test:

```typescript
const result = client.info({ message: "info" });
expect(result).toBeInstanceOf(Promise);
await result;
```

- [x] **Step 2: Run the focused RED tests**

Run:

```bash
bun test test/src/main.test.ts
```

Expected: the defaults envelope lacks `host` and custom defaults, and the info
test receives `undefined` instead of a promise.

- [x] **Step 3: Merge defaults in send and return from info**

In `Client.send()`, destructure from a merged value:

```typescript
const { level, message, description, file, line, app, ...rest } = {
    ...this.defaults,
    ...data,
};
```

In `Client.info()`, return the send promise:

```typescript
public info(data: Exclude<IMessage, "level"> & IMessageRest) {
    return this.send({ ...data, level: Level.INFO });
}
```

- [x] **Step 4: Run the GREEN client checks**

Run:

```bash
bun test test/src/main.test.ts
bun run test:typecheck
```

Expected: all client tests and TypeScript checks pass.

- [x] **Step 5: Commit the client fix**

```bash
git add src/Client.ts test/src/main.test.ts
git commit -m "fix: apply client message defaults"
```

### Task 2: Enforce GELF payload, TCP framing, and error contracts

**Files:**

- Modify: `src/Client.ts`
- Modify: `src/TransportAbstract.ts`
- Modify: `src/Transport/TCPTransport.ts`
- Modify: `src/config.ts`
- Modify: `test/src/main.test.ts`
- Create: `test/src/tcp.test.ts`

**Interfaces:**

- Consumes: `Level.EMERGENCY`, `Client.send()`, `TCPTransport`, and Node's
  system hostname.
- Produces: required `host`, preserved level zero, ports in `1..65535`, one
  null-delimited JSON frame per TCP send, and async JSON encoding errors.

- [x] **Step 1: Add RED tests for emergency level, host fallback, and ports**

Add a client test that sends both:

```typescript
await client.send({ level: Level.EMERGENCY, message: "explicit emergency" });
await client.emergency({ message: "helper emergency" });
```

Assert that both serialized envelopes contain `level: 0`.

Create a client without `app`, send a message, and assert:

```typescript
expect(payload.host).toBe(hostname());
```

Assert that `tcp://localhost:65535` preserves port `65535`.

Run:

```bash
bun test test/src/main.test.ts
```

Expected: emergency messages contain level `6`, messages without `app` omit
`host`, and port `65535` falls back to `12201`.

- [x] **Step 2: Preserve zero, add the host fallback, and accept valid ports**

Import `hostname` from `node:os`. Build the envelope with:

```typescript
host: app || hostname(),
level: level ?? Level.INFO,
```

Parse explicit ports in the range `1..65535`.

Run:

```bash
bun test test/src/main.test.ts
bun run test:typecheck
```

Expected: all client tests pass.

- [x] **Step 3: Add RED integration tests for TCP framing**

Use `node:net` to start a local TCP server on `127.0.0.1` with port `0`.
Collect bytes until the expected number of `0x00` delimiters arrives.

Add three tests:

1. one message parses after removing its final null byte;
2. two sends produce two independently parseable null-delimited frames;
3. a description larger than `maxChunkSize` still produces one JSON frame with
   one null delimiter and no UDP magic bytes.

Run:

```bash
bun test test/src/tcp.test.ts
```

Expected: current TCP writes have no null delimiters; the large payload may use
UDP chunk headers.

- [x] **Step 4: Bypass UDP serialization for TCP**

Override `enqueue()` in `TCPTransport`:

```typescript
protected enqueue(data: Buffer): Promise<void> {
    this.write(Buffer.concat([data, Buffer.from([0])]));
    return Promise.resolve();
}
```

Run:

```bash
bun test test/src/tcp.test.ts
bun test
bun run test:typecheck
```

Expected: the TCP tests and complete Bun suite pass.

- [x] **Step 5: Keep JSON encoding inside the async error boundary**

Add a RED test that sends a `BigInt` custom field. Assert that `send()` returns
a promise, emits a `TypeError` through `transport.error`, and writes no bytes.

Make `TransportAbstract.send()` async:

```typescript
public async send(data: object) {
    try {
        await this.enqueue(Buffer.from(JSON.stringify(data), "utf-8"));
    } catch (error) {
        this.emit("error", error);
    }
}
```

Run:

```bash
bun test test/src/main.test.ts --test-name-pattern "JSON encoding"
bun run test:typecheck
bun test
```

Expected: the error-contract regression and complete suite pass.

- [x] **Step 6: Commit GELF compliance fixes**

```bash
git add src/Client.ts src/TransportAbstract.ts src/Transport/TCPTransport.ts src/config.ts test/src/main.test.ts test/src/tcp.test.ts test/src/__snapshots__/main.test.ts.snap
git commit -m "fix: conform payloads to GELF 1.1"
```

### Task 3: Add checked public examples

**Files:**

- Create: `examples/udp.ts`
- Create: `examples/tcp.ts`
- Create: `examples/context.ts`
- Create: `examples/tsconfig.json`
- Modify: `package.json`

**Interfaces:**

- Consumes: the default and named exports from `src/index.ts`.
- Produces: `bun run examples:typecheck` and three copyable examples that use
  `import ... from "gelf-client"`.

- [x] **Step 1: Add the example TypeScript project**

Create `examples/tsconfig.json`:

```json
{
    "compilerOptions": {
        "module": "preserve",
        "moduleResolution": "bundler",
        "noEmit": true,
        "paths": {
            "gelf-client": ["../src/index.ts"]
        },
        "strict": true,
        "target": "esnext",
        "types": ["node"]
    },
    "include": ["*.ts"]
}
```

- [x] **Step 2: Add UDP, TCP, and context examples**

Create `examples/udp.ts`:

```typescript
import { randomUUID } from "node:crypto";
import GELFClient, { Level } from "gelf-client";

const client = GELFClient.factory("udp://localhost:12201/?compress");
client.transport.on("error", (error) => {
    console.error("GELF transport error", error);
});

try {
    await client.send({
        app: "checkout-api",
        level: Level.INFO,
        message: "Order accepted",
        request_id: randomUUID(),
        user_id: 42,
    });
} finally {
    client.close();
}
```

Create `examples/tcp.ts`:

```typescript
import GELFClient from "gelf-client";

const client = GELFClient.factory("tcp://localhost:12201");
client.transport.on("error", (error) => {
    console.error("GELF transport error", error);
});

try {
    await client.warning({
        message: "Queue delay",
        queue: "emails",
        delay_ms: 250,
    });
} finally {
    client.close();
}
```

Create `examples/context.ts`:

```typescript
import GELFClient from "gelf-client";

const client = GELFClient.factory("udp://localhost:12201", {
    app: "checkout",
    environment: "production",
});
const requestClient = client.clone({
    request_id: "req-123",
    user_id: 42,
});

try {
    await requestClient.info({
        message: "Payment captured",
        user_id: 43,
    });
} finally {
    client.close();
}
```

- [x] **Step 3: Add the example type-check script**

Add:

```json
"examples:typecheck": "tsc -p examples/tsconfig.json"
```

Run it from `check` after `test:typecheck`:

```json
"check": "bun run fmt:check && bun run lint && bun run test:typecheck && bun run examples:typecheck && bun run test && bun run build && bun run test:package"
```

- [x] **Step 4: Format and type-check the examples**

Run:

```bash
bun run fmt
bun run examples:typecheck
bun run lint
```

Expected: all three examples compile and lint without diagnostics.

- [x] **Step 5: Commit the examples**

```bash
git add examples package.json
git commit -m "docs: add checked GELF client examples"
```

### Task 4: Rewrite and proofread the README

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: the checked examples and implemented DSN defaults.
- Produces: npm-rendered documentation with copyable commands and public API
  guidance.

- [x] **Step 1: Replace installation and quick-start content**

Show these alternatives:

```bash
npm install gelf-client
bun add gelf-client
yarn add gelf-client
```

Use the UDP example with:

```typescript
import { randomUUID } from "node:crypto";
import GELFClient, { Level } from "gelf-client";
```

The shown GELF JSON must match the example: `host` is `checkout-api`,
`_user_id` is `42`, `_request_id` is the generated UUID, and `level` is `6`
for `Level.INFO`.

- [x] **Step 2: Document transports, context, API, and DSN options**

Add:

- TCP usage linked to `examples/tcp.ts`;
- defaults and clone usage linked to `examples/context.ts`;
- custom-field prefix behavior;
- a client method table for `factory`, `clone`, `send`, severity helpers, and
  `close`;
- a level table from `EMERGENCY = 0` through `DEBUG = 7`;
- DSN syntax `protocol://host[:port]/?flag&option=value`;
- defaults `port=12201`, `maxChunkSize=1400`, and `minCompressSize=1400`;
- `compress` and `strict` flag descriptions;
- transport error-listener and shutdown guidance.

- [x] **Step 3: Document repository commands**

List:

```bash
bun ci
bun test
bun run test:watch
bun run lint
bun run fmt
bun run build
bun run check
```

State that `bun run check` runs formatting, lint, source and example
type-checking, tests, build, and packed-consumer validation.

- [x] **Step 4: Proofread and validate README claims**

Run:

```bash
bun run fmt
bun run fmt:check
rg -n "uuid\\(\\)|1440|send these json|See type definitions" README.md
```

Expected: formatting passes and the search returns no stale documentation.

- [x] **Step 5: Commit the README**

```bash
git add README.md
git commit -m "docs: rewrite usage and API guide"
```

### Task 5: Prepare and publish version 0.1.12

**Files:**

- Modify: `package.json`
- Inspect: `bun.lock`
- Modify:
  `docs/superpowers/plans/2026-07-28-documentation-and-release.md`

**Interfaces:**

- Consumes: the green local repository and tag-triggered Publish workflow.
- Produces: Git tag `v0.1.12` and npm package `gelf-client@0.1.12`.

- [x] **Step 1: Update package version and inspect the lockfile**

Change the root package version from `0.1.11` to `0.1.12`, then run:

```bash
bun install
bun ci
```

Expected: `package.json` reports `0.1.12`. Bun may leave `bun.lock` unchanged
because its workspace entry does not store the package version. The frozen
install must pass.

- [x] **Step 2: Run the release verification matrix**

Run:

```bash
bun run check
bun pm pack --dry-run
bun -e 'for (const file of [".github/workflows/ci.yml", ".github/workflows/publish.yml"]) Bun.YAML.parse(await Bun.file(file).text())'
git diff --check
git status --short --branch
```

Expected: all 14 Bun tests pass, examples type-check, the tarball contains
`dist`, `README.md`, and `LICENSE`, both workflows parse, and only intended
release files remain.

- [x] **Step 3: Commit the local release state**

Commit the version and completed local checklist:

```bash
git add package.json docs/superpowers/plans/2026-07-28-documentation-and-release.md
git commit -m "release: prepare version 0.1.12"
```

- [ ] **Step 4: Push main and verify CI**

Run:

```bash
git push origin main
```

Wait for the CI workflow on the pushed commit and require conclusion
`success`.

- [ ] **Step 5: Create and push the release tag**

Run:

```bash
git tag -a v0.1.12 -m "v0.1.12"
git push origin v0.1.12
```

Wait for the Publish workflow and require conclusion `success`.

- [ ] **Step 6: Verify npm and record publication**

Run:

```bash
bun pm view gelf-client version
```

Expected: npm reports `0.1.12`. Mark Steps 3 through 6 complete, then run:

```bash
git add docs/superpowers/plans/2026-07-28-documentation-and-release.md
git commit -m "docs: record version 0.1.12 publication"
git push origin main
git status --short --branch
```

The final status must show a clean `main` matching `origin/main`.
