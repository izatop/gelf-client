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
        publish: {
            needs: string;
            if: string;
            permissions: Record<string, string>;
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
        expect(workflow.jobs.publish.permissions).toEqual({
            contents: "read",
            "id-token": "write",
        });
    });

    test("serializes releases and preserves tag pushes", () => {
        expect(workflow.on.push.tags).toEqual(["v*"]);
        expect(workflow.concurrency).toEqual({
            group: "npm-publish-${{ github.repository }}",
            "cancel-in-progress": false,
        });
    });

    test("routes manual preparation into the publish job", () => {
        expect(workflow.jobs.prepare.if).toBe("github.event_name == 'workflow_dispatch'");
        expect(workflow.jobs.publish.needs).toBe("prepare");
        expect(workflow.jobs.publish.if).toBe(
            "always() && (github.event_name == 'push' || needs.prepare.result == 'success')",
        );
    });

    test("removes the push-on-version package hook", () => {
        expect(packageJson.scripts.postversion).toBeUndefined();
    });
});
