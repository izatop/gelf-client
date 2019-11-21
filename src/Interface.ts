import {Level} from "./Level";
import {TransportCtor} from "./TransportAbstract";

export type ConnectionOptions = Readonly<{
    host: string;
    port: number;
    protocol: string;
    compress: boolean;
    minCompressSize: number;
    maxChunkSize: number;
    strictChecks: boolean;
}>;

export interface IMessageRest {
    [key: string]: any;
}

export interface IMessage {
    app?: string;
    level?: Level;
    message: string;
    description?: string;
    file?: string;
    line?: number;
}

export type MessageDefaults = Partial<IMessage> & IMessageRest;

export interface IEnvelope {
    level: Level;
    version: string;
    timestamp: number;
    short_message: string;
    full_message?: string;
    host?: string;
    file?: string;
    line?: number;
    [key: string]: any;
}
