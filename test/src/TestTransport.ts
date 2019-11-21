import {TransportAbstract} from "../../src/TransportAbstract";

export class TestTransport extends TransportAbstract {
    public written: Buffer[] = [];
    public destroyed?: boolean;

    protected write(data: Buffer) {
        this.written.push(data);
    }

    protected destroy() {
        this.destroyed = true;
    }
}
