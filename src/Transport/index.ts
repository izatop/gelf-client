import * as assert from "assert";
import {TransportCtor} from "../TransportAbstract";
import {TCPTransport} from "./TCPTransport";
import {UDPTransport} from "./UDPTransport";

const transports = new Map<string, TransportCtor>([
    ["tcp", TCPTransport],
    ["udp", UDPTransport],
]);

/**
 * Validate protocol and return the constructor of a transport class
 *
 * @param proto
 */
export function getTransport(proto?: string | null): TransportCtor {
    assert(proto && transports.has(proto), `Transport for protocol ${proto} doesn't exists`);
    return transports.get(proto!)!;
}
