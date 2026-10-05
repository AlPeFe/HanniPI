---
name: sodd
description: Small ODD (Organic Driven Development) — protocolo minimalista de desarrollo para HanniPI. Usar cuando haya una tarea de desarrollo con más de un paso, para llevar una ficha de feature que sobreviva a cortes de contexto, con commits atómicos y evidencia por sha.
---

# sODD — Small ODD

Versión reducida de ODD (Organic Driven Development) para un agente único con turnos atómicos. El objetivo: que el trabajo sobreviva a cortes de contexto y deje evidencia verificable, sin burocracia.

## Cuándo usar sODD

- Tarea de desarrollo con **2+ pasos** o que toque **más de un archivo**.
- Tarea que pueda interrumpirse (cortes de contexto, cierre de sesión).
- Si la tarea es trivial (1 paso, <20 líneas): **no hay ficha**, commit directo.

## Principios

1. **El archivo es la fuente de verdad; la BD HanniGram es un índice.** La ficha `odd/tasks/<slug>.md` guarda todo; la BD solo `topic_key`, paso actual y último sha.
2. **Explorar antes de tocar.** Lee en solo lectura, en proporción a la petición.
3. **Un `verify:` por paso.** Es el comando que debe pasar antes de commitear (sustituto barato del review).
4. **Commit atómico por paso** con Conventional Commit; la evidencia es el sha.
5. **Promoción:** si la tarea crece, se promueve a ODD adulto (feature document completo).
6. **Delegación CONDICIONAL:** si la ficha activa es grande (2+ pasos, varios archivos/paquetes) y **spliteable** (pasos independientes que no chocan entre sí), delega cada parte con la tool `subagent`, pasándole la ficha recortada + el paso concreto como contexto. Un subagente no ve esta conversación, así que el contexto debe ser autocontenido (ficha + paso + verify). Los subagentes devuelven su respuesta y sobreviven (puedes cambiar a su conversación). Solo ejecuta inline lo que no sea spliteable.

## Flujo

1. **Explorar** en solo lectura, en proporción a la petición.
2. **Clasificar.** Trivial (1 paso, <20 líneas) → commit directo, sin ficha. Sustancial → ficha.
3. **Crear la ficha** `odd/tasks/<slug>.md` (plantilla abajo), escribir `odd/.active` con el slug, y `mem_save(topic_key, What/Why)`.
4. **Por cada paso:**
   - Implementar (o delegar: si la tarea tiene 2+ pasos independientes, lanza `subagent` por paso con la ficha recortada como contexto; vigila con `/hanniorq watch`).
   - Ejecutar el `verify` del paso.
   - Commit `type(scope): mensaje`.
   - Marcar `[x] S<n> <acción> — <sha7>`.
   - Reescribir la sección `## Siguiente` con el paso siguiente exacto.
   - `mem_update` (paso y sha).
5. **Al terminar:** ejecutar el verify global → `status: done` → `mem_save` con lo aprendido (Learned) → borrar `odd/.active`.
6. **Promoción:** si se cumple un criterio (abajo), `status: promoted` y generar el feature document ODD a partir de la ficha.

## Plantilla de ficha (`odd/tasks/<slug>.md`, objetivo ≤60 líneas)

```markdown
---
topic_key: <proyecto>/feat/<slug>   # obligatorio
status: active|blocked|done|promoted # obligatorio
base: <sha7>                         # obligatorio (sha de inicio)
---
# <slug>
Objetivo: <1 frase, comportamiento observable>      # obligatorio
Por qué: <1 frase>                                  # opcional
Alcance: <archivos/paquetes>; Fuera: <lo excluido>  # obligatorio
Verify: <comando global, ej. npm run check>         # obligatorio

## Pasos
- [x] S1 <acción> — a1b2c3d
- [ ] S2 <acción> (verify: node --test test/x.test.ts)
- [ ] S3 ...

## Siguiente
S2: <qué hacer exactamente, archivo:línea si se sabe>   # obligatorio, se reescribe cada turno

## Notas                                                 # opcional, ≤5 líneas
- <decisión/hallazgo no obvio>  → también mem_save
```

Los IDs `S1`, `S2`… son **fijos**: nunca se renumeran; un paso descartado se tacha.

## Criterios de promoción a ODD adulto (basta con que se cumpla uno)

- `git diff --stat <base>` supera 300 líneas cambiadas, o más de 8 archivos.
- Más de 5 pasos, o se han añadido más de 2 pasos tras crear la ficha.
- Toca más de un paquete de `packages/*` o una API pública.
- Ha habido 2 compactaciones con la ficha todavía activa.

La promoción la decide **siempre el usuario**, no el agente.

## Evidencia

- Solo `sha7` + asunto del commit en la ficha. Nunca diffs ni logs.
- El detalle se consulta con `git show <sha>` si hace falta.

## Reinyección tras compactación

Si existe `odd/.active`, al retomar (inicio de sesión o tras compactar) se reinyecta la ficha activa al contexto, recortada a las secciones `## Pasos` y `## Siguiente`. El protocolo completo no va en el prompt de sistema (costaría tokens en cada turno); solo la línea: "si existe `odd/.active`, sigue la skill sodd".
