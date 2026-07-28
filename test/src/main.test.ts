import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { Client, Level } from "../../src";
import { parseConnectionString, Transport } from "../../src/config";
import { TestTransport } from "./TestTransport";

const dsn = "test://localhost:123";
const clientDefaults = { app: "test", foo: 1 };

Transport.add("test", TestTransport);

test("Add transport", () => {
    expect(Transport.get("test")).toBe(TestTransport);
});

test("Connection string accepts the full port range", () => {
    expect(parseConnectionString("tcp://localhost:65535").port).toBe(65535);
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
        host: "test",
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

    await requestClient.send({ message: "clone defaults" });
    await requestClient.send({
        message: "send override",
        request_id: "send",
    });

    const transport = requestClient.transport as TestTransport;
    const [cloneWritten, overrideWritten] = transport.written;
    const { timestamp: _cloneTimestamp, ...clonePayload } = JSON.parse(
        cloneWritten.toString("utf-8"),
    );
    const { timestamp: _overrideTimestamp, ...overridePayload } = JSON.parse(
        overrideWritten.toString("utf-8"),
    );
    expect(clonePayload).toEqual({
        host: "checkout",
        level: Level.INFO,
        short_message: "clone defaults",
        version: "1.1",
        _environment: "test",
        _pid: 123,
        _request_id: "clone",
    });
    expect(overridePayload).toEqual({
        host: "checkout",
        level: Level.INFO,
        short_message: "send override",
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

test("Client emits JSON encoding errors through the transport", async () => {
    const client = Client.factory(dsn);
    let emittedError: unknown;
    client.transport.once("error", (error) => {
        emittedError = error;
    });

    const result = client.info({
        message: "encoding error",
        value: 1n,
    });

    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(emittedError).toBeInstanceOf(TypeError);
    expect((client.transport as TestTransport).written).toHaveLength(0);
});

test("Client preserves emergency severity", async () => {
    const client = Client.factory(dsn, { app: "test" });

    await client.send({
        level: Level.EMERGENCY,
        message: "explicit emergency",
    });
    await client.emergency({ message: "helper emergency" });

    const transport = client.transport as TestTransport;
    const levels = transport.written.map((written) => JSON.parse(written.toString("utf-8")).level);
    expect(levels).toEqual([Level.EMERGENCY, Level.EMERGENCY]);
});

test("Client uses the system hostname by default", async () => {
    const client = Client.factory(dsn);
    await client.info({ message: "host fallback" });

    const transport = client.transport as TestTransport;
    const [written] = transport.written;
    const payload = JSON.parse(written.toString("utf-8"));
    expect(payload.host).toBe(hostname());
});

test("Test chunks", async () => {
    const client = Client.factory(dsn, { app: "test" });
    await client.send({ message: "chunk test", description: "foo".repeat(1100) });
    const transport = client.transport as TestTransport;
    const written = transport.written!;
    const expectChunksCount = 3;
    const expectMessageSize = 3411;
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
