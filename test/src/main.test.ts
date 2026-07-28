import { expect, test } from "bun:test";
import { Client, Level } from "../../src";
import { Transport } from "../../src/config";
import { TestTransport } from "./TestTransport";

const dsn = "test://localhost:123";
const clientDefaults = { foo: 1 };

Transport.add("test", TestTransport);

test("Add transport", () => {
    expect(Transport.get("test")).toBe(TestTransport);
});

test("Client factory", async () => {
    const client = Client.factory(dsn, clientDefaults);
    expect(client.version).toBe("1.1");
    expect(client.transport).toBeInstanceOf(TestTransport);
    expect(client.defaults).toEqual(clientDefaults);
});

test("Strict checks", async () => {
    const client = Client.factory(dsn, clientDefaults);
    expect(() => client.send({ message: "test", "@wrong": 123 })).toThrow();
});

test("Client send", async () => {
    const client = Client.factory(dsn, clientDefaults);
    const startedAt = Math.floor(Date.now() / 1000);
    await client.send({ message: "test" });
    const finishedAt = Math.ceil(Date.now() / 1000);
    const transport = client.transport as TestTransport;
    const [written] = transport.written;
    expect(written).toBeInstanceOf(Buffer);
    expect(written.length).toBeGreaterThan(0);
    const { timestamp, ...payload } = JSON.parse(written.toString("utf-8"));

    expect(timestamp).toBeGreaterThanOrEqual(startedAt);
    expect(timestamp).toBeLessThanOrEqual(finishedAt);
    expect(payload).toEqual({
        level: Level.INFO,
        short_message: "test",
        version: "1.1",
        _foo: 1,
    });
});

test("Client applies and overrides cloned defaults", async () => {
    const client = Client.factory(dsn, {
        app: "checkout",
        environment: "test",
        request_id: "factory",
    });
    const requestClient = client.clone({
        pid: 123,
        request_id: "clone",
    });

    await requestClient.send({
        message: "defaults",
        request_id: "send",
    });

    const transport = requestClient.transport as TestTransport;
    const [written] = transport.written;
    const { timestamp: _timestamp, ...payload } = JSON.parse(written.toString("utf-8"));
    expect(payload).toEqual({
        host: "checkout",
        level: Level.INFO,
        short_message: "defaults",
        version: "1.1",
        _environment: "test",
        _pid: 123,
        _request_id: "send",
    });
});

test("Client info returns the send promise", async () => {
    const client = Client.factory(dsn);
    const result = client.info({ message: "info" });

    expect(result).toBeInstanceOf(Promise);
    await result;
});

test("Test chunks", async () => {
    const client = Client.factory(dsn);
    await client.send({ message: "chunk test", description: "foo".repeat(1100) });
    const transport = client.transport as TestTransport;
    const written = transport.written!;
    const expectChunksCount = 3;
    const expectMessageSize = 3397;
    expect(written.length).toBe(expectChunksCount);

    const chunks = Array.from({ length: written.length }, () => Buffer.alloc(0));
    for (let index = 0; index < chunks.length; index++) {
        const chunk = written[index];
        const sequence = chunk.readInt8(10);
        const chunksCount = chunk.readInt8(11);
        chunks[sequence] = chunk.slice(12, chunk.length);
        expect(sequence).toBe(index);
        expect(chunksCount).toBe(expectChunksCount);
    }

    const message = Buffer.concat(chunks).toString("utf-8");

    const { timestamp, ...payload } = JSON.parse(message);
    expect(message.length).toBe(expectMessageSize);
    expect(timestamp <= Date.now()).toBeTruthy();
    expect(payload).toMatchSnapshot();
});
