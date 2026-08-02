import { expect, test } from "bun:test";
import { parseConnectionString, Transport } from "../../src/config";
import { TestTransport } from "./TestTransport";

test("Connection strings apply defaults and flags", () => {
    expect(parseConnectionString("udp://localhost")).toMatchObject({
        compress: false,
        host: "localhost",
        maxChunkSize: 1400,
        minCompressSize: 1400,
        port: 12201,
        protocol: "udp",
    });
    expect(
        parseConnectionString(
            "udp://graylog:65535/?compress&strict&maxChunkSize=2048&minCompressSize=4096",
        ),
    ).toMatchObject({
        compress: true,
        host: "graylog",
        maxChunkSize: 2048,
        minCompressSize: 4096,
        port: 65535,
        protocol: "udp",
        strictChecks: true,
    });
});

test.each([
    ["tcp://localhost:0", 12201],
    ["tcp://localhost:65536", 12201],
    ["tcp://localhost/?maxChunkSize=1", 1400],
    ["tcp://localhost/?minCompressSize=NaN", 1400],
])("Connection strings replace invalid numeric values in %s", (dsn, expected) => {
    const parsed = parseConnectionString(dsn);
    const actual = dsn.includes("maxChunkSize")
        ? parsed.maxChunkSize
        : dsn.includes("minCompressSize")
          ? parsed.minCompressSize
          : parsed.port;
    expect(actual).toBe(expected);
});

test("Connection strings require a host", () => {
    expect(() => parseConnectionString("udp:///missing-host")).toThrow("Empty hostname");
});

test("Transport rejects unknown protocols", () => {
    expect(() => Transport.get("missing")).toThrow("Transport for protocol missing doesn't exists");
    expect(() => Transport.get(123 as unknown as string)).toThrow();
});

test("Transport accepts custom protocols", () => {
    Transport.add("coverage-test", TestTransport);
    expect(Transport.get("coverage-test")).toBe(TestTransport);
});

test("Production connection strings disable strict checks by default", async () => {
    const child = Bun.spawn(
        [
            "bun",
            "-e",
            'import { parseConnectionString } from "./src/config.ts"; if (parseConnectionString("udp://localhost").strictChecks) throw new Error("strict checks enabled");',
        ],
        {
            cwd: process.cwd(),
            env: { ...process.env, NODE_ENV: "production" },
            stderr: "pipe",
        },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
});
