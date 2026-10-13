import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHanniGramDaemon } from "../src/extensions/hanniorq/hannigram-daemon.ts";

const originalDaemon = process.env.HANNIGRAM_DAEMON;
const originalUrls = process.env.HANNIGRAM_URLS;

afterEach(() => {
	if (originalDaemon === undefined) delete process.env.HANNIGRAM_DAEMON;
	else process.env.HANNIGRAM_DAEMON = originalDaemon;
	if (originalUrls === undefined) delete process.env.HANNIGRAM_URLS;
	else process.env.HANNIGRAM_URLS = originalUrls;
});

describe("ensureHanniGramDaemon", () => {
	it("starts a configured daemon only when needed and waits for health", async () => {
		process.env.HANNIGRAM_DAEMON = "hannigram-test-daemon";
		delete process.env.HANNIGRAM_URLS;
		let checks = 0;
		const fetcher = vi.fn(async () => {
			checks++;
			return new Response(JSON.stringify({ status: checks > 1 ? "ok" : "starting" }), { status: 200 });
		});
		const spawnDaemon = vi.fn();

		await expect(
			ensureHanniGramDaemon({
				cwd: process.cwd(),
				baseUrl: "http://127.0.0.1:9876",
				fetcher,
				spawnDaemon,
				wait: async () => {},
				startupTimeoutMs: 100,
			}),
		).resolves.toBe(true);

		expect(spawnDaemon).toHaveBeenCalledWith("hannigram-test-daemon", ["--urls", "http://127.0.0.1:9876"]);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("does not spawn when already healthy or when no daemon can be resolved", async () => {
		const spawnDaemon = vi.fn();
		const healthyFetch = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		await expect(
			ensureHanniGramDaemon({
				cwd: process.cwd(),
				baseUrl: "http://localhost:8765",
				fetcher: healthyFetch,
				spawnDaemon,
			}),
		).resolves.toBe(true);
		expect(spawnDaemon).not.toHaveBeenCalled();

		process.env.HANNIGRAM_DAEMON = "missing/path/daemon";
		const unavailableFetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
		await expect(
			ensureHanniGramDaemon({
				cwd: process.cwd(),
				baseUrl: "http://localhost:8765",
				fetcher: unavailableFetch,
				spawnDaemon,
			}),
		).resolves.toBe(false);
		expect(spawnDaemon).not.toHaveBeenCalled();
	});
});
