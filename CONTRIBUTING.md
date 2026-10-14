# Contribuir a HanniPI

HanniPI es un harness de desarrollo de software en terminal: agente de código, memoria persistente
por proyecto (HanniGram) y flujo de trabajo sODD. Este repositorio es **standalone**: `origin` es
`AlPeFe/HanniPI` y no se sincroniza con pi.

## Antes de tocar código

- `npm install --ignore-scripts` (sin lifecycle scripts).
- `npm run check` después de cualquier cambio de código (lint, formato, type check).
- Tests: `./test.sh` (omite los que dependen de LLM sin API keys). Para un fichero concreto, usa
  vitest desde `packages/coding-agent` (detalles en `AGENTS.md`).

## Cómo trabajamos

- **sODD**: los cambios triviales van inline con un commit atómico; el trabajo multi-paso lleva una
  ficha en `odd/tasks/<slug>.md` con pasos y evidencia por sha. Ver `.pi/skills/sodd/SKILL.md`.
- **Commits**: pequeños y pedidos con claridad → commit directo; grandes o delicados (auth,
  seguridad, publicación, migraciones, APIs públicas) → preguntar antes. Formato
  `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: mensaje`.
- **Releases**: manuales (bump + binario Windows + GitHub release). Ver `.pi/skills/release.md`.

## Reportes

- Bugs y mejoras: issues en https://github.com/AlPeFe/HanniPI/issues.
- Seguridad: ver `SECURITY.md` (reporte privado, nunca issue público).
