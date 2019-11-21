import * as dgram from "dgram";
import {Url} from "url";
import {ConnectionOptions} from "../Interface";
import {TransportAbstract} from "../TransportAbstract";

export class UDPTransport extends TransportAbstract {
    protected socket: dgram.Socket;

    constructor(options: ConnectionOptions) {
        super(options);
        this.socket = dgram.createSocket("udp4");
        this.socket.on("error", (error) => this.emit("error", error));
        this.socket.unref();
    }

    public write(data: Buffer) {
        this.socket.send(data, this.options.port, this.options.host);
    }

    public destroy() {
        this.socket.close();
    }
}
