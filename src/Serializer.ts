import {randomBytes} from "crypto";
import {promisify} from "util";
import {deflate, ZlibOptions} from "zlib";
import {IPacketOptions} from "./Interface";

interface ICompress {
    (data: Buffer): Promise<Buffer>;

    (data: Buffer, options: ZlibOptions): Promise<Buffer>;
}

const compress: ICompress = promisify(deflate);

// @see https://docs.graylog.org/en/3.1/pages/gelf.html#chunking
const GELF_MAGIC_NO = [0x1e, 0x0f];

export class Serializer {
    public readonly compress: boolean;
    public readonly maxChunkSize: number;

    constructor(options: IPacketOptions) {
        this.compress = options.compress;
        this.maxChunkSize = options.maxChunkSize;
    }

    public async serialize(data: Buffer) {
        if (data.length <= this.maxChunkSize) {
            return [data];
        }

        if (!this.compress) {
            return this.createChunks(data);
        }

        return this.createChunks(await compress(data));
    }

    protected createChunks(data: Buffer) {
        const bufferSize = this.maxChunkSize - 12;
        const chunksCount = Math.ceil(data.length / bufferSize);
        if (chunksCount > 128) {
            throw new Error(`Cannot log messages bigger than ${bufferSize * 128} bytes`);
        }

        const id = randomBytes(8);
        const chunks: Buffer[] = [];

        let sequence = 0;
        while (sequence < chunksCount) {
            const offset = sequence * bufferSize;
            const chunk = Buffer.from([
                ...GELF_MAGIC_NO,
                ...id,
                sequence++,
                chunksCount,
                ...data.slice(offset, offset + bufferSize),
            ]);

            chunks.push(chunk);
        }

        return chunks;
    }
}
