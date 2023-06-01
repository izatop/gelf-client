import {Client, Level} from "../../src";
import {Timestamp, Transport} from "../../src/config";
import {TestTransport} from "./TestTransport";

const dsn = "test://localhost:123";
const clientDefaults = {foo: 1};

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
    expect(() => client.send({"message": "test", "@wrong": 123})).toThrow();
});

test("Client send", async () => {
    const client = Client.factory(dsn, clientDefaults);
    await client.send({message: "test"});
    const transport = client.transport as TestTransport;
    const [written] = transport.written;
    expect(written).toBeInstanceOf(Buffer);
    expect(written.length).toBeGreaterThan(0);
    const {timestamp, ...payload} = JSON.parse(written.toString("utf-8"));

    expect(timestamp <= Date.now()).toBeTruthy();
    expect(payload).toEqual({
        level: Level.INFO,
        short_message: "test",
        version: "1.1",
    });
});

test("Test chunks", async () => {
    const client = Client.factory(dsn, clientDefaults);
    await client.send({message: "chunk test", description: "foo".repeat(1100)});
    const transport = client.transport as TestTransport;
    const written = transport.written!;
    const expectChunksCount = 3;
    const expectMessageSize = 3397;
    expect(written.length).toBe(expectChunksCount);

    const chunks = new Array(written.length).fill(null);
    for (let index = 0; index < chunks.length; index++) {
        const chunk = written[index];
        const sequence = chunk.readInt8(10);
        const chunksCount = chunk.readInt8(11);
        chunks[sequence] = chunk.slice(12, chunk.length);
        expect(sequence).toBe(index);
        expect(chunksCount).toBe(expectChunksCount);
    }

    const message = Buffer.concat(chunks)
        .toString("utf-8");

    const {timestamp, ...payload} = JSON.parse(message);
    expect(message.length).toBe(expectMessageSize);
    expect(timestamp <= Date.now()).toBeTruthy();
    expect(payload).toMatchSnapshot();
});
