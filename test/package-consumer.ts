import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const rootDirectory = process.cwd();

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

        await run(
            [
                "bun",
                join(rootDirectory, "node_modules", "typescript", "bin", "tsc"),
                "-p",
                "tsconfig.json",
            ],
            consumerDirectory,
        );
    } finally {
        await rm(consumerDirectory, { recursive: true, force: true });
    }
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
