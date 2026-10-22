# Memoria del proyecto — AlPeFe/HanniPI

Volcado de la memoria del proyecto generado por `/dumpgram`: qué se ha decidido, qué se ha hecho y en qué se quedó el trabajo. Está pensado para que una persona (o un agente sin acceso a la base de datos) entienda el repo leyendo estos ficheros.

_Generado el 2026-10-22 desde la memoria de HanniGram · 16 observaciones · no editar a mano: se regenera con `/dumpgram`._

## Estado en curso

### handoff: AlPeFe/HanniPI

handoff · `handoff/actual` · 2026-10-20 · #64

objetivo: la sesion ha muerto antes, hanblamos sobre benchmark del harness en cuanto a consumo de tokens y como mejorarlo si es necesario
hecho: 0a8e34dcb docs(odd): release 0.2.19-hannipi
ficheros: (árbol sin cambios)
en curso: odd/tasks/memoria-hannigram-usabilidad.md (0/0 pasos)
siguiente: revisar los cambios pendientes

## Ficheros

| Fichero | Contenido | Observaciones |
| --- | --- | --- |
| [`docs/memoria/decisiones.md`](decisiones.md) | Decisiones y convenciones | 4 |
| [`docs/memoria/hecho.md`](hecho.md) | Qué se ha hecho | 2 |
| [`docs/memoria/sesiones.md`](sesiones.md) | Sesiones y estado en curso | 1 |
| [`docs/memoria/contexto.md`](contexto.md) | Descubrimientos, patrones y contexto | 9 |

## Índice de temas

| Tema | Última observación | Observaciones |
| --- | --- | --- |
| `handoff/actual` | handoff: AlPeFe/HanniPI | 1 → sesiones.md |
| `hannipi/release/estado` | Release v0.2.19-hannipi publicada (fix de caché de prefijo en el binario) | 1 → decisiones.md |
| `hannipi/costes/tokens` | Benchmark de tokens del harness: el overhead fijo no es la palanca, los misses de caché sí | 1 → contexto.md |
| `hannipi/memoria/cache-prefijo` | Caché de prefijo: no tocar el system prompt a mitad de sesión | 1 → decisiones.md |
| `hannipi/tui/rail-servicios` | Panel servicios del rail: puertos activos y de dónde salen | 1 → contexto.md |
| `hannipi/tui/arranque-modelo` | La TUI arranca sin modelo y obliga a elegirlo | 1 → decisiones.md |
| `nextjs/node-sqlite-filas-planas` | node:sqlite: las filas no pueden cruzar a componentes de cliente sin aplanarlas | 1 → contexto.md |
| `hannipi/memoria/skipmemory` | Regla: /skipmemory deja HanniGram fuera del juego en todo el harness | 1 → decisiones.md |
| `hannipi/tui/rail-skills` | Panel de skills en el rail: en uso vs activado | 1 → contexto.md |
| `hannipi/tui/wheel-orca` | El chat del harness no scrollea en el terminal de Orca (fuera de Orca sí): la ruta del harness está descartada | 1 → contexto.md |
| `hannipi/tui/rail-scroll` | El rail derecho de la TUI no se desplazaba: un Container opaco se comía el scroll node | 1 → hecho.md |
| `hannipi/memoria/calidad` | Auditoría de la memoria real de HanniGram en este host: qué aporta y qué la ensucia | 1 → contexto.md |
| `hannipi/update/windows` | hanni update se mataba a si mismo (arreglado) | 1 → hecho.md |

_Además hay 3 observaciones sin tema._
