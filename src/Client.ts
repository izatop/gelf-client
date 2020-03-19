import {parseConnectionString, Timestamp, Transport} from "./config";
import {ConnectionOptions, IEnvelope, IMessage, IMessageRest, MessageDefaults} from "./Interface";
import {Level} from "./Level";
import {TransportAbstract, TransportCtor} from "./TransportAbstract";

export class Client {
    public readonly version = "1.1";
    public readonly options: ConnectionOptions;
    public readonly transport: TransportAbstract;
    public readonly defaults: MessageDefaults = {};

    private constructor(transport: TransportAbstract, options: ConnectionOptions, defaults: MessageDefaults = {}) {
        this.transport = transport;
        this.options = options;
        this.defaults = defaults;
    }

    public static factory(dsn: string, defaults: MessageDefaults = {}): Client {
        const options = parseConnectionString(dsn);
        const transport = Transport.get(options.protocol);
        return new this(new transport(options), options, defaults);
    }

    public get isStrict() {
        return this.options.strictChecks;
    }

    public clone(defaults: MessageDefaults = {}) {
        return new Client(this.transport, this.options, {...this.defaults, ...defaults});
    }

    public send(data: IMessage & IMessageRest) {
        const {level, message, description, file, line, app, ...rest} = data;
        if (this.isStrict) {
            this.strictChecks(Object.keys(rest));
        }

        const timestamp = Timestamp.now;
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

        return this.transport.send(envelope);
    }

    public emergency(data: Exclude<IMessage, "level"> & IMessageRest) {
        return this.send({...data, level: Level.EMERGENCY});
    }

    public alert(data: Exclude<IMessage, "level"> & IMessageRest) {
        return this.send({...data, level: Level.ALERT});
    }

    public critical(data: Exclude<IMessage, "level"> & IMessageRest) {
        return this.send({...data, level: Level.CRITICAL});
    }

    public error(data: Exclude<IMessage, "level"> & IMessageRest) {
        return this.send({...data, level: Level.ERROR});
    }

    public warning(data: Exclude<IMessage, "level"> & IMessageRest) {
        return this.send({...data, level: Level.WARNING});
    }

    public notice(data: Exclude<IMessage, "level"> & IMessageRest) {
        return this.send({...data, level: Level.NOTICE});
    }

    public info(data: Exclude<IMessage, "level"> & IMessageRest) {
        this.send({...data, level: Level.INFO});
    }

    public debug(data: Exclude<IMessage, "level"> & IMessageRest) {
        return this.send({...data, level: Level.DEBUG});
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
