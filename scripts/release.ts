export type Bump = "patch" | "minor" | "major";

export type RegistryLookup = (name: string, version: string) => Promise<boolean>;

export type CommandRunner = (
    command: string[],
    cwd?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface PreparedRelease {
    action: "create" | "reuse";
    name: "gelf-client";
    version: string;
    tag: string;
}

export interface InspectedRelease {
    name: "gelf-client";
    version: string;
    tag: string;
    published: boolean;
}

interface ReleasePackage {
    name: "gelf-client";
    version: string;
}

interface PrepareReleaseOptions {
    cwd: string;
    bump: Bump;
    baseSha: string;
    lookupVersion?: RegistryLookup;
}

interface InspectReleaseOptions {
    cwd: string;
    tag: string;
    lookupVersion?: RegistryLookup;
}

interface PushReleaseOptions {
    cwd: string;
    tag: string;
}

const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

const commandRunner: CommandRunner = async (command, cwd) => {
    const child = Bun.spawn(command, {
        cwd,
        env: process.env,
        stderr: "pipe",
        stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
};

const checked = async (runner: CommandRunner, command: string[], cwd: string) => {
    const result = await runner(command, cwd);
    if (result.exitCode !== 0) {
        throw new Error(`${command.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
};

function assertBump(bump: string): asserts bump is Bump {
    assert(["patch", "minor", "major"].includes(bump), `Unsupported release bump: ${bump}`);
}

const assertTag = (tag: string) => {
    const match = /^v(.+)$/.exec(tag);
    if (match === null || !stableSemver.test(match[1])) {
        throw new Error("Release tag must have the form v<semver>");
    }
    return match[1];
};

const readReleasePackage = (content: string): ReleasePackage => {
    const value: unknown = JSON.parse(content);
    const packageJson = value as { name?: unknown; version?: unknown };
    assert(packageJson.name === "gelf-client", "Release package must be gelf-client");
    assert(
        typeof packageJson.version === "string" && stableSemver.test(packageJson.version),
        "Release package version must be stable semver",
    );
    return { name: "gelf-client", version: packageJson.version };
};

const readReleasePackageAt = async (runner: CommandRunner, cwd: string, path: string) =>
    readReleasePackage(await checked(runner, ["git", "show", path], cwd));

const readReleasePackageFromDirectory = async (cwd: string) =>
    readReleasePackage(await readFile(join(cwd, "package.json"), "utf8"));

const assertOnlyPackageJsonChanged = async (runner: CommandRunner, cwd: string) => {
    const changed = (await checked(runner, ["git", "diff", "--name-only", "HEAD"], cwd))
        .split("\n")
        .filter(Boolean);
    assert(
        changed.length === 1 && changed[0] === "package.json",
        "Release versioning changed files other than package.json",
    );
};

const optionalGitCommit = async (runner: CommandRunner, cwd: string, ref: string) => {
    const result = await runner(["git", "rev-parse", "-q", "--verify", ref], cwd);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
};

export const lookupNpmVersion = async (
    name: string,
    version: string,
    runner: CommandRunner = commandRunner,
) => {
    const result = await runner(["npm", "view", `${name}@${version}`, "version", "--json"]);
    if (result.exitCode === 0) {
        return true;
    }
    if (result.stderr.includes("E404")) {
        return false;
    }
    throw new Error(`Could not query npm for ${name}@${version}: ${result.stderr}`);
};

export const prepareRelease = async ({
    cwd,
    bump,
    baseSha,
    lookupVersion = lookupNpmVersion,
}: PrepareReleaseOptions): Promise<PreparedRelease> => {
    const runner = commandRunner;
    assertBump(bump);
    assert(
        (await checked(runner, ["git", "rev-parse", "HEAD"], cwd)) === baseSha,
        "Release base does not match HEAD",
    );
    await checked(runner, ["bun", "pm", "version", bump, "--no-git-tag-version"], cwd);
    assert(
        (await checked(runner, ["git", "rev-parse", "HEAD"], cwd)) === baseSha,
        "Release base does not match HEAD after versioning",
    );
    const releasePackage = await readReleasePackageFromDirectory(cwd);
    const tag = `v${releasePackage.version}`;
    await assertOnlyPackageJsonChanged(runner, cwd);
    const tagCommit = await optionalGitCommit(runner, cwd, `${tag}^{commit}`);

    if (tagCommit === undefined) {
        assert(
            !(await lookupVersion(releasePackage.name, releasePackage.version)),
            `${releasePackage.name}@${releasePackage.version} already exists on npm without a valid retry tag`,
        );
        await checked(runner, ["git", "add", "package.json"], cwd);
        await checked(
            runner,
            ["git", "commit", "-m", `release: prepare version ${releasePackage.version}`],
            cwd,
        );
        await checked(runner, ["git", "tag", "-a", tag, "-m", tag], cwd);
        const releaseParent = await optionalGitCommit(runner, cwd, `${tag}^{commit}^`);
        assert(
            releaseParent === baseSha,
            `${tag} is not a release commit based on the workflow SHA`,
        );
        return { action: "create", ...releasePackage, tag };
    }

    assert(
        (await checked(runner, ["git", "cat-file", "-t", `refs/tags/${tag}`], cwd)) === "tag",
        `${tag} must be an annotated release tag`,
    );
    const tagParent = await optionalGitCommit(runner, cwd, `${tag}^{commit}^`);
    assert(tagParent === baseSha, `${tag} is not a release commit based on the workflow SHA`);
    const taggedPackage = await readReleasePackageAt(runner, cwd, `${tag}:package.json`);
    assert(
        taggedPackage.version === releasePackage.version,
        `${tag} does not contain package version ${releasePackage.version}`,
    );
    return { action: "reuse", ...releasePackage, tag };
};

export const inspectRelease = async ({
    cwd,
    tag,
    lookupVersion = lookupNpmVersion,
}: InspectReleaseOptions): Promise<InspectedRelease> => {
    const runner = commandRunner;
    const releasePackage = await readReleasePackageFromDirectory(cwd);
    const tagVersion = assertTag(tag);
    assert(
        tagVersion === releasePackage.version,
        `Release tag ${tag} does not match package version ${releasePackage.version}`,
    );
    const tagCommit = await checked(runner, ["git", "rev-parse", `${tag}^{commit}`], cwd);
    assert(
        (await checked(runner, ["git", "rev-parse", "HEAD"], cwd)) === tagCommit,
        `Checked-out commit does not match ${tag}`,
    );
    return {
        ...releasePackage,
        tag,
        published: await lookupVersion(releasePackage.name, releasePackage.version),
    };
};

export const pushRelease = async ({ cwd, tag }: PushReleaseOptions): Promise<void> => {
    assertTag(tag);
    await checked(
        commandRunner,
        ["git", "push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`],
        cwd,
    );
};
import { readFile } from "node:fs/promises";
import { join } from "node:path";
