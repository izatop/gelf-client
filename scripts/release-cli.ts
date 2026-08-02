import { appendFile } from "node:fs/promises";
import { inspectRelease, prepareRelease, pushRelease, type Bump } from "./release";

const usage = `Usage:
  bun scripts/release-cli.ts prepare <patch|minor|major> <base-sha>
  bun scripts/release-cli.ts push <v-semver-tag>
  bun scripts/release-cli.ts inspect <v-semver-tag>`;

const writeResult = async (result: unknown) => {
    const output = process.env.GITHUB_OUTPUT;
    if (output === undefined) {
        console.log(JSON.stringify(result));
        return;
    }
    if (result === undefined) {
        return;
    }
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        await appendFile(output, `${key}=${value}\n`);
    }
};

const main = async () => {
    const [command, ...args] = process.argv.slice(2);
    if (command === "prepare" && args.length === 2) {
        const [bump, baseSha] = args;
        await writeResult(
            await prepareRelease({ cwd: process.cwd(), bump: bump as Bump, baseSha }),
        );
        return;
    }
    if (command === "push" && args.length === 1) {
        await writeResult(await pushRelease({ cwd: process.cwd(), tag: args[0] }));
        return;
    }
    if (command === "inspect" && args.length === 1) {
        await writeResult(await inspectRelease({ cwd: process.cwd(), tag: args[0] }));
        return;
    }
    throw new Error(usage);
};

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
