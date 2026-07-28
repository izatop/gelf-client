import { expect, test } from "bun:test";
import { AddressInfo, createServer } from "node:net";
import { Client, Level } from "../../src";

const countNullDelimiters = (data: Buffer) =>
    data.reduce((count, byte) => count + Number(byte === 0), 0);

const receiveTCPFrames = async (
    expectedFrames: number,
    send: (client: Client) => Promise<void>,
) => {
    const chunks: Buffer[] = [];
    let resolveFrames!: (data: Buffer) => void;
    let rejectFrames!: (error: Error) => void;
    const framesReceived = new Promise<Buffer>((resolve, reject) => {
        resolveFrames = resolve;
        rejectFrames = reject;
    });

    const server = createServer((socket) => {
        socket.on("data", (chunk) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            const data = Buffer.concat(chunks);
            if (countNullDelimiters(data) >= expectedFrames) {
                resolveFrames(data);
            }
        });
        socket.on("error", rejectFrames);
    });

    await new Promise<void>((resolve, reject) => {
        const rejectListen = (error: Error) => reject(error);
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", rejectListen);
            resolve();
        });
    });

    const address = server.address() as AddressInfo;
    const client = Client.factory(`tcp://127.0.0.1:${address.port}`, {
        app: "tcp-test",
    });
    client.transport.on("error", rejectFrames);
    const timeout = setTimeout(() => {
        rejectFrames(new Error(`Timed out waiting for ${expectedFrames} TCP frames`));
    }, 5000);

    try {
        await send(client);
        return await framesReceived;
    } finally {
        clearTimeout(timeout);
        client.close();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
};

const parseTCPFrames = (data: Buffer) =>
    data
        .toString("utf-8")
        .split("\0")
        .filter(Boolean)
        .map((frame) => JSON.parse(frame));

test("TCP terminates one GELF message with a null byte", async () => {
    const data = await receiveTCPFrames(1, (client) =>
        client.info({ message: "single TCP frame" }),
    );

    expect(data[data.length - 1]).toBe(0);
    expect(parseTCPFrames(data)).toEqual([
        {
            host: "tcp-test",
            level: Level.INFO,
            short_message: "single TCP frame",
            timestamp: expect.any(Number),
            version: "1.1",
        },
    ]);
});

test("TCP separates multiple GELF messages with null bytes", async () => {
    const data = await receiveTCPFrames(2, async (client) => {
        await client.info({ message: "first TCP frame" });
        await client.error({ message: "second TCP frame" });
    });

    expect(countNullDelimiters(data)).toBe(2);
    expect(
        parseTCPFrames(data).map(({ level, short_message }) => ({ level, short_message })),
    ).toEqual([
        { level: Level.INFO, short_message: "first TCP frame" },
        { level: Level.ERROR, short_message: "second TCP frame" },
    ]);
});

test("TCP sends a large GELF message as one unchunked frame", async () => {
    const description = "stack frame\n".repeat(500);
    const data = await receiveTCPFrames(1, (client) =>
        client.error({
            description,
            message: "large TCP frame",
        }),
    );

    expect(countNullDelimiters(data)).toBe(1);
    expect(data.subarray(0, 2)).not.toEqual(Buffer.from([0x1e, 0x0f]));
    expect(parseTCPFrames(data)).toEqual([
        {
            full_message: description,
            host: "tcp-test",
            level: Level.ERROR,
            short_message: "large TCP frame",
            timestamp: expect.any(Number),
            version: "1.1",
        },
    ]);
});
