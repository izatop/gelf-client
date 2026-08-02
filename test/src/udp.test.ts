import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { AddressInfo } from "node:net";
import { Client, Level } from "../../src";
import { UDPTransport } from "../../src/Transport/UDPTransport";

class TestableUDPTransport extends UDPTransport {
    public getSocket() {
        return this.socket;
    }
}

test("UDP sends one GELF message as a datagram", async () => {
    const server = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.bind(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const received = new Promise<Buffer>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for UDP data")), 5000);
        server.once("message", (message) => {
            clearTimeout(timeout);
            resolve(message);
        });
        server.once("error", reject);
    });
    const client = Client.factory(`udp://127.0.0.1:${address.port}`, {
        app: "udp-test",
    });

    try {
        await client.info({ message: "UDP datagram" });
        expect(JSON.parse((await received).toString("utf-8"))).toEqual({
            host: "udp-test",
            level: Level.INFO,
            short_message: "UDP datagram",
            timestamp: expect.any(Number),
            version: "1.1",
        });
    } finally {
        client.close();
        await new Promise<void>((resolve) => server.close(resolve));
    }
});

test("UDP forwards socket errors through the transport", async () => {
    const transport = new TestableUDPTransport({
        compress: false,
        host: "127.0.0.1",
        maxChunkSize: 1400,
        minCompressSize: 1400,
        port: 12201,
        protocol: "udp",
        strictChecks: true,
    });
    const socketError = new Error("synthetic UDP socket error");
    const forwardedError = new Promise<unknown>((resolve) => transport.once("error", resolve));

    try {
        transport.getSocket().emit("error", socketError);
        expect(await forwardedError).toBe(socketError);
    } finally {
        transport.close();
    }
});
