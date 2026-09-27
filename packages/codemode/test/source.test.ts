import { describe, expect, it } from "vitest";
import { CodemodeSourceError, parseCodemodeSource } from "../src/source.ts";

describe("parseCodemodeSource", () => {
	it("returns plain code unchanged", () => {
		expect(parseCodemodeSource("text('hi')")).toEqual({ code: "text('hi')", options: {} });
		expect(parseCodemodeSource("// just a comment\nreturn 1")).toEqual({
			code: "// just a comment\nreturn 1",
			options: {},
		});
	});

	it("parses the pragma line and keeps line numbers", () => {
		expect(parseCodemodeSource('// @exec: {"yield_time_ms": 10}\nconst a = 1;\ntext(a)')).toEqual({
			code: "\nconst a = 1;\ntext(a)",
			options: { yieldTimeMs: 10 },
		});
		expect(parseCodemodeSource('  // @exec:{"max_output_tokens":0,"timeout_ms":1500}\r\ntext(1)').options).toEqual({
			maxOutputTokens: 0,
			timeoutMs: 1500,
		});
		expect(parseCodemodeSource("// @exec: {}\ntext(1)")).toEqual({ code: "\ntext(1)", options: {} });
	});

	it("only treats the first line as a pragma", () => {
		const input = 'text(1)\n// @exec: {"yield_time_ms": 1}';
		expect(parseCodemodeSource(input)).toEqual({ code: input, options: {} });
		expect(parseCodemodeSource("// @execx {}\ntext(1)").options).toEqual({});
	});

	it("rejects empty input and invalid pragmas with Codex's messages", () => {
		const cases: [string, string | RegExp][] = [
			["", /exec expects raw JavaScript source text \(non-empty\)/],
			["  \n", /exec expects raw JavaScript source text \(non-empty\)/],
			["// @exec:\ntext(1)", /exec pragma must be a JSON object with supported fields/],
			["// @exec: {yield_time_ms: 1}\ntext(1)", /exec pragma must be valid JSON with supported fields/],
			["// @exec: [1]\ntext(1)", /exec pragma must be a JSON object with supported fields/],
			[
				'// @exec: {"yield": 1}\ntext(1)',
				"exec pragma only supports `yield_time_ms`, `max_output_tokens`, and `timeout_ms`; got `yield`",
			],
			[
				'// @exec: {"yield_time_ms": -1}\ntext(1)',
				"exec pragma field `yield_time_ms` must be a non-negative safe integer",
			],
			[
				'// @exec: {"max_output_tokens": 1.5}\ntext(1)',
				"exec pragma field `max_output_tokens` must be a non-negative safe integer",
			],
			['// @exec: {"timeout_ms": 0}\ntext(1)', /exec pragma field `timeout_ms` must be a positive integer/],
			['// @exec: {"yield_time_ms": 1}', "exec pragma must be followed by JavaScript source on subsequent lines"],
			[
				'// @exec: {"yield_time_ms": 1}\n  \n',
				"exec pragma must be followed by JavaScript source on subsequent lines",
			],
		];
		for (const [input, message] of cases) {
			expect(() => parseCodemodeSource(input), input).toThrow(CodemodeSourceError);
			expect(() => parseCodemodeSource(input), input).toThrow(message);
		}
	});
});
