import {Client, Level} from "../../src";
import {Timestamp, Transport} from "../../src/config";
import {TestTransport} from "./TestTransport";

const dsn = "test://localhost:123";
const clientDefaults = {foo: 1};
const time = 1574345698437;
const timestamp = Math.round(time / 1000);

Transport.add("test", TestTransport);
Object.defineProperty(Timestamp, "now", {get: () => timestamp});

test("Add transport", () => {
    expect(Timestamp.now).toBe(timestamp);
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
    expect(JSON.parse(written.toString("utf-8"))).toEqual({
        timestamp,
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

    expect(message.length).toBe(expectMessageSize);
    expect(JSON.parse(message)).toMatchSnapshot();
});
