# Documentation, Examples, and 0.1.12 Release Design

## Goal

Make the public documentation accurate enough to use without reading the
source, add checked examples for the main transports and contextual fields,
fix the small API defects exposed by those examples, and publish version
0.1.12 through the existing GitHub Actions workflow.

## Scope

This patch covers:

- a full README edit in English;
- installation commands for npm, Bun, and Yarn;
- three TypeScript examples under `examples/`;
- regression fixes for message defaults and `Client.info()`;
- GELF-compliant emergency severity, host fallback, TCP framing, and error
  delivery;
- stronger tests for timestamps and default-field behavior;
- a patch release through the existing tag-driven publish workflow.

The patch will not change UDP framing, compression, chunking, DSN syntax, or
the public method signatures.

## README Structure

The README will use this order:

1. package summary and supported TCP and UDP transports;
2. installation commands:

    ```bash
    npm install gelf-client
    bun add gelf-client
    yarn add gelf-client
    ```

3. a UDP quick start with imports, error handling, shutdown, and a complete
   `randomUUID()` import;
4. the GELF JSON produced by that example, with values that match the input;
5. TCP usage;
6. application defaults and request-specific context through `factory()` and
   `clone()`;
7. custom-field mapping from JavaScript keys to GELF `_` fields;
8. client and log-level API tables;
9. connection-string syntax and option defaults;
10. transport error handling and `close()`;
11. development commands for install, test, lint, format, build, and the full
    check.

The prose will use consistent `GELF`, `JSON`, `TCP`, and `UDP` spelling. Code
blocks will compile as TypeScript and will not rely on undeclared helpers.

## Examples

The repository will contain:

- `examples/udp.ts`: send one structured UDP message with `randomUUID()`;
- `examples/tcp.ts`: create a TCP client, subscribe to transport errors, send a
  message, and close the client;
- `examples/context.ts`: define application defaults with `factory()`, derive
  request context with `clone()`, and override a default on one send.

Each example will import the public package name, `gelf-client`. A dedicated
examples tsconfig will map that name to `src/index.ts` during repository checks.
The examples will compile without opening sockets.

`package.json` will expose `examples:typecheck`, and `check` will run it. This
keeps README-linked examples aligned with the public TypeScript API.

## Client Fixes

### Defaults and Clone

`Client.factory(dsn, defaults)` stores defaults, and `clone(defaults)` merges
new defaults with the existing set. Before this patch, `send(data)` ignored
both sets.

`send()` will merge `this.defaults` first and call-specific `data` second.
Call-specific values win. The method will use the merged object for standard
GELF fields, custom fields, and strict custom-field validation.

The fix preserves the public method signatures and the existing wire names.

### Info Return Value

The severity helpers return the result of `send()` except for `info()`.
`info()` will return `this.send(...)` so callers can await it in the same way as
`error()`, `warning()`, and the other helpers.

### Required Host and Emergency Severity

GELF 1.1 requires `host`. `send()` will use the message or default `app` value
when present and fall back to `node:os` `hostname()` when the caller omits it.
This preserves the optional `app` TypeScript field while producing a valid
payload.

`Level.EMERGENCY` has numeric value `0`. `send()` will use nullish fallback for
the default info level so it preserves severity zero.

Connection strings will accept every valid TCP and UDP port from `1` through
`65535`. Invalid and omitted ports will retain the `12201` fallback.

### TCP Framing

GELF TCP accepts one uncompressed, non-chunked JSON payload followed by a null
byte. `TCPTransport` will bypass the UDP serializer and write
`JSON bytes + 0x00` for each message. Multiple calls will produce separate
null-delimited frames on the same socket, including payloads larger than the
UDP chunk threshold.

### Transport Error Contract

`TransportAbstract.send()` will keep JSON encoding inside its async error
boundary. Circular objects, `BigInt`, and other encoding failures will emit the
transport's `error` event and resolve the returned promise without writing a
partial payload. This matches the existing serializer and socket error
delivery model.

## Tests

The Bun suite will prove:

- factory defaults reach the serialized envelope;
- clone defaults extend factory defaults;
- call-specific fields override defaults;
- custom default fields receive the GELF `_` prefix;
- `info()` returns the transport send promise;
- explicit and helper-based emergency messages preserve level `0`;
- messages without `app` use the system hostname;
- explicit ports through `65535` survive DSN parsing;
- TCP emits one null-delimited frame per small or large message;
- JSON encoding failures emit `transport.error` and return a promise;
- timestamps use seconds and stay within the test's start and end bounds.

The current strict-field, UDP serialization, and chunk tests remain. Client
tests will inspect the in-memory test transport. TCP tests will use a local
server on an operating-system-assigned port and will not contact an external
service.

## DSN Documentation

The README will document the implemented defaults:

| Item              | Default |
| ----------------- | ------- |
| Port              | `12201` |
| `maxChunkSize`    | `1400`  |
| `minCompressSize` | `1400`  |

The `compress` flag enables zlib compression for chunked messages. The `strict`
flag enables custom-field name validation. Development and test processes also
enable strict validation when `NODE_ENV` is not `production`.

## Release Process

The release will use version `0.1.12`.

Before release, the repository must pass:

```bash
bun ci
bun run check
bun pm pack --dry-run
```

The release steps are:

1. update `package.json` and `bun.lock` to `0.1.12`;
2. commit the documentation, examples, fixes, tests, and version;
3. push `master`;
4. create and push tag `v0.1.12`;
5. wait for the Publish workflow;
6. confirm that npm reports `gelf-client@0.1.12`.

The GitHub Actions workflow performs the npm publication. The local session
will not run a second `bun publish`.

## Acceptance Criteria

- README installation covers npm, Bun, and Yarn.
- README code uses declared imports and matches its shown GELF JSON.
- README documents the public client methods, levels, DSN flags, error
  handling, and development commands.
- Three examples compile through `bun run examples:typecheck`.
- Defaults, clone overrides, `info()`, severity zero, host fallback, and TCP
  framing pass focused Bun tests.
- `bun run check` includes example type-checking and exits with code zero.
- `bun pm pack --dry-run` includes the built declarations and updated README.
- GitHub CI and Publish workflows succeed for `v0.1.12`.
- `bun pm view gelf-client version` reports `0.1.12`.

## Out of Scope

- changes to UDP framing or chunk thresholds;
- compressed GELF TCP, which the protocol does not support;
- a new transport or logging integration;
- a public API redesign;
- a minor or major version release.
