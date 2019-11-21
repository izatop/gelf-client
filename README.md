# GELF Client

GELF Client for Node.js written in TypeScript.
This client supports TCP and UDP transports.

## Install

`yarn add gelf-client`

## Usage

Simple usage with UDP transport:

```typescript
import GELFClient, {Level} from "gelf-client";
const client = GELFClient.factory("udp://localhost:12201/?compress", {app: "app"})
    .clone({pid: process.pid});

client.send({
    level: Level.ERROR,
    message: "Short message",
    description: "Stack trace or something else",
    // custom fields
    request_id: uuid(),
    user_id: 1,
});
```

This code will send these json:

```json
{
    "version": "1.1",
    "host": "app",
    "short_message": "Short message",
    "full_message": "Stack trace or something else",
    "timestamp": 12345678,
    "level": 3,
    "_user_id": 42,
    "_request_id": "a36f0d30-0b90-11ea-8d71-362b9e155667",
    "_pid": 123,
}
``` 


### Connection string

Connection string (DSN) format `proto://hostOrIp[:port]/[?[flag[&option=value[&option2=value2]]]}`

Options:

 * `compress` - use `zlib` compression as flag
 * `maxChunkSize` - maximum size of a message chunk, default 1440
 * `minCompressSize` - minimal size of a message to compress, default 1440
