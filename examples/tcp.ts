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
