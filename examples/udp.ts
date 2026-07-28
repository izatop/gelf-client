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
