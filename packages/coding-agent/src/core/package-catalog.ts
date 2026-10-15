/**
 * Catálogo de paquetes nativos de Pi (`https://pi.dev/packages`).
 *
 * La galería de pi.dev es el registro npm filtrado por el keyword `pi-package`: un paquete con ese
 * keyword (`package.json`) es elegible y se instala con `hanni install npm:<nombre>`. `pi.dev/api/packages`
 * está reservado, así que la búsqueda va contra `registry.npmjs.org/-/v1/search`.
 */

export const PI_PACKAGE_KEYWORD = "pi-package";

/** Endpoint público de búsqueda del registro npm. */
const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";

/** Resumen de un paquete del catálogo, tal como se pinta en el selector. */
export interface PiPackageSummary {
	/** Nombre npm, sin el prefijo `npm:`. */
	name: string;
	description: string;
	version: string;
	/** ISO date del último publish. */
	publishedAt?: string;
	publisher?: string;
	monthlyDownloads?: number;
}

export interface SearchPiPackagesOptions {
	/** Máximo de resultados (1-250, por defecto 25). */
	limit?: number;
	signal?: AbortSignal;
	/** Inyectable para tests. */
	fetchImpl?: typeof fetch;
}

export class PackageCatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackageCatalogError";
	}
}

/** `PI_OFFLINE=1|true|yes` deja el catálogo vacío, igual que el resto de accesos de red del gestor. */
export function isCatalogOffline(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * Busca en el catálogo. `query` vacía devuelve los paquetes más relevantes (npm ordena por score);
 * con texto se filtran nombre/descripcion. Lanza `PackageCatalogError` si el registro no responde.
 */
export async function searchPiPackages(
	query: string,
	options: SearchPiPackagesOptions = {},
): Promise<PiPackageSummary[]> {
	if (isCatalogOffline()) return [];

	const limit = Math.min(250, Math.max(1, Math.floor(options.limit ?? 25)));
	const text = [`keywords:${PI_PACKAGE_KEYWORD}`, query.trim()].filter(Boolean).join(" ");
	const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(text)}&size=${limit}`;
	const fetchImpl = options.fetchImpl ?? fetch;

	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { accept: "application/json" },
			signal: options.signal ?? AbortSignal.timeout(10_000),
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new PackageCatalogError(`No pude consultar el catálogo (${reason}).`);
	}
	if (!response.ok) {
		throw new PackageCatalogError(`El catálogo respondió ${response.status} ${response.statusText}.`);
	}

	const body = (await response.json().catch(() => undefined)) as unknown;
	return parseCatalogResponse(body);
}

/** Extrae los resúmenes del payload de búsqueda de npm; ignora entradas incompletas. */
export function parseCatalogResponse(body: unknown): PiPackageSummary[] {
	if (!isRecord(body) || !Array.isArray(body.objects)) return [];
	const out: PiPackageSummary[] = [];
	for (const entry of body.objects) {
		if (!isRecord(entry) || !isRecord(entry.package)) continue;
		const pkg = entry.package;
		const name = typeof pkg.name === "string" ? pkg.name : undefined;
		if (!name) continue;
		const publisher =
			isRecord(pkg.publisher) && typeof pkg.publisher.username === "string" ? pkg.publisher : undefined;
		const downloads =
			isRecord(entry.downloads) && typeof entry.downloads.monthly === "number" ? entry.downloads : undefined;
		out.push({
			name,
			description: typeof pkg.description === "string" ? pkg.description : "",
			version: typeof pkg.version === "string" ? pkg.version : "",
			...(typeof pkg.date === "string" ? { publishedAt: pkg.date } : {}),
			...(publisher ? { publisher: publisher.username as string } : {}),
			...(downloads ? { monthlyDownloads: downloads.monthly as number } : {}),
		});
	}
	return out;
}

/** `npm:pi-foo` → `pi-foo`; deja intacto lo que ya es un nombre sin prefijo. */
export function toNpmSource(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "";
	return trimmed.startsWith("npm:") ? trimmed : `npm:${trimmed}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
