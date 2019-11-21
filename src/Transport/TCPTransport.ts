import * as net from "net";
import {Url} from "url";
import {ConnectionOptions} from "../Interface";
import {TransportAbstract} from "../TransportAbstract";

export class TCPTransport extends TransportAbstract {
    protected socket: net.Socket;
    constructor(options: ConnectionOptions) {
        super(options);
        this.socket = net.connect({host: this.options.host, port: this.options.port});
        this.socket.on("error", (error) => this.emit("error", error));
        this.socket.unref();
    }

    public write(data: Buffer) {
        this.socket.write(data);
    }

    protected destroy() {
        this.socket.end();
    }
}
