import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PiPackageSummary } from "../src/core/package-catalog.ts";
import { PackageManagerSelector } from "../src/modes/interactive/components/package-manager-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

function render(selector: PackageManagerSelector, width = 100): string {
	return selector.render(width).join("\n");
}

function createSelector(
	options: { search?: (query: string, signal?: AbortSignal) => Promise<PiPackageSummary[]> } = {},
) {
	const installed: string[] = [];
	const updated: string[] = [];
	const removed: string[] = [];
	let closed = false;
	const selector = new PackageManagerSelector(
		[
			{ source: "npm:pi-web-access", scope: "user", installed: true, updateAvailable: false },
			{ source: "npm:pi-memory", scope: "default", installed: false, updateAvailable: true },
		],
		() => {
			closed = true;
		},
		() => {},
		async (source) => {
			installed.push(source);
		},
		async (source) => {
			updated.push(source ?? "todos");
		},
		async (source) => {
			removed.push(source);
		},
		options.search,
	);
	return { selector, installed, updated, removed, isClosed: () => closed };
}

describe("selector de paquetes", () => {
	it("lista los paquetes con su ambito, estado y updates", () => {
		const { selector } = createSelector();
		const text = render(selector);
		expect(text).toContain("Paquetes / Extensiones");
		expect(text).toContain("npm:pi-web-access");
		expect(text).toContain("[global]");
		expect(text).toContain("● activo");
		expect(text).toContain("npm:pi-memory");
		expect(text).toContain("[default]");
		expect(text).toContain("↑ update");
		expect(text).toContain("c → buscar en el catálogo");
	});

	it("actualiza y elimina el paquete seleccionado con u y d", () => {
		const { selector, updated, removed } = createSelector();
		selector.handleInput("\u001b[B"); // abajo → npm:pi-memory (default)
		selector.handleInput("u");
		selector.handleInput("U");
		selector.handleInput("d"); // default: no se elimina
		expect(updated).toEqual(["npm:pi-memory", "todos"]);

		selector.handleInput("\u001b[A"); // arriba → npm:pi-web-access
		selector.handleInput("d");
		expect(removed).toEqual(["npm:pi-web-access"]);
	});

	it("busca en el catálogo y instala el paquete elegido como npm:<nombre>", async () => {
		vi.useFakeTimers();
		try {
			const search = vi.fn(
				async (query: string): Promise<PiPackageSummary[]> =>
					query === "mem"
						? [
								{ name: "pi-memory", version: "2.1.0", description: "Memoria persistente" },
								{ name: "pi-mcp-adapter", version: "5.3.0", description: "MCP adapter" },
							]
						: [],
			);
			const { selector, installed } = createSelector({ search });

			selector.handleInput("c");
			await vi.advanceTimersByTimeAsync(0); // búsqueda inicial (destacados)
			expect(search).toHaveBeenCalledWith("", expect.anything());
			expect(render(selector)).toContain("sin resultados");

			for (const key of "mem") selector.handleInput(key);
			await vi.advanceTimersByTimeAsync(400); // debounce
			expect(search).toHaveBeenLastCalledWith("mem", expect.anything());

			const text = render(selector);
			expect(text).toContain("Catálogo de paquetes");
			expect(text).toContain("pi-memory");
			expect(text).toContain("Memoria persistente");
			expect(text).toContain("2.1.0");

			selector.handleInput("\r");
			expect(installed).toEqual(["npm:pi-memory"]);
			// Ya instalado: el marcador sale en el catálogo.
			expect(render(selector)).toContain("[instalado]");
		} finally {
			vi.useRealTimers();
		}
	});

	it("vuelve al listado con esc desde el catálogo", async () => {
		vi.useFakeTimers();
		try {
			const { selector, isClosed } = createSelector({ search: async () => [] });
			selector.handleInput("c");
			await vi.advanceTimersByTimeAsync(0);
			selector.handleInput("\u001b"); // esc: vuelve al listado, no cierra
			const text = render(selector);
			expect(text).toContain("Paquetes / Extensiones");
			expect(text).toContain("es esc cerrar".slice(3));
			expect(isClosed()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("muestra el error del catálogo sin perder el listado", async () => {
		vi.useFakeTimers();
		try {
			const { selector } = createSelector({
				search: async () => {
					throw new Error("No pude consultar el catálogo (offline).");
				},
			});
			selector.handleInput("c");
			await vi.advanceTimersByTimeAsync(0);
			expect(render(selector)).toContain("No pude consultar el catálogo (offline).");
			selector.handleInput("\u001b");
			expect(render(selector)).toContain("Paquetes / Extensiones");
		} finally {
			vi.useRealTimers();
		}
	});
});
