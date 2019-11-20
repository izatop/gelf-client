import * as net from "net";
import {Url} from "url";
import {TransportAbstract} from "../TransportAbstract";

export class TCPTransport extends TransportAbstract {
    protected socket: net.Socket;
    constructor(info: Url) {
        super(info);
        this.socket = net.connect({host: this.hostname, port: this.port});
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
