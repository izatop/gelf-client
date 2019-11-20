import * as assert from "assert";
import {EventEmitter} from "events";
import {Url} from "url";
import {Serializer} from "./Serializer";

export const MAX_CHUNK_SIZE = 1400;

export abstract class TransportAbstract extends EventEmitter {
    public readonly hostname: string;
    public readonly port: number;
    public readonly serializer: Serializer;

    constructor(info: Url) {
        super();
        this.port = +(info.port || 12201);
        this.hostname = info.hostname!;

        assert(this.hostname, `Empty hostname`);
        assert(this.port === this.port, `Wrong port number ${this.port}`);

        const options = new URLSearchParams(info.query as string || "");
        this.serializer = new Serializer({
            compress: options.has("compress"),
            minCompressSize: MAX_CHUNK_SIZE,
            maxChunkSize: MAX_CHUNK_SIZE,
        });
    }

    public send(data: object) {
        this.enqueue(Buffer.from(JSON.stringify(data), "utf-8"));
    }

    public close() {
        this.destroy();
    }

    protected async enqueue(data: Buffer) {
        try {
            for (const chunk of await this.serializer.serialize(data)) {
                this.write(chunk);
            }
        } catch (error) {
            this.emit("error", error);
        }
    }

    protected abstract write(data: Buffer): void;

    protected abstract destroy(): void;
}

export type TransportCtor<T extends TransportAbstract = TransportAbstract> = new(info: Url) => T;
