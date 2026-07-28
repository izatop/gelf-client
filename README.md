# GELF Client

[![npm version](https://img.shields.io/npm/v/gelf-client.svg)](https://www.npmjs.com/package/gelf-client)
[![CI](https://github.com/izatop/gelf-client/actions/workflows/ci.yml/badge.svg)](https://github.com/izatop/gelf-client/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/gelf-client.svg)](LICENSE)

A typed GELF 1.1 client for Node.js with TCP and UDP transports.

## Install

Choose your package manager:

```bash
# npm
npm install gelf-client

# Bun
bun add gelf-client

# Yarn
yarn add gelf-client
```

## Quick start

This example sends one structured message over UDP:

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

Graylog receives a GELF object with this shape:

```json
{
    "version": "1.1",
    "host": "checkout-api",
    "short_message": "Order accepted",
    "timestamp": 1785196800,
    "level": 6,
    "_request_id": "a36f0d30-0b90-11ea-8d71-362b9e155667",
    "_user_id": 42
}
```

See the complete
[UDP example](https://github.com/izatop/gelf-client/blob/master/examples/udp.ts).

## Transports

Use a connection string to select UDP or TCP:

```typescript
import GELFClient from "gelf-client";

const udpClient = GELFClient.factory("udp://localhost:12201");
const tcpClient = GELFClient.factory("tcp://localhost:12201");
```

UDP supports GELF chunking and optional zlib compression. TCP writes each
uncompressed, non-chunked JSON payload to a persistent socket and terminates it
with a null byte. See the complete
[TCP example](https://github.com/izatop/gelf-client/blob/master/examples/tcp.ts).
Graylog documents the wire rules in its
[GELF format specification](https://go2docs.graylog.org/current/getting_in_log_data/gelf_format.html).

## Defaults and request context

Pass stable application fields to `factory()`. Use `clone()` to add
request-specific context without creating another socket:

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

await requestClient.info({
    message: "Payment captured",
    user_id: 43,
});
```

Fields passed to a log call override cloned and factory defaults. The message
above uses `user_id: 43`. Clones share the original transport, so close the
factory client when the application shuts down.

See the complete
[context example](https://github.com/izatop/gelf-client/blob/master/examples/context.ts).

## Message fields

The client maps standard fields to their GELF names:

| Client field  | GELF field      | Required |
| ------------- | --------------- | -------- |
| `message`     | `short_message` | yes      |
| `app`         | `host`          | no       |
| `description` | `full_message`  | no       |
| `level`       | `level`         | no       |
| `file`        | `file`          | no       |
| `line`        | `line`          | no       |

Any other property becomes a GELF custom field with an `_` prefix.
`request_id` becomes `_request_id`; you do not need to add the prefix yourself.
When you omit `app`, the client uses the operating system hostname for the
required GELF `host` field.

## Client API

| Member                        | Description                                              |
| ----------------------------- | -------------------------------------------------------- |
| `Client.factory(dsn, fields)` | Create a client and optional default fields.             |
| `client.clone(fields)`        | Reuse the transport with merged defaults.                |
| `client.send(message)`        | Send a message with an optional explicit `level`.        |
| `client.emergency(message)`   | Send at `Level.EMERGENCY`.                               |
| `client.alert(message)`       | Send at `Level.ALERT`.                                   |
| `client.critical(message)`    | Send at `Level.CRITICAL`.                                |
| `client.error(message)`       | Send at `Level.ERROR`.                                   |
| `client.warning(message)`     | Send at `Level.WARNING`.                                 |
| `client.notice(message)`      | Send at `Level.NOTICE`.                                  |
| `client.info(message)`        | Send at `Level.INFO`.                                    |
| `client.debug(message)`       | Send at `Level.DEBUG`.                                   |
| `client.close()`              | Close the shared TCP or UDP transport.                   |
| `client.transport`            | Access the transport and subscribe to its `error` event. |
| `client.options`              | Read the parsed connection options.                      |
| `client.defaults`             | Read the fields applied before message-specific fields.  |

`send()` and the level helpers return a promise. Await the promise before
closing the client.

## Levels

The values follow the syslog severity scale used by GELF:

| Level             | Value |
| ----------------- | ----: |
| `Level.EMERGENCY` |     0 |
| `Level.ALERT`     |     1 |
| `Level.CRITICAL`  |     2 |
| `Level.ERROR`     |     3 |
| `Level.WARNING`   |     4 |
| `Level.NOTICE`    |     5 |
| `Level.INFO`      |     6 |
| `Level.DEBUG`     |     7 |

`send()` uses `Level.INFO` when you omit `level`.

## Connection string

Use this DSN form:

```text
protocol://host[:port]/?flag&option=value
```

For example:

```text
udp://graylog.internal:12201/?compress&strict&maxChunkSize=1400
```

| Item              | Default | Description                                             |
| ----------------- | ------: | ------------------------------------------------------- |
| protocol          |       - | `udp` or `tcp`.                                         |
| port              | `12201` | Graylog GELF input port in the range `1..65535`.        |
| `compress`        |     off | Compress chunked UDP payloads with zlib.                |
| `maxChunkSize`    |  `1400` | Maximum UDP chunk size in bytes.                        |
| `minCompressSize` |  `1400` | Compression threshold used by the serializer.           |
| `strict`          |     env | Reject custom field names outside letters, digits, `_`. |

Strict custom-field validation runs when the DSN contains `strict` or
`NODE_ENV !== "production"`.

## Errors and shutdown

TCP connection errors, UDP socket errors, and serialization errors use the
transport's `error` event. Register a listener before sending:

```typescript
import GELFClient from "gelf-client";

const client = GELFClient.factory("udp://localhost:12201");
client.transport.on("error", (error) => {
    console.error("GELF transport error", error);
});
```

Call `client.close()` during application shutdown. A cloned client shares its
factory client's transport, so close that transport once.

## Development

Install the locked dependencies:

```bash
bun ci
```

Run individual checks:

```bash
bun test
bun run test:watch
bun run lint
bun run fmt
bun run build
```

Run the same gate as CI:

```bash
bun run check
```

The full check covers formatting, linting, source and example type-checking,
Bun tests, package build, and a packed-package consumer test.

## License

[MIT](LICENSE)
