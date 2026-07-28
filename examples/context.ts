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
