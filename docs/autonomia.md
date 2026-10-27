# Autonomía acotada — `goal`, `autonomy`, `auto`

HanniPI puede ejecutar **solo los pasos que ya están escritos en la ficha sODD**, uno detrás de otro, con
verificación y commit entre cada uno. No planifica, no añade trabajo y no se auto-evalúa: eso es otra
cosa (y no está implementada a propósito).

La idea: tú escribes el plan, la máquina lo ejecuta mientras estás a otra cosa, y para sola en cuanto
deja de haber progreso real o se acaba el presupuesto.

---

## 1. El estado vive en la ficha

Todo lo que necesita el bucle está en el **frontmatter** de `odd/tasks/<slug>.md`. No hay base de datos
paralela: el fichero manda, es diffable y lo puedes editar a mano.

```markdown
---
topic_key: AlPeFe/HanniPI/feat/rail-origen
status: active
base: a1b2c3d
goal: "cada tarea del rail muestra de dónde viene"
done_when:
  - "las tres fuentes se distinguen con ≡ / ▤ / ⛁"
  - "npm run check limpio"
verify:
  - npm run check
  - node --test test/hanniorq-extract.test.ts
autonomy: guarded
max_iterations: 4
max_idle: 1
max_tokens: 200000
---

# rail-origen

## Pasos
- [x] S1 explorar el rail — 1a2b3c4
- [ ] S2 pintar el origen (verify: node --test test/hanniorq-extract.test.ts)
- [ ] S3 documentar

## Siguiente
S2: añadir el prefijo de origen en railSections()
```

### Campos

| campo | obligatorio | qué hace |
|---|---|---|
| `goal` | sí | el objetivo en una frase. Sin `goal` no hay autonomía |
| `done_when` | recomendado | condiciones observables de "está terminado" (las lee el humano y el cierre) |
| `verify` | recomendado | comandos de verificación globales. Un paso puede llevar el suyo: `(verify: …)` |
| `autonomy` | sí | `off` (por defecto) o `guarded` |
| `max_iterations` | no | techo de pasos **por invocación** (por defecto 3, máximo absoluto 10) |
| `max_idle` | no | iteraciones seguidas sin progreso antes de parar (por defecto 1) |
| `max_tokens` | no | presupuesto de tokens de la invocación entera (por defecto 200.000) |

**"Progreso" es un hecho, no una opinión**: un commit nuevo (cambia el sha de `HEAD`) o un paso más
marcado `[x]`. Si el turno no deja ninguna de las dos cosas, cuenta como iteración sin progreso.

---

## 2. Cómo se lanza

### Ruta corta (lo normal)

```text
/hanniorq goal "arreglar el rail para que muestre el origen de cada tarea" --plan
```

Crea la ficha (o actualiza la activa) con el `goal` en el frontmatter y, con **`--plan`**, pide al agente que
proponga los pasos en `## Pasos` (3-6, atómicos, cada uno con su `verify` cuando aplique). El agente **no
implementa nada**: solo escribe el plan. Tú lo revisas.

Sin `--plan`, la ficha se crea con `## Pasos` vacío y los escribes tú.

```text
/hanniorq goal "…" --done "las tres fuentes se ven" --verify "npm run check" --max-tokens 150000
```

`--done` y `--verify` se pueden repetir. `--max-iterations`, `--max-idle` y `--max-tokens` fijan los
límites. Los acentos y espacios van entre comillas (el parser las respeta).

Revisa los pasos y después:

```text
/hanniorq autonomy on      # autonomy: guarded en ESA ficha
/hanniorq auto             # hasta 3 pasos
/hanniorq auto 5           # hasta 5 (limitado por max_iterations y por el techo de 10)
```

**Nada se ejecuta hasta `auto`.** `goal`, `goal --plan` y `autonomy on` solo escriben la ficha; `auto` es el
único que manda turnos al agente.

### Ruta con ficha existente

Si ya tienes `odd/tasks/<slug>.md` y `odd/.active` apuntando a ella, salta el `goal` si ya está, y ve
directo a `autonomy on` + `auto`.

### Mientras corre

- **Rail derecho, panel `goal`**: `▸ <objetivo>`, `guarded · 2/7 pasos` y, si hay bucle,
  `auto 2/3 · 45k/200k tok · idle 0/1`.
- **`/hanniorq status`**: estado completo (goal, autonomía, límites, pasos, iteración y tokens).
- **`/hanniorq stop`**: corta el bucle ya. La ficha queda abierta con lo hecho.
- **Escribir tú un prompt**: también corta el bucle (no compite contigo por el turno).
- **`Esc` (abortar el turno)**: corta el bucle. No se reenvía nada.

---

## 3. Qué hace el agente en cada iteración

El prompt de cada paso es autocontenido y con las reglas cerradas:

1. Implementa **solo** ese paso. Nada de trabajo extra, nada de reordenar el plan.
2. Verifica con el `verify:` del paso o, si no lo tiene, con el global de la ficha.
3. Commit atómico (convención del repo).
4. En la ficha: marca `- [x] S<n> … — <sha7>` y reescribe `## Siguiente`.
5. Si el paso no es ejecutable, el verify sigue fallando o hay que decidir diseño: **para y explica el
   bloqueo** en dos líneas.

Cada paso es un turno completo, así que paga el coste de un turno: el presupuesto va en tokens reales
del modelo (input + output + caché) y se corta **antes** de mandar el siguiente turno, no después.

---

## 4. Cuándo para (y qué hacer)

| motivo | qué significa | qué hacer |
|---|---|---|
| `plan terminado: no quedan pasos pendientes` | todos los `[x]` | revisa `done_when`, verifica y `/hanniorq close` |
| `hecho: N de M pasos de esta invocación` | llegó al techo del run | vuelve a lanzar `/hanniorq auto` si quieres seguir |
| `sin progreso en N iteraciones` | ni commit ni paso marcado | lee qué pasó, arregla el paso o el verify, y relanza |
| `presupuesto agotado (…)` | se acabaron los tokens | sube `max_tokens` si el trabajo lo merece, o parte la ficha |
| `turno abortado` | pulsaste Esc | retoma con `/hanniorq auto` |
| `detenido por ti` | `/hanniorq stop` | ídem |
| `has escrito tú` | escribiste mientras corría | ídem |
| `autonomía apagada` (aviso, no arranca) | `autonomy: off` | `/hanniorq autonomy on` |
| `la ficha desapareció` | se movió/borró el fichero | recupera la ficha y relanza |

En **todos** los casos la ficha y el goal se quedan como están: nada se borra y no se revierte el
trabajo hecho. Los commits son la red de seguridad.

---

## 5. Ejemplo completo

```text
# 1. el objetivo y sus criterios (--plan: el agente propone los pasos, sin implementarlos)
/hanniorq goal "el rail marca si cada tarea viene del turno, de odd/tasks o de HanniGram" --plan \
  --done "≡ ▤ ⛁ visibles por fila" \
  --done "README y CHANGELOG al día" \
  --verify "npm run check" \
  --max-tokens 150000

# 2. revisa los pasos que ha propuesto en odd/tasks/<slug>.md (y ajústalos si hace falta)

# 3. ejecución desatendida
/hanniorq autonomy on
/hanniorq auto 3

# 4. mientras corre, en otra terminal o en el rail: /hanniorq status
#    si se va de las manos: /hanniorq stop

# 5. cierre
/hanniorq close
```

---

## 6. Cuándo NO usarlo

- **Trabajo de diseño o decisiones**: si un paso requiere elegir entre alternativas, el bucle se
  detendrá en el primer bloqueo (que es lo correcto, pero entonces no ganas nada).
- **Fichas sin `verify`**: sin verificación, "progreso" se reduce a "hubo commit", y eso lo cumple
  cualquier cambio. Escribe el `verify` antes.
- **Pasos que se pisan entre sí**: el bucle es secuencial; si dos pasos tocan el mismo fichero a la vez,
  no hay paralelismo que valga.
- **Cuando no quieres gastar tokens sin mirar**: `max_tokens` bajo y `max_idle: 1` te dan runs cortos
  y revisables, que suele ser mejor que uno largo y opaco.

---

## 7. Qué NO hace

- No inventa pasos ni reordena el plan. Si el plan está mal, el bucle se para, no lo arregla.
- No se auto-evalúa: el criterio de progreso es externo (commit/`[x]`), no la opinión del modelo.
- No hace `push` ni abre PRs. Los commits son locales.
- No sustituye a tu revisión: `done_when` se comprueba al cerrar, con evidencia.
- No guarda el estado en HanniGram: la ficha manda. La memoria solo aporta contexto.
