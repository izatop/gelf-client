import {randomBytes} from "crypto";
import {compress, GELF_MAGIC_NO} from "./config";
import {ConnectionOptions} from "./Interface";

export class Serializer {
    public readonly options: ConnectionOptions;

    constructor(options: ConnectionOptions) {
        this.options = options;
    }

    public async serialize(data: Buffer) {
        if (data.length <= this.options.maxChunkSize) {
            return [data];
        }

        if (!this.options.compress && data.length >= this.options.minCompressSize) {
            return this.createChunks(data);
        }

        return this.createChunks(await compress(data));
    }

    protected createChunks(data: Buffer) {
        const bufferSize = this.options.maxChunkSize - 12;
        const chunksCount = Math.ceil(data.length / bufferSize);
        if (chunksCount > 128) {
            throw new Error(`Cannot log messages bigger than ${bufferSize * 128} bytes`);
        }

        const id = randomBytes(8);
        const chunks: Buffer[] = [];
        const length = data.length;

        let sequence = 0;
        while (sequence < chunksCount) {
            const offset = sequence * bufferSize;
            const readBytes = offset + bufferSize < length
                ? offset + bufferSize
                : length;

            const chunk = Buffer.from([
                ...GELF_MAGIC_NO, // GELF Magic bytes
                ...id, // Message identifier
                sequence++, // Sequence
                chunksCount, // Number of chunks
                ...data.slice(offset, readBytes), // Message chunk
            ]);

            chunks.push(chunk);
        }

        return chunks;
    }
}
