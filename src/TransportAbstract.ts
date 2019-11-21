import {EventEmitter} from "events";
import {Url} from "url";
import {ConnectionOptions} from "./Interface";
import {Serializer} from "./Serializer";

export abstract class TransportAbstract extends EventEmitter {
    public readonly serializer: Serializer;
    public readonly options: ConnectionOptions;

    constructor(options: ConnectionOptions) {
        super();

        this.options = options;
        this.serializer = new Serializer(options);
    }

    public send(data: object) {
        return this.enqueue(Buffer.from(JSON.stringify(data), "utf-8"));
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

export type TransportCtor<T extends TransportAbstract = TransportAbstract> = new(options: ConnectionOptions) => T;
