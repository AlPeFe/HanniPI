# Qué se ha hecho

Trabajo cerrado: arreglos, features y releases, con el porqué.

_AlPeFe/HanniPI · 2026-10-22 · 2 observaciones · volcado de la memoria del proyecto con `/dumpgram`, no editar a mano._

### El rail derecho de la TUI no se desplazaba: un Container opaco se comía el scroll node

bugfix · `hannipi/tui/rail-scroll` · 2026-10-17 · #14

Síntoma: el rail derecho de la TUI de HanniPI (columna con proyecto/memoria/contexto/sODD/tareas/MCP/cambios) no se desplazaba con la rueda: se veía el principio y lo de abajo se perdía recortado por la terminal. La extensión `hanniorq` ya publicaba un `ScrollView` con `scrollbar: "auto"` y `overscroll: "contain"`, y el CHANGELOG ya lo daba por hecho.

Causa raíz: `InteractiveMode` creaba el contenedor del rail como `new Container()` y la extensión añadía el `ScrollView` dentro. El layout de pi-tui (`renderLayoutFrame`/`layoutComponent`) solo desciende por componentes que exponen `[LAYOUT_NODE]()` (VStack/HStack/ScrollView); un `Container` normal es opaco: se renderiza entero y el resultado se recorta contra la altura asignada. Es decir, el scroll node se perdía y `updateLayout` nunca se llamaba con una altura acotada (`viewportHeight = contentHeight` si no hay altura), así que `ScrollView.scrollBy` no tenía margen y, sobre todo, `getScrollViewsAt()` no encontraba el ScrollView al enrutar la rueda (`routeWheel` en `tui-alt-screen.ts`).

Arreglo (commit 9132db779): `RailColumn extends VStack` en `src/modes/interactive/chat-viewport.ts`, con `addChild(component)` que hace `super.addChild(component, { basis: 0, grow: 1, shrink: 1, minSize: 1 })` (el hijo se estira a toda la altura de la columna) y `InteractiveMode` lo usa como contenedor del rail. Así el widget del rail es un nodo de scroll real: la rueda y la scrollbar (arrastrable) lo recorren, y como el rail usa `overscroll: "contain"` el gesto no pasa al transcript.

Evidencia: test en `test/interactive-tui.test.ts` ("la rueda desplaza el rail sin mover el transcript") con `TuiAltScreen` + `VirtualTerminal` y un evento SGR sintético (`\x1b[<65;106;3M`, x dentro de la columna del rail). Con `Container` en lugar de `RailColumn` el test falla con `expected 0 to be greater than 0`; con `RailColumn` pasa. `npm run check` limpio.

Regla reutilizable: en pi-tui, para que un componente con scroll funcione (rueda, scrollbar, altura acotada) tiene que ser descendiente por nodos de layout; si va dentro de un `Container` cualquiera, hay que cambiar ese contenedor por un `VStack`/`HStack` con la entrada estirada (`grow: 1`).

**Qué:** Añadí `RailColumn` (pila vertical que estira al hijo a toda la altura) en `packages/coding-agent/src/modes/interactive/chat-viewport.ts` y lo puse como contenedor del rail derecho en `interactive-mode.ts`, con test funcional de la rueda sobre el rail y docs (`docs/how-pi-works.md`).

**Por qué:** El rail derecho prometía ser scrollable (CHANGELOG) pero el `ScrollView` de la extensión quedaba dentro de un `Container` opaco, así que el layout no veía el nodo de scroll y la rueda no hacía nada.

**Dónde:** packages/coding-agent/src/modes/interactive/{chat-viewport.ts,interactive-mode.ts,test/interactive-tui.test.ts,docs/how-pi-works.md}

**Aprendido:** En el layout de pi-tui solo se desciende por nodos de layout (`[LAYOUT_NODE]`): envolver un `ScrollView` en un `Container` normal mata el scroll (rueda y scrollbar) porque el contenedor es opaco y se recorta. Para un widget desplazable, la columna que lo contiene debe ser un `VStack` con el hijo en `grow: 1`.

---

### hanni update se mataba a si mismo (arreglado)

bugfix · `hannipi/update/windows` · 2026-10-17 · #7

Síntoma: cada vez que se actualizaba HanniPI en Windows, el harness seguía avisando de "nueva versión disponible" y `hanni --version` devolvía la versión vieja, como si la actualización no se aplicara nunca.

Causa raíz: `hanni update` (binario standalone) lanza `hanni-setup.ps1 -Action update`. El script descargaba y validaba todo (pi + hannigram, ~170 MB) y justo antes de instalar llamaba a `Stop-HanniProcesses`, que mataba TODOS los `hanni.exe` — incluidos el propio `hanni update` (que es un hanni.exe) y la sesión del harness desde la que se lanzaba (su ancestro). El script moría ahí: el staging quedaba en %TEMP% (`hanni-pi-staging`, `hannigram-staging`, zips) y no se llegaba a `Install-Staged`.

Evidencia: staging + zips en %TEMP% con marcas de tiempo del intento, dos carpetas `hanni-update-*` sin limpiar (el `finally` del padre nunca corrió), evento 400 de PowerShell sin 403 (procesos forzados, no salidas limpias), y `%LOCALAPPDATA%\HanniPI\hanni.exe` (0.2.14) más viejo que el zip staged (0.2.15).

Arreglo (commit 266db59a5): el instalador protege su propio PID y su cadena de padres, deja de matar `hanni.exe` (solo para el daemon de memoria y auxiliares), y sustituye la instalación renombrando el directorio (`<dir>.old-<marca>`) en vez de borrarlo: Windows no deja borrar ni sobrescribir un .exe en marcha, pero sí renombrar su carpeta. Los restos se borran en la siguiente ejecución. La versión nueva entra en vigor al reiniciar el harness (las sesiones abiertas ya no se cierran solas).

**Qué:** Arreglé el instalador de Windows para que `hanni update` complete en vez de abortar al matarse a sí mismo

**Por qué:** El usuario veía el aviso de "nueva versión" en cada arranque porque la instalación nunca se aplicaba

**Dónde:** hanni-setup.ps1 (Stop-HanniProcesses, Install-Staged, Move-Aside), packages/coding-agent/src/package-manager-cli.ts

**Aprendido:** En Windows, para auto-actualizar un exe en marcha: renombrar su carpeta y borrar después; y nunca matar "todos los procesos con este nombre", el que invoca la actualización suele ser uno de ellos.
