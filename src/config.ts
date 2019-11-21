import * as assert from "assert";
import {parse} from "url";
import {promisify} from "util";
import {deflate, ZlibOptions} from "zlib";
import {ConnectionOptions} from "./Interface";
import {TCPTransport, UDPTransport} from "./Transport";
import {TransportCtor} from "./TransportAbstract";

// @see https://docs.graylog.org/en/3.1/pages/gelf.html#chunking
export const GELF_MAGIC_NO = [0x1e, 0x0f];

export const MAX_CHUNK_SIZE = 1400;
export const MIN_COMPRESS_SIZE = 1400;

// Strict checks
export const STRICT_CHECKS = process.env.NODE_ENV !== "production";

const getIntValue = (value: any, min: number, max: number, defaultValue: number) => {
    if (!value) {
        return defaultValue;
    }

    const intValue = +value;
    if (intValue !== intValue || intValue < min || intValue > max) {
        return defaultValue;
    }

    return Math.round(intValue);
};

// compress is a promised zlib.deflate function
export const compress: (data: Buffer, options?: ZlibOptions) => Promise<Buffer> = promisify(deflate);

// transports
export const Transport = {
    transports: new Map<string, TransportCtor>([
        ["tcp", TCPTransport],
        ["udp", UDPTransport],
    ]),
    add(proto: string, transport: TransportCtor) {
        this.transports.set(proto, transport);
    },
    get(proto: string): TransportCtor {
        assert(
            typeof proto === "string" && this.transports.has(proto),
            `Transport for protocol ${proto} doesn't exists`,
        );

        return this.transports.get(proto)!;
    },
};

export const Timestamp = {
    get now() {
        return Math.round(Date.now() / 1000);
    },
};

export const parseConnectionString = (dsn: string): ConnectionOptions => {
    const config = parse(dsn);
    const options = new URLSearchParams(config.query as string || "");
    const alwaysStrictChecks = options.has("strict") || STRICT_CHECKS;

    assert(config.hostname, `Empty hostname`);
    assert(config.protocol, `Empty protocol`);

    // Ports 1024-49151 are the User Ports and are the ones to use for your own protocols.
    const port = getIntValue(config.port, 1024, 49151, 12201);
    const host = config.hostname!;
    const protocol = config.protocol!.substr(0, config.protocol!.length - 1);

    const maxChunkSize = getIntValue(
        options.get("maxChunkSize"),
        MAX_CHUNK_SIZE,
        Number.MAX_SAFE_INTEGER,
        MAX_CHUNK_SIZE,
    );

    const minCompressSize = getIntValue(
        options.get("minCompressSize"),
        MIN_COMPRESS_SIZE,
        Number.MAX_SAFE_INTEGER,
        MIN_COMPRESS_SIZE,
    );

    return {
        port,
        host,
        protocol,
        minCompressSize,
        maxChunkSize,
        compress: options.has("compress"),
        strictChecks: options.has("strict") || STRICT_CHECKS,
    };
};
