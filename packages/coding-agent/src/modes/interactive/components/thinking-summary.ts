/**
 * Vista compacta de un bloque de pensamiento (thinking).
 *
 * Esto es SOLO presentación: el modelo sigue recibiendo el thinking completo en el contexto y en la
 * sesión (nada de lo que hay aquí se le manda ni le afecta). Lo que cambia es lo que se pinta en la
 * terminal, porque el thinking suele venir cargado de código y de pasos repetidos que hacen la sesión
 * muy densa de leer.
 *
 * Reglas: fuera los bloques de código (con un aviso de cuántas líneas tenían), fuera las líneas vacías
 * repetidas y recorte a las primeras líneas. Un clic en el bloque enseña el texto completo.
 */

/** Líneas de pensamiento visibles por defecto. */
const MAX_THINKING_LINES = 8;
/** Tope de caracteres visibles por defecto (una sola línea larga no se come la pantalla). */
const MAX_THINKING_CHARS = 700;

function clip(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Bloque de código → una línea de aviso ("⋯ (código oculto: 12 líneas)"). */
function dropCodeBlocks(lines: string[]): string[] {
	const kept: string[] = [];
	let openMarker: string | undefined;
	let codeLines = 0;
	for (const line of lines) {
		const fence = line.match(/^\s*(```|~~~)/);
		if (openMarker !== undefined) {
			codeLines++;
			if (fence && line.trim().startsWith(openMarker)) {
				kept.push(`⋯ (código oculto: ${codeLines - 1} ${codeLines - 1 === 1 ? "línea" : "líneas"})`);
				openMarker = undefined;
				codeLines = 0;
			}
			continue;
		}
		if (fence) {
			openMarker = fence[1];
			codeLines = 0;
			continue;
		}
		kept.push(line);
	}
	// Bloque sin cerrar (el modelo venía escribiendo cuando llegó el corte).
	if (openMarker !== undefined) kept.push(`⋯ (código oculto: ${codeLines} ${codeLines === 1 ? "línea" : "líneas"})`);
	return kept;
}

export function summarizeThinking(text: string): string {
	const lines = dropCodeBlocks(text.replace(/\r\n/g, "\n").split("\n"));

	// Líneas vacías repetidas: no aportan y empujan el contenido fuera de la vista.
	const compact: string[] = [];
	for (const line of lines) {
		if (!line.trim() && compact.length > 0 && !compact[compact.length - 1].trim()) continue;
		compact.push(line);
	}
	while (compact.length > 0 && !compact[compact.length - 1].trim()) compact.pop();

	const kept: string[] = [];
	let chars = 0;
	let dropped = 0;
	for (let index = 0; index < compact.length; index++) {
		const line = compact[index];
		if (kept.length === 0 && line.length > MAX_THINKING_CHARS) {
			kept.push(clip(line, MAX_THINKING_CHARS));
			dropped = compact.length - 1;
			break;
		}
		if (kept.length >= MAX_THINKING_LINES || chars + line.length > MAX_THINKING_CHARS) {
			dropped = compact.length - index;
			break;
		}
		kept.push(line);
		chars += line.length;
	}

	const summary = kept.join("\n").trim();
	if (dropped > 0) {
		return `${summary}\n… (+${dropped} ${dropped === 1 ? "línea" : "líneas"})`;
	}
	return summary;
}
