# Política de seguridad

HanniPI es un agente de código que se ejecuta **localmente**, dentro del límite de seguridad del
usuario que lo lanza. Eres responsable de supervisar sus operaciones o de contenerlo en un
contenedor, máquina virtual u otro sandbox.

HanniPI considera la cuenta local y los ficheros escribibles por ella como parte del mismo límite
de confianza que el propio proceso. Si un atacante puede modificar ficheros del home, del workspace,
del shell, del entorno o de la configuración de HanniPI, en general puede influir en HanniPI o en
otras herramientas locales. Los reportes que dependen de ese acceso local previo **no** son
vulnerabilidades, salvo que demuestren cómo HanniPI otorga ese acceso o cruza un límite de
privilegios del sistema operativo.

HanniPI **no incluye sandbox**: instalar extensiones y skills de confianza y trabajar en
repositorios de confianza es responsabilidad del usuario. `AGENTS.md` o instrucciones en comentarios
pueden inyectar prompt al agente de forma trivial, y eso no se puede evitar por diseño.

## Reportar una vulnerabilidad

Reporta en privado mediante **GitHub Security Advisories** de este repositorio
(https://github.com/AlPeFe/HanniPI/security/advisories/new). No abras un issue público para temas
de seguridad.

Incluye:

- Descripción del problema y su impacto.
- Pasos de reproducción, PoC o logs relevantes.
- Paquete, versión, commit o configuración afectados.
- Mitigaciones conocidas.

## Alcance

El código de este repositorio y los binarios distribuidos desde sus releases.

## Fuera de alcance

- Ejecución local de código y ausencia de sandbox (por diseño).
- Extensiones o skills instaladas por el usuario, y trabajar en repositorios no confiables.
- Inyección de prompt y salidas maliciosas del modelo.
- Secretos de terceros controlados por el usuario.
- Reportes que requieren poder escribir estado local del usuario (configuración, dotfiles,
  workspace, `AGENTS.md`), salvo que demuestren que HanniPI otorga ese acceso.
- MITM no confiables, exposición pública de una instalación, o acciones locales aprobadas por el
  usuario presentadas como vulnerabilidades.
