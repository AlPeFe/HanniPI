import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isCatalogOffline,
	PackageCatalogError,
	parseCatalogResponse,
	searchPiPackages,
	toNpmSource,
} from "../src/core/package-catalog.ts";
import { allowNetwork } from "./test-network-env.ts";

const searchPayload = {
	objects: [
		{
			package: {
				name: "pi-mcp-adapter",
				version: "5.3.0",
				description: "MCP adapter extension for Pi",
				date: "2026-10-13T05:20:00.000Z",
				publisher: { username: "nicopreme" },
			},
			downloads: { monthly: 1618815 },
		},
		{ package: { name: "pi-memory", version: "2.1.0", description: "" } },
		// Entradas rotas: se ignoran sin romper la lista.
		{ package: { version: "1.0.0" } },
		{ notAPackage: true },
	],
};

describe("catálogo de paquetes de Pi", () => {
	// La suite corre con PI_OFFLINE=1: aquí la red es un mock, así que se habilita.
	beforeEach(() => {
		allowNetwork();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("busca en npm por el keyword pi-package y resume los resultados", async () => {
		let requestedUrl = "";
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			requestedUrl = String(url);
			return new Response(JSON.stringify(searchPayload), { status: 200 });
		});
		const results = await searchPiPackages("mcp", { fetchImpl: fetchImpl as unknown as typeof fetch, limit: 20 });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(requestedUrl).toContain("https://registry.npmjs.org/-/v1/search");
		expect(requestedUrl).toContain(encodeURIComponent("keywords:pi-package mcp"));
		expect(requestedUrl).toContain("size=20");

		expect(results).toEqual([
			{
				name: "pi-mcp-adapter",
				version: "5.3.0",
				description: "MCP adapter extension for Pi",
				publishedAt: "2026-10-13T05:20:00.000Z",
				publisher: "nicopreme",
				monthlyDownloads: 1618815,
			},
			{ name: "pi-memory", version: "2.1.0", description: "" },
		]);
	});

	it("acepta una query vacía (los destacados del catálogo)", async () => {
		let requestedUrl = "";
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			requestedUrl = String(url);
			return new Response(JSON.stringify({ objects: [] }), { status: 200 });
		});
		await searchPiPackages("  ", { fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(requestedUrl).toContain(encodeURIComponent("keywords:pi-package"));
		expect(requestedUrl).not.toContain("%20mcp");
	});

	it("da un error claro cuando el registro no responde o contesta mal", async () => {
		const failing = vi.fn(async () => {
			throw new Error("getaddrinfo ENOTFOUND");
		});
		await expect(searchPiPackages("mcp", { fetchImpl: failing as unknown as typeof fetch })).rejects.toThrow(
			PackageCatalogError,
		);
		await expect(searchPiPackages("mcp", { fetchImpl: failing as unknown as typeof fetch })).rejects.toThrow(
			/No pude consultar el catálogo/,
		);

		const notOk = vi.fn(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }));
		await expect(searchPiPackages("mcp", { fetchImpl: notOk as unknown as typeof fetch })).rejects.toThrow(
			/503 Service Unavailable/,
		);
	});

	it("respeta PI_OFFLINE y no consulta la red", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		const fetchImpl = vi.fn();
		expect(isCatalogOffline()).toBe(true);
		expect(await searchPiPackages("mcp", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("normaliza los payloads incompletos y las fuentes npm", () => {
		expect(parseCatalogResponse(null)).toEqual([]);
		expect(parseCatalogResponse({ objects: "nope" })).toEqual([]);
		expect(toNpmSource("pi-memory")).toBe("npm:pi-memory");
		expect(toNpmSource("npm:pi-memory")).toBe("npm:pi-memory");
		expect(toNpmSource("  ")).toBe("");
	});
});
