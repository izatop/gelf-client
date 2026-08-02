import { beforeAll, describe, expect, test } from "bun:test";

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
        };
        validate: {
            needs: string;
            if: string;
            permissions: Record<string, string>;
            steps: Array<{
                name?: string;
                uses?: string;
                run?: string;
            }>;
        };
        publish: {
            needs: string;
            if: string;
            permissions: Record<string, string>;
            steps: Array<{
                name?: string;
                uses?: string;
                run?: string;
            }>;
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
