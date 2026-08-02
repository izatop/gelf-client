import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    inspectRelease,
    lookupNpmVersion,
    prepareRelease,
    pushRelease,
    type RegistryLookup,
} from "../../scripts/release";

const directories: string[] = [];

const command = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(`${args.join(" ")} failed: ${stderr}`);
    }
    return stdout.trim();
};

const createRepository = async ({
    name = "gelf-client",
    version = "1.2.3",
    versionScript,
}: {
    name?: string;
    version?: string;
    versionScript?: string;
} = {}) => {
    const cwd = await mkdtemp(join(tmpdir(), "gelf-release-test-"));
    directories.push(cwd);
    await command(cwd, "git", "init", "--initial-branch=main");
    await command(cwd, "git", "config", "user.name", "Release Test");
    await command(cwd, "git", "config", "user.email", "release@example.com");
    const packageJson = {
        name,
        version,
        ...(versionScript === undefined ? {} : { scripts: { version: versionScript } }),
    };
    await writeFile(join(cwd, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    if (versionScript !== undefined) {
        await writeFile(join(cwd, "README.md"), "original\n");
    }
    await command(cwd, "git", "add", ".");
    await command(cwd, "git", "commit", "-m", "test: create release base");
    return { cwd, baseSha: await command(cwd, "git", "rev-parse", "HEAD") };
};

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

const missing: RegistryLookup = async () => false;
const present: RegistryLookup = async () => true;

describe("prepareRelease", () => {
    test.each([
        ["patch", "1.2.4"],
        ["minor", "1.3.0"],
        ["major", "2.0.0"],
    ] as const)("creates a %s release", async (bump, version) => {
        const repository = await createRepository();
        const result = await prepareRelease({ ...repository, bump, lookupVersion: missing });

        expect(result).toEqual({
            action: "create",
            name: "gelf-client",
            version,
            tag: `v${version}`,
        });
        expect(
            await command(repository.cwd, "git", "show", `${result.tag}:package.json`),
        ).toContain(`"version": "${version}"`);
        expect(await command(repository.cwd, "git", "rev-parse", `${result.tag}^{commit}^`)).toBe(
            repository.baseSha,
        );
    });

    test("reuses the matching release tag on a full rerun", async () => {
        const repository = await createRepository();
        const first = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });
        await command(repository.cwd, "git", "checkout", "--detach", repository.baseSha);

        const retry = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: present,
        });
        expect(retry).toEqual({ ...first, action: "reuse" });
    });

    test("rejects an unsupported bump", async () => {
        const repository = await createRepository();
        await expect(
            prepareRelease({
                ...repository,
                bump: "prerelease" as "patch",
                lookupVersion: missing,
            }),
        ).rejects.toThrow("Unsupported release bump: prerelease");
    });

    test("rejects a release from another HEAD", async () => {
        const repository = await createRepository();
        await expect(
            prepareRelease({
                ...repository,
                baseSha: "0".repeat(40),
                bump: "patch",
                lookupVersion: missing,
            }),
        ).rejects.toThrow("Release base does not match HEAD");
    });

    test("rejects extra tracked changes", async () => {
        const repository = await createRepository({
            versionScript: `bun -e "await Bun.write('README.md', 'changed\\n')"`,
        });
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("Release versioning changed files other than package.json");
    });

    test("rejects a lifecycle that stages an extra tracked change", async () => {
        const repository = await createRepository({
            versionScript:
                `bun -e "await Bun.write('README.md', 'changed\\n'); ` +
                `const child = Bun.spawn(['git', 'add', 'README.md']); await child.exited"`,
        });

        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("Release versioning changed files other than package.json");
        expect(await command(repository.cwd, "git", "rev-parse", "HEAD")).toBe(repository.baseSha);
        expect(await command(repository.cwd, "git", "tag", "--list", "v1.2.4")).toBe("");
    });

    test("rejects an npm version without a matching tag", async () => {
        const repository = await createRepository();
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: present }),
        ).rejects.toThrow("gelf-client@1.2.4 already exists on npm without a valid retry tag");
    });

    test("rejects a conflicting tag", async () => {
        const repository = await createRepository();
        await command(repository.cwd, "git", "tag", "-a", "v1.2.4", "-m", "conflict");
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("v1.2.4 is not a release commit based on the workflow SHA");
    });

    test("rejects a package name other than gelf-client", async () => {
        const repository = await createRepository({ name: "other-package" });
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("Release package must be gelf-client");
    });

    test("rejects a retry tag with a different package version", async () => {
        const repository = await createRepository();
        await writeFile(join(repository.cwd, "README.md"), "retry conflict\n");
        await command(repository.cwd, "git", "add", "README.md");
        await command(repository.cwd, "git", "commit", "-m", "test: conflicting retry");
        await command(repository.cwd, "git", "tag", "-a", "v1.2.4", "-m", "v1.2.4");
        await command(repository.cwd, "git", "checkout", "--detach", repository.baseSha);

        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("v1.2.4 does not contain package version 1.2.4");
    });

    test("rejects a matching lightweight retry tag", async () => {
        const repository = await createRepository();
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });
        await command(repository.cwd, "git", "tag", "-d", prepared.tag);
        await command(repository.cwd, "git", "tag", prepared.tag);
        await command(repository.cwd, "git", "checkout", "--detach", repository.baseSha);

        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow("v1.2.4 must be an annotated release tag");
    });

    test("reports checked command failures with the command and stderr", async () => {
        const repository = await createRepository({
            versionScript: "printf 'version script failed' >&2; exit 7",
        });
        await expect(
            prepareRelease({ ...repository, bump: "patch", lookupVersion: missing }),
        ).rejects.toThrow(
            /bun pm version patch --no-git-tag-version failed: .*version script failed/s,
        );
    });
});

describe("inspectRelease", () => {
    test("returns whether npm already contains the checked-out tag", async () => {
        const repository = await createRepository();
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });
        expect(
            await inspectRelease({
                cwd: repository.cwd,
                tag: prepared.tag,
                lookupVersion: present,
            }),
        ).toEqual({ name: "gelf-client", version: "1.2.4", tag: "v1.2.4", published: true });
    });

    test.each([
        ["release-1.2.3", "Release tag must have the form v<semver>"],
        ["v1.2.4", "Release tag v1.2.4 does not match package version 1.2.3"],
    ])("rejects invalid tag %s", async (tag, message) => {
        const repository = await createRepository();
        await expect(
            inspectRelease({ cwd: repository.cwd, tag, lookupVersion: missing }),
        ).rejects.toThrow(message);
    });

    test("rejects an unstable package version", async () => {
        const repository = await createRepository({ version: "1.2.3-beta.1" });
        await expect(
            inspectRelease({ cwd: repository.cwd, tag: "v1.2.3", lookupVersion: missing }),
        ).rejects.toThrow("Release package version must be stable semver");
    });

    test("rejects a checkout that differs from the publish tag", async () => {
        const repository = await createRepository();
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });
        await command(repository.cwd, "git", "commit", "--allow-empty", "-m", "test: move HEAD");

        await expect(
            inspectRelease({ cwd: repository.cwd, tag: prepared.tag, lookupVersion: missing }),
        ).rejects.toThrow("Checked-out commit does not match v1.2.4");
    });
});

describe("pushRelease", () => {
    test("pushes main and the release tag to a bare remote", async () => {
        const repository = await createRepository();
        const remote = await mkdtemp(join(tmpdir(), "gelf-release-remote-"));
        directories.push(remote);
        await command(remote, "git", "init", "--bare", "--initial-branch=main");
        await command(repository.cwd, "git", "remote", "add", "origin", remote);
        await command(
            repository.cwd,
            "git",
            "push",
            "origin",
            `${repository.baseSha}:refs/heads/main`,
        );
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });

        await pushRelease({ cwd: repository.cwd, tag: prepared.tag });

        const remoteMain = await command(remote, "git", "rev-parse", "refs/heads/main");
        const remoteTag = await command(remote, "git", "rev-parse", "refs/tags/v1.2.4^{commit}");
        expect(remoteMain).toBe(remoteTag);
    });

    test("leaves main unchanged when the remote rejects the tag", async () => {
        const repository = await createRepository();
        const remote = await mkdtemp(join(tmpdir(), "gelf-release-remote-"));
        directories.push(remote);
        await command(remote, "git", "init", "--bare", "--initial-branch=main");
        await command(repository.cwd, "git", "remote", "add", "origin", remote);
        await command(
            repository.cwd,
            "git",
            "push",
            "origin",
            `${repository.baseSha}:refs/heads/main`,
        );
        const hook = join(remote, "hooks", "pre-receive");
        await writeFile(
            hook,
            '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/tags/*) exit 1;; esac\ndone\n',
        );
        await chmod(hook, 0o755);
        const prepared = await prepareRelease({
            ...repository,
            bump: "patch",
            lookupVersion: missing,
        });

        await expect(pushRelease({ cwd: repository.cwd, tag: prepared.tag })).rejects.toThrow();
        expect(await command(remote, "git", "rev-parse", "refs/heads/main")).toBe(
            repository.baseSha,
        );
    });
});

test("distinguishes npm presence, absence, and registry failure", async () => {
    const result =
        (exitCode: number, stdout = "", stderr = "") =>
        async () => ({ exitCode, stdout, stderr });
    expect(await lookupNpmVersion("gelf-client", "1.2.4", result(0, '"1.2.4"'))).toBe(true);
    expect(
        await lookupNpmVersion("gelf-client", "1.2.4", result(1, "", "npm error code E404")),
    ).toBe(false);
    await expect(
        lookupNpmVersion("gelf-client", "1.2.4", result(1, "", "npm error code E500")),
    ).rejects.toThrow("Could not query npm for gelf-client@1.2.4");
});
