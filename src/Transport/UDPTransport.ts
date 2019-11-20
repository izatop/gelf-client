import * as dgram from "dgram";
import {Url} from "url";
import {TransportAbstract} from "../TransportAbstract";

export class UDPTransport extends TransportAbstract {
    protected socket: dgram.Socket;

    constructor(info: Url) {
        super(info);
        this.socket = dgram.createSocket("udp4");
        this.socket.on("error", (error) => this.emit("error", error));
        this.socket.unref();
    }

    public write(data: Buffer) {
        this.socket.send(data, this.port, this.hostname);
    }

    public destroy() {
        this.socket.close();
    }
}
