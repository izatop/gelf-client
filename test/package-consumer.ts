import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const rootDirectory = process.cwd();

const assertFile = (path: string) => access(path);

const assertMissingFile = async (path: string) => {
    try {
        await access(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
    throw new Error(`The packed package contains build metadata: ${path}`);
};

const run = async (command: string[], cwd: string) => {
    const child = Bun.spawn(command, {
        cwd,
        env: { ...process.env, TMPDIR: cwd },
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
        throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
    }
};

const main = async () => {
    const packageJson = await Bun.file(join(rootDirectory, "package.json")).json();
    const temporaryDirectory = join(rootDirectory, ".local");
    await mkdir(temporaryDirectory, { recursive: true });
    const consumerDirectory = await mkdtemp(join(temporaryDirectory, "gelf-client-consumer-"));
    const tarballName = `${packageJson.name}-${packageJson.version}.tgz`;
    const tarballPath = join(consumerDirectory, tarballName);
    const nodeModulesDirectory = join(consumerDirectory, "node_modules");
    const installedPackageDirectory = join(nodeModulesDirectory, packageJson.name);

    try {
        await run(["bun", "run", "build"], rootDirectory);
        await run(["bun", "pm", "pack", "--destination", consumerDirectory], rootDirectory);
        await mkdir(installedPackageDirectory, { recursive: true });
        await run(
            ["tar", "-xzf", tarballPath, "-C", installedPackageDirectory, "--strip-components=1"],
            rootDirectory,
        );

        const packedPackageJson = JSON.parse(
            await readFile(join(installedPackageDirectory, "package.json"), "utf8"),
        );
        await Promise.all(
            [
                "dist/index.mjs",
                "dist/index.mjs.map",
                "dist/index.cjs",
                "dist/index.cjs.map",
                "dist/types/index.d.ts",
            ].map((path) => assertFile(join(installedPackageDirectory, path))),
        );
        await Promise.all(
            ["dist/tsconfig.esnext.tsbuildinfo", "dist/tsconfig.cjs.tsbuildinfo"].map((path) =>
                assertMissingFile(join(installedPackageDirectory, path)),
            ),
        );

        const rootExport = packedPackageJson.exports?.["."];
        if (
            rootExport?.types !== "./dist/types/index.d.ts" ||
            rootExport?.import !== "./dist/index.mjs" ||
            rootExport?.require !== "./dist/index.cjs"
        ) {
            throw new Error("The packed package does not expose the dual entrypoints");
        }

        if (packedPackageJson.dependencies?.["@types/node"] !== undefined) {
            throw new Error("The published package must not depend on @types/node at runtime");
        }
        if (typeof packedPackageJson.devDependencies?.["@types/node"] !== "string") {
            throw new Error(
                "The published package must keep @types/node as a development dependency",
            );
        }

        await mkdir(join(nodeModulesDirectory, "@types"), { recursive: true });
        await cp(
            join(rootDirectory, "node_modules", "@types", "node"),
            join(nodeModulesDirectory, "@types", "node"),
            { recursive: true },
        );
        await cp(
            join(rootDirectory, "node_modules", "undici-types"),
            join(nodeModulesDirectory, "undici-types"),
            { recursive: true },
        );

        await writeFile(
            join(consumerDirectory, "package.json"),
            `${JSON.stringify(
                {
                    private: true,
                    type: "module",
                },
                null,
                2,
            )}\n`,
        );
        await writeFile(
            join(consumerDirectory, "tsconfig.json"),
            `${JSON.stringify(
                {
                    compilerOptions: {
                        module: "preserve",
                        moduleResolution: "bundler",
                        noEmit: true,
                        strict: true,
                        target: "esnext",
                    },
                    include: ["index.ts"],
                },
                null,
                2,
            )}\n`,
        );
        await writeFile(
            join(consumerDirectory, "index.ts"),
            [
                `import GELFClient from "${packageJson.name}";`,
                "",
                'const client = GELFClient.factory("udp://localhost:12201");',
                'client.info({message: "consumer typecheck"});',
                "",
            ].join("\n"),
        );
        await writeFile(
            join(consumerDirectory, "index.mjs"),
            [
                `import GELFClient, { Client, Level } from "${packageJson.name}";`,
                'if (GELFClient !== Client) throw new Error("ESM default export mismatch");',
                'if (Level.INFO !== 6) throw new Error("ESM named export mismatch");',
                "",
            ].join("\n"),
        );
        await writeFile(
            join(consumerDirectory, "index.cjs"),
            [
                `const { default: GELFClient, Client, Level } = require("${packageJson.name}");`,
                'if (GELFClient !== Client) throw new Error("CJS default export mismatch");',
                'if (Level.INFO !== 6) throw new Error("CJS named export mismatch");',
                "",
            ].join("\n"),
        );

        await run(
            [
                "bun",
                join(rootDirectory, "node_modules", "typescript", "bin", "tsc"),
                "-p",
                "tsconfig.json",
            ],
            consumerDirectory,
        );
        await run(["node", "index.mjs"], consumerDirectory);
        await run(["node", "index.cjs"], consumerDirectory);
    } finally {
        await rm(consumerDirectory, { recursive: true, force: true });
    }
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
