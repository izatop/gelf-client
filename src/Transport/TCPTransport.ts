import * as net from "net";
import { ConnectionOptions } from "../Interface";
import { TransportAbstract } from "../TransportAbstract";

export class TCPTransport extends TransportAbstract {
    protected socket: net.Socket;
    constructor(options: ConnectionOptions) {
        super(options);
        this.socket = net.connect({ host: this.options.host, port: this.options.port });
        this.socket.on("error", (error) => this.emit("error", error));
        this.socket.unref();
    }

    public write(data: Buffer) {
        this.socket.write(data);
    }

    protected enqueue(data: Buffer): Promise<void> {
        this.write(Buffer.concat([data, Buffer.from([0])]));
        return Promise.resolve();
    }

    protected destroy() {
        this.socket.end();
    }
}
