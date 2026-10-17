---
topic_key: hannipi/feat/memoria-usabilidad
status: active
---
# memoria-hannigram-usabilidad
Objetivo: que HanniPI recuerde de verdad — retomar el mismo repo días después, con lo decidido y lo que quedó a medias — apoyándose en HanniGram y no en reexplorar ficheros del proyecto.
Por qué: la memoria existía (tools `mem_*`, daemon, rail) pero nadie la inyectaba ni la mantenía; una sesión nueva empezaba a ciegas y volvía a leer AGENTS.md/odd/*.md para reconstruir el contexto.
Alcance: lado harness (extensión `hanniorq`: briefing al arrancar, handoff rodante, guidelines) + hallazgos para el lado HanniGram (atribución de proyecto, dedupe, limpieza). Fuera: rediseño del esquema de la BD.
Verify: tests `hanniorq-extension.e2e.test.ts` (briefing + handoff), `npm run check`, y en una sesión real el bloque `<memoria>` del system prompt con los datos del proyecto.

## Pasos
- [x] S1 Briefing al arrancar: `before_agent_start` inyecta la sección `memoria` (última sesión + decisiones + trabajo en curso) y una guideline de consultar memoria antes de explorar. Evidence: commit 96aff39b8.
- [x] S2 Handoff rodante: si el turno deja trabajo y no hay `mem_session_summary`, se actualiza `handoff/actual` (una fila por proyecto). Evidence: commit fe2e19064.
- [x] S3 Aislar los tests de la memoria real (los tests metían proyectos temporales y ADRs de prueba en la BD del usuario). Evidence: commit f3e85f3b9.
- [ ] S4 HanniGram: atribución de proyecto por repo (git remote), no por cwd — hoy `alexp` guardó 2 observaciones de TSNU y `AlPeFe/HanniPI` tiene rootPath de un subdirectorio.
- [ ] S5 HanniGram: `projects` con contadores + purga de proyectos vacíos (38 proyectos, 33 de tests) y poder mover/fusionar observaciones entre proyectos.
- [ ] S6 HanniGram: dedupe de resúmenes de sesión (se guardó dos veces el mismo trabajo con ids distintos) y `mem_session_summary` idempotente por sesión.
- [ ] S7 Harness: mostrar en el rail/footer cuándo el briefing viene de memoria (o de nada) y `hanniorq resume` real (hoy es un mensaje de texto).

## Siguiente
S4: decidir la identidad de proyecto (git remote + raíz del repo) y hacer que el harness siempre escriba con ella.

## Notas
- Medición del host (2026-10-17): 11 observaciones, 3 sesiones, 38 proyectos (33 vacíos de tests). Calidad del contenido real alta (ver revisión en el resumen de sesión); el problema era el ruido de los tests y la atribución por cwd.
- El briefing cuesta 1 petición por sesión (cacheado) y degrada a nada si el daemon no responde.
- El handoff rodante no escribe sin objetivo de sesión ni en árbol sin cambios.
