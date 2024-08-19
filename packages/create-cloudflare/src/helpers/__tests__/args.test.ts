import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../args";

vi.mock("@cloudflare/cli");
vi.mock("yargs/helpers", () => ({ hideBin: (x: string[]) => x }));

describe("Cli", () => {
	describe("parseArgs", () => {
		test("no arguments provide", async () => {
			const result = await parseArgs([]);

			if (result.type !== "default") {
				expect(result.type).toBe("default");
				return;
			}

			expect(result.args.projectName).toBeFalsy();
			expect(result.args.additionalArgs).toEqual([]);
		});

		test("parsing the first argument as the projectName", async () => {
			const result = await parseArgs(["my-project"]);

			if (result.type !== "default") {
				expect(result.type).toBe("default");
				return;
			}

			expect(result.args.projectName).toBe("my-project");
		});

		test("too many positional arguments provided", async () => {
			const result = await parseArgs(["my-project", "123"]);

			expect(result).toEqual({
				type: "unknown",
				showHelpMessage: true,
				exitCode: 1,
				additionalMessage: "Too many positional arguments provided",
			});
		});

		test("not parsing first argument as the projectName if it is after --", async () => {
			const result = await parseArgs(["--", "my-project"]);

			if (result.type !== "default") {
				expect(result.type).toBe("default");
				return;
			}

			expect(result.args.projectName).toBeFalsy();
		});

		test("parsing optional C3 arguments correctly", async () => {
			const result = await parseArgs(["--framework", "angular", "--ts=true"]);

			if (result.type !== "default") {
				expect(result.type).toBe("default");
				return;
			}

			expect(result.args.projectName).toBeFalsy();
			expect(result.args.framework).toEqual("angular");
			expect(result.args.ts).toEqual(true);
			expect(result.args.additionalArgs).toEqual([]);
		});

		test("parsing positional + optional C3 arguments correctly", async () => {
			const result = await parseArgs([
				"my-project",
				"--framework",
				"angular",
				"--deploy",
				"true",
				"--git=false",
			]);

			if (result.type !== "default") {
				expect(result.type).toBe("default");
				return;
			}

			expect(result.args.projectName).toEqual("my-project");
			expect(result.args.framework).toEqual("angular");
			expect(result.args.deploy).toEqual(true);
			expect(result.args.git).toEqual(false);
			expect(result.args.additionalArgs).toEqual([]);
		});

		test("parsing optional C3 arguments + additional arguments correctly", async () => {
			const result = await parseArgs([
				"--framework",
				"react",
				"--ts=true",
				"--",
				"positional-arg",
				"--react-option",
				"5",
			]);

			if (result.type !== "default") {
				expect(result.type).toBe("default");
				return;
			}

			expect(result.args.projectName).toBeFalsy();
			expect(result.args.framework).toEqual("react");
			expect(result.args.ts).toEqual(true);
			expect(result.args.additionalArgs).toEqual([
				"positional-arg",
				"--react-option",
				"5",
			]);
		});

		test("parsing positional + optional C3 arguments + additional arguments correctly", async () => {
			const result = await parseArgs([
				"my-react-project",
				"--framework",
				"react",
				"--ts=true",
				"--",
				"positional-arg",
				"--react-option",
				"5",
			]);

			if (result.type !== "default") {
				expect(result.type).toBe("default");
				return;
			}

			expect(result.args.projectName).toBe("my-react-project");
			expect(result.args.framework).toEqual("react");
			expect(result.args.ts).toEqual(true);
			expect(result.args.additionalArgs).toEqual([
				"positional-arg",
				"--react-option",
				"5",
			]);
		});

		const stringArgs = [
			"--framework",
			"--template",
			"--type",
			"--existing-script",
		];
		test.each(stringArgs)("%s requires an argument", async (arg) => {
			await expect(parseArgs(["my-react-project", arg])).resolves.toEqual({
				type: "unknown",
				exitCode: 1,
			});
		});
	});
});
