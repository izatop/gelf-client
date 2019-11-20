import {parse} from "url";
import {IEnvelope, IMessage, IMessageRest, MessageDefaults} from "./Interface";
import {Level} from "./Level";
import {getTransport} from "./Transport";
import {TransportAbstract} from "./TransportAbstract";

const STRICT_CHECKS = process.env.NODE_ENV !== "production";

export class Client {
    public readonly version = "1.1";
    public readonly transport: TransportAbstract;
    public readonly defaults: MessageDefaults = {};

    private constructor(transport: TransportAbstract, defaults: MessageDefaults = {}) {
        this.transport = transport;
        this.defaults = defaults;
    }

    public static factory(dsn: string, defaults: MessageDefaults = {}) {
        const config = parse(dsn);
        const transport = getTransport(config.protocol);
        return new this(new transport(config), defaults);
    }

    public clone(defaults: MessageDefaults = {}) {
        return new Client(this.transport, {...this.defaults, ...defaults});
    }

    public send(data: IMessage & IMessageRest) {
        const {level, message, description, file, line, app, ...rest} = data;
        if (STRICT_CHECKS) {
            this.strictChecks(Object.keys(rest));
        }

        const timestamp = Math.round(Date.now() / 1000);
        const envelope: IEnvelope = {
            host: app,
            level: level || Level.INFO,
            version: this.version,
            short_message: message,
            full_message: description,
            timestamp,
            file,
            line,
        };

        for (const [key, value] of Object.entries(rest)) {
            envelope[`_${key}`] = value;
        }

        this.transport.send(envelope);
    }

    public close() {
        this.transport.close();
    }

    private strictChecks(keys: string[]) {
        const regex = /^([a-zA-Z0-9_])+$/;
        if (keys.some((key) => !regex.test(key))) {
            throw new Error(`Custom fields strict checks failed: ${keys.join(", ")}`);
        }
    }
}
