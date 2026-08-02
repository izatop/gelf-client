import { expect, test } from "bun:test";
import { promisify } from "node:util";
import { inflate } from "node:zlib";
import { ConnectionOptions } from "../../src/Interface";
import { Serializer } from "../../src/Serializer";
import { TransportAbstract } from "../../src/TransportAbstract";

const decompress = promisify(inflate);

const options = (overrides: Partial<ConnectionOptions> = {}): ConnectionOptions => ({
    compress: false,
    host: "127.0.0.1",
    maxChunkSize: 1400,
    minCompressSize: 1400,
    port: 12201,
    protocol: "udp",
    strictChecks: true,
    ...overrides,
});

const joinChunks = (chunks: Buffer[]) =>
    Buffer.concat(
        [...chunks]
            .sort((left, right) => left.readUInt8(10) - right.readUInt8(10))
            .map((chunk) => chunk.subarray(12)),
    );

test("Serializer returns a small payload unchanged", async () => {
    const payload = Buffer.from("small");
    expect(await new Serializer(options()).serialize(payload)).toEqual([payload]);
});

test("Serializer chunks an uncompressed payload", async () => {
    const payload = Buffer.from("abcdefghijklmnopqrstu");
    const chunks = await new Serializer(
        options({ maxChunkSize: 20, minCompressSize: 1 }),
    ).serialize(payload);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.readUInt8(10))).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.readUInt8(11))).toEqual([3, 3, 3]);
    expect(joinChunks(chunks)).toEqual(payload);
});

test("Serializer compresses a chunked payload", async () => {
    const payload = Buffer.from("payload".repeat(100));
    const chunks = await new Serializer(
        options({ compress: true, maxChunkSize: 20, minCompressSize: 1 }),
    ).serialize(payload);

    expect(chunks[0].subarray(0, 2)).toEqual(Buffer.from([0x1e, 0x0f]));
    expect(await decompress(joinChunks(chunks))).toEqual(payload);
});

test("Serializer rejects more than 128 chunks", async () => {
    await expect(
        new Serializer(options({ maxChunkSize: 13, minCompressSize: 1 })).serialize(
            Buffer.alloc(129),
        ),
    ).rejects.toThrow("Cannot log messages bigger than 128 bytes");
});

test("Transport emits write errors and closes its resource", async () => {
    const writeError = new Error("write failed");

    class FailingTransport extends TransportAbstract {
        public destroyed = false;

        protected write() {
            throw writeError;
        }

        protected destroy() {
            this.destroyed = true;
        }
    }

    const transport = new FailingTransport(options());
    const emittedError = new Promise<unknown>((resolve) => transport.once("error", resolve));

    await transport.send({ message: "write error" });
    expect(await emittedError).toBe(writeError);

    transport.close();
    expect(transport.destroyed).toBe(true);
});
