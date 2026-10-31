/**
 * Tests for lsp.ts: what a file's extension matches, root detection, the owner's overrides, and a
 * live round-trip against the TypeScript and Python servers when they are installed.
 *
 * Run with: node --test lsp.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import createLsp, { internals } from "./lsp.ts";

interface FakeWeb {
    fields: any[];
    commands: Record<string, any>;
    disposers: (() => void)[];
    settings(fields: any): void;
    setting(name: string): unknown;
    onSettings(): () => void;
    onDispose(run?: () => void): void;
    command(name: string, command: any): void;
}

function fakeWeb(values: Record<string, unknown> = {}): FakeWeb {
    const web: FakeWeb = {
        fields: [],
        commands: {},
        disposers: [],
        settings(fields) {
            web.fields = fields;
        },
        setting(name) {
            return values[name];
        },
        onSettings() {
            return () => {};
        },
        onDispose(run) {
            if (typeof run === "function") {
                web.disposers.push(run);
            }
        },
        command(name, command) {
            web.commands[name] = command;
        },
    };

    return web;
}

const started: FakeWeb[] = [];

/** Loads the module as Pi Pocket does, with the owner's settings given. */
function start(values: Record<string, unknown> = {}) {
    const web = fakeWeb(values);
    const extension = createLsp({}, web as any) as any;

    started.push(web);

    return { web, extension, tools: extension.tools ?? [] };
}

function apiAt(cwd: string) {
    return {
        conversationId: "test",
        taskId: "t",
        callId: "c",
        snapshot: async () => ({ cwd }),
        output() {},
        diagnostic() {},
    };
}

function textOf(result: any): string {
    return (result.output ?? []).map((part: any) => part.text ?? "").join("\n");
}

after(() => {
    // What Pi Pocket does when the module goes: stop every server, so the test can exit.
    for (const web of started) {
        for (const dispose of web.disposers) {
            dispose();
        }
    }
});

test("a file's extension chooses its server", () => {
    start();

    assert.equal(internals.specsForExtension("/x/a.ts")[0]?.id, "typescript");
    assert.equal(internals.specsForExtension("/x/a.py")[0]?.id, "python");
    assert.equal(internals.specsForExtension("/x/a.rs")[0]?.id, "rust");
    assert.equal(internals.specsForExtension("/x/a.go")[0]?.id, "go");
    assert.deepEqual(internals.specsForExtension("/x/a.unknown"), []);
    assert.deepEqual(internals.specsForExtension("/x/Makefile"), []);
});

test("the table names each server once, and every extension has a language", () => {
    const ids = internals.SERVERS.map((spec) => spec.id);

    assert.equal(new Set(ids).size, ids.length);

    for (const spec of internals.SERVERS) {
        for (const extension of spec.extensions) {
            assert.ok(extension in internals.LANGUAGE_IDS, `${spec.id}: ${extension} has no language id`);
        }
    }
});

test("overrides turn a server off, and replace its command", () => {
    const { web } = start({
        overrides: JSON.stringify({ go: { disabled: true }, rust: { command: ["my-ls", "--stdio"] } }),
    });
    const specs = internals.resolvedSpecs();
    const ids = specs.map((spec) => spec.id);

    assert.ok(!ids.includes("go"), "go stays disabled");
    assert.ok(ids.includes("rust"));
    assert.deepEqual(
        specs.find((spec) => spec.id === "rust")?.candidates,
        [{ command: "my-ls", args: ["--stdio"] }],
    );
    assert.ok(web.fields.some((field) => field.name === "overrides"));
    assert.equal(web.commands.lsp?.scope, "conversation");
});

test("bad overrides JSON leaves the table as it is", () => {
    start({ overrides: "{ not json" });

    assert.equal(internals.resolvedSpecs().length, internals.SERVERS.length);
});

test("a project root is found from a file inside it, and stops at the file's own folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "lsp-root-"));

    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "go.mod"), "module example.com/x\n");

    assert.equal(await internals.rootFrom(join(root, "src", "deep"), ["go.mod"]), root);

    const orphan = await mkdtemp(join(tmpdir(), "lsp-orphan-"));

    assert.equal(await internals.rootFrom(orphan, ["go.mod"]), orphan);
});

test("a file of a language with no server says what to do", async () => {
    const { tools } = start();
    const diagnostics = tools.find((entry: any) => entry.name === "lsp_diagnostics");

    await assert.rejects(
        diagnostics.execute({ path: "thing.unknown" }, apiAt(await mkdtemp(join(tmpdir(), "lsp-none-"))), {}),
        /no language server/,
    );
});

test("live: TypeScript type errors, Python type errors, and a clean read", async () => {
    const root = await mkdtemp(join(tmpdir(), "lsp-live-"));
    const api = apiAt(root);

    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["."] }));
    await writeFile(join(root, "a.ts"), "export const n: number = 1;\n");
    await writeFile(join(root, "b.ts"), 'import { n } from "./a";\nexport const wrong: string = n;\n');
    await writeFile(join(root, "m.py"), "def f(x: int) -> str:\n    return x\n");

    const { tools } = start();
    const diagnostics = tools.find((entry: any) => entry.name === "lsp_diagnostics");
    const hover = tools.find((entry: any) => entry.name === "lsp_hover");

    assert.match(textOf(await diagnostics.execute({ path: "b.ts" }, api, {})), /Type 'number' is not assignable to type 'string'/);
    assert.match(textOf(await diagnostics.execute({ path: "m.py" }, api, {})), /not assignable to return type/);
    assert.match(textOf(await hover.execute({ path: "a.ts", line: 1, column: 14 }, api, {})), /const n: number/);
});
