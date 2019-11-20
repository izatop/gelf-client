# GELF Client

GELF Client for Node.js written in TypeScript.

## Install

`yarn add gelf-client`

## Usage

```typescript
import GELFClient, {Level} from "gelf-client";
const client = GELFClient.factory("udp://localhost:12201/?compress", {app: "app"})
    .clone({pid: process.pid});

client.push({
    level: Level.ERROR,
    message: "Short message",
    description: "Stack trace or something else",
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
