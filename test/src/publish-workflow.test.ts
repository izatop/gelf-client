import { beforeAll, describe, expect, test } from "bun:test";

interface WorkflowStep {
    id?: string;
    name?: string;
    uses?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
}

interface PublishWorkflow {
    on: {
        push: { tags: string[] };
        workflow_dispatch: {
            inputs: Record<
                string,
                {
                    required: boolean;
                    default: string;
                    type: string;
                    options: string[];
                }
            >;
        };
    };
    permissions: Record<string, never>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: {
        prepare: {
            if: string;
            permissions: Record<string, string>;
            outputs: Record<string, string>;
            steps: WorkflowStep[];
        };
        validate: {
            needs: string;
            if: string;
            permissions: Record<string, string>;
            outputs: Record<string, string>;
            steps: WorkflowStep[];
        };
        publish: {
            needs: string;
            if: string;
            permissions: Record<string, string>;
            steps: WorkflowStep[];
        };
    };
}

let workflow: PublishWorkflow;
let packageJson: {
    scripts: Record<string, string>;
};

beforeAll(async () => {
    workflow = Bun.YAML.parse(
        await Bun.file(".github/workflows/publish.yml").text(),
    ) as PublishWorkflow;
    packageJson = (await Bun.file("package.json").json()) as typeof packageJson;
});

const namedStep = (steps: WorkflowStep[], name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step).toBeDefined();
    return step as WorkflowStep;
};

const actionStep = (steps: WorkflowStep[], action: string) => {
    const step = steps.find((candidate) => candidate.uses === action);
    expect(step).toBeDefined();
    return step as WorkflowStep;
};

const collectStrings = (value: unknown): string[] => {
    if (typeof value === "string") {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.flatMap(collectStrings);
    }
    if (typeof value === "object" && value !== null) {
        return Object.values(value).flatMap(collectStrings);
    }
    return [];
};

describe("Publish workflow", () => {
    test("offers a safe bump selector", () => {
        const bump = workflow.on.workflow_dispatch.inputs.bump;
        expect(bump).toMatchObject({
            required: true,
            default: "patch",
            type: "choice",
            options: ["patch", "minor", "major"],
        });
        expect(workflow.on.workflow_dispatch.inputs.tag).toBeUndefined();
    });

    test("separates Git and npm authority", () => {
        expect(workflow.permissions).toEqual({});
        expect(workflow.jobs.prepare.permissions).toEqual({ contents: "write" });
        expect(workflow.jobs.validate.permissions).toEqual({ contents: "read" });
        expect(workflow.jobs.publish.permissions).toEqual({ "id-token": "write" });
    });

    test("serializes releases and preserves tag pushes", () => {
        expect(workflow.on.push.tags).toEqual(["v*"]);
        expect(workflow.concurrency).toEqual({
            group: "npm-publish-${{ github.repository }}",
            "cancel-in-progress": false,
        });
    });

    test("routes manual preparation through validation", () => {
        expect(workflow.jobs.prepare.if).toBe("github.event_name == 'workflow_dispatch'");
        expect(workflow.jobs.validate.needs).toBe("prepare");
        expect(workflow.jobs.validate.if).toBe(
            "always() && (github.event_name == 'push' || needs.prepare.result == 'success')",
        );
        expect(workflow.jobs.publish.needs).toBe("validate");
        expect(workflow.jobs.validate.outputs).toEqual({
            published: "${{ steps.release.outputs.published }}",
            version: "${{ steps.release.outputs.version }}",
            "package-sha256": "${{ steps.package.outputs.sha256 }}",
            "artifact-name": "${{ steps.package.outputs.artifact-name }}",
        });
        expect(workflow.jobs.publish.if).toBe(
            "needs.validate.result == 'success' && needs.validate.outputs.published != 'true'",
        );
    });

    test("checks out immutable refs without persisting credentials", () => {
        const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
        expect(actionStep(workflow.jobs.prepare.steps, checkout).with).toEqual({
            ref: "${{ github.sha }}",
            "fetch-depth": 0,
            "persist-credentials": false,
        });
        expect(actionStep(workflow.jobs.validate.steps, checkout).with).toEqual({
            ref: "${{ github.event_name == 'push' && github.ref || needs.prepare.outputs.tag }}",
            "fetch-depth": 0,
            "persist-credentials": false,
        });
    });

    test("packs with supported Bun flags and wires an attempt-specific artifact", () => {
        const pack = namedStep(workflow.jobs.validate.steps, "Pack validated package");
        const digest = namedStep(workflow.jobs.validate.steps, "Record package digest");
        const upload = namedStep(workflow.jobs.validate.steps, "Upload validated package");
        const download = actionStep(
            workflow.jobs.publish.steps,
            "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        );

        expect(pack).toMatchObject({
            if: "steps.release.outputs.published != 'true'",
            run: "mkdir -p .release && bun pm pack --filename .release/package.tgz --ignore-scripts",
        });
        expect(digest).toMatchObject({
            id: "package",
            if: "steps.release.outputs.published != 'true'",
            env: {
                ARTIFACT_NAME:
                    "npm-package-${{ steps.release.outputs.version }}-${{ github.run_attempt }}",
            },
        });
        expect(digest.run).toBe(
            `echo "artifact-name=$ARTIFACT_NAME" >> "$GITHUB_OUTPUT"\n` +
                `echo "sha256=$(sha256sum .release/package.tgz | cut -d ' ' -f1)" >> "$GITHUB_OUTPUT"\n`,
        );
        expect(upload.if).toBe("steps.release.outputs.published != 'true'");
        expect(upload.with).toEqual({
            name: "${{ steps.package.outputs.artifact-name }}",
            path: ".release/package.tgz",
            "if-no-files-found": "error",
            "retention-days": 1,
            "compression-level": 0,
        });
        expect(download.with).toEqual({
            name: "${{ needs.validate.outputs.artifact-name }}",
            path: ".release",
        });
    });

    test("exposes the write token only to a hook-free canonical atomic push", () => {
        const push = namedStep(workflow.jobs.prepare.steps, "Push release refs");
        expect(push.if).toBe("steps.release.outputs.action == 'create'");
        expect(push.env).toEqual({
            RELEASE_TAG: "${{ steps.release.outputs.tag }}",
            RELEASE_REPOSITORY: "${{ github.repository }}",
            GH_TOKEN: "${{ github.token }}",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_COUNT: "4",
            GIT_CONFIG_KEY_0: "core.hooksPath",
            GIT_CONFIG_VALUE_0: "/dev/null",
            GIT_CONFIG_KEY_1: "credential.username",
            GIT_CONFIG_VALUE_1: "x-access-token",
            GIT_CONFIG_KEY_2: "credential.helper",
            GIT_CONFIG_VALUE_2: "",
            GIT_CONFIG_KEY_3: "credential.helper",
            GIT_CONFIG_VALUE_3: `!f() { if test "$1" = get && grep -qx "host=github.com"; then printf '%s\\n' "password=$GH_TOKEN"; fi; }; f`,
            GIT_TERMINAL_PROMPT: "0",
        });
        expect(push.run).toBe(
            'git push --atomic "https://github.com/${RELEASE_REPOSITORY}.git" ' +
                '"HEAD:refs/heads/main" "refs/tags/${RELEASE_TAG}"',
        );
        expect(push.run).not.toContain("GH_TOKEN");
        expect(collectStrings(workflow).filter((value) => value.includes("github.token"))).toEqual([
            "${{ github.token }}",
        ]);
    });

    test("pins every action to a full commit SHA", () => {
        const actions = Object.values(workflow.jobs).flatMap((job) =>
            job.steps.map((step) => step.uses).filter((uses): uses is string => uses !== undefined),
        );
        expect(actions.length).toBeGreaterThan(0);
        for (const action of actions) {
            expect(action).toMatch(/^[^@]+@[0-9a-f]{40}$/);
        }
    });

    test("removes the push-on-version package hook", () => {
        expect(packageJson.scripts.postversion).toBeUndefined();
    });

    test("keeps release code outside the OIDC job", () => {
        const privilegedSteps = workflow.jobs.publish.steps;
        expect(privilegedSteps.map((step) => step.uses).filter(Boolean)).toEqual([
            "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
            "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        ]);
        expect(privilegedSteps.map((step) => step.run).filter(Boolean)).toEqual([
            `printf '%s  %s\\n' "$EXPECTED_SHA256" ".release/package.tgz" | sha256sum --check --strict`,
            "npm publish .release/package.tgz --ignore-scripts --provenance",
        ]);
    });
});
