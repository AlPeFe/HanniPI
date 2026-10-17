# Rysana Mono (bundled)

Rysana Mono 1.000, from the `rysana-type` 1.0.0 package. HanniPI ships a subset
of that package, chosen for two surfaces:

- `ttf/` — hinted static weights that HanniPI installs for the current user on
  Windows (`hanni-setup.ps1`). The terminal renders the TUI with them, so
  `Rysana Mono` becomes the default font face of the Windows Terminal profile.
- `web/` — core-subset variable WOFF2 faces (weight 100–900), inlined as a
  data URI by the HTML export so an exported session keeps the typeface even
  when the reader does not have it installed.

The core subset covers `U+0-36F, U+1E00-1EFF, U+2000-206F, U+20A0-20CF,
U+2100-215F, U+2190-21FF, U+2212, U+FEFF, U+FFFD`; anything outside it falls
back to the next font in the stack.

The full package also ships Sans, OTF builds, the unhinted TTF set and every
static weight. To refresh these files, copy from a `rysana-type` release:

| File | Source | SHA-256 |
|---|---|---|
| `ttf/RysanaMono-Regular.ttf` | `ttf-hinted/RysanaMono-Regular.ttf` | `a3da6bc9474d915fc6e41746e37b59b35e783222a04642c52e4cd0e09d647f26` |
| `ttf/RysanaMono-Bold.ttf` | `ttf-hinted/RysanaMono-Bold.ttf` | `568c9691006d38589d3dd84a86c5c9224d3f00384f82506ff7374686d6e37e82` |
| `ttf/RysanaMono-Italic.ttf` | `ttf-hinted/RysanaMono-Italic.ttf` | `cde986b729d80e3e9606da616e1c6692b83e2b7a5547a9768dcf6083ca067def` |
| `ttf/RysanaMono-BoldItalic.ttf` | `ttf-hinted/RysanaMono-BoldItalic.ttf` | `b1283391f06c80e1f2a992b3ea9cf01ed8bb0f1297d95404a89ee0a239670650` |
| `web/RysanaMono-Variable-Core.woff2` | `web/RysanaMono-Variable-Core.woff2` | `3e668d98909374f10bcd811e68ec91b79d0f43aecde773c71dfbf0312ac93ecb` |
| `web/RysanaMono-VariableItalic-Core.woff2` | `web/RysanaMono-VariableItalic-Core.woff2` | `c249ddc0f3c710cad630db0ad2f018c47284a5d0a6cb62545e923c392979d695` |

## License

Rysana is licensed under the SIL Open Font License 1.1 with the reserved font
name `Rysana`; see [LICENSE.txt](./LICENSE.txt). The files here are unmodified
copies, so the reserved name applies and the license must travel with them.
