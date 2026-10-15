#!/usr/bin/env python3
"""Regenera el subconjunto local de Material Symbols y su manifiesto.

Por que existe este script
--------------------------
Los iconos de Material Symbols se escriben como TEXTO y la fuente los convierte
en dibujo mediante una ligadura. Si la fuente no carga, o si el icono no esta
en el subconjunto, el navegador pinta el nombre crudo: `screenshot_monitor`
desbordando su recuadro en mitad de la pantalla de respaldo de la llave.

Ese fallo ya ocurrio dos veces:

  1. La fuente venia del CDN de Google y la app sin señal mostraba los 241 usos
     como palabras. Se arreglo empaquetando un subconjunto local.
  2. El subconjunto se genero UNA vez y nadie lo volvio a tocar. Los iconos
     añadidos despues no estaban dentro, y volvian a salir como texto. Doce
     iconos rotos el 2026-09-05, cinco de ellos recien añadidos.

La causa comun es la misma: el subconjunto se construyo a mano y se quedo atras.
Este script lo deriva del codigo, y `iconSubset.test.ts` falla si alguien añade
un icono sin volver a ejecutarlo.

Uso
---
    pip install fonttools brotli
    python scripts/build-icon-subset.py

Descarga la fuente variable completa (~10 MB) y escribe:
    public/fonts/material-symbols-subset.woff2
    public/fonts/ICONOS.txt   (manifiesto que lee el test)

Detalles que costaron encontrar
-------------------------------
* El nombre del icono es la SECUENCIA de caracteres de la ligadura, no el nombre
  del glifo resultante. Material Symbols tiene alias — `location_on`, `email`,
  `people` — cuya ligadura apunta a un glifo con otro nombre. Podar por nombre
  de glifo los descarta en silencio.
* La fuente mapea 'A' y 'a' al MISMO glifo. Construir el mapa glifo→caracter sin
  preferir la minuscula devuelve los nombres en mayusculas y no casa ninguno.
* Recortar por `text=` no sirve: el cierre de ligaduras arrastra los 4277 iconos
  de la fuente y el resultado pesa 3 MB. Hay que podar la tabla GSUB primero.
* Se conservan las variantes `.fill` y los ejes variables: BottomNav usa el eje
  FILL para marcar la pestaña activa, asi que aplanarlo romperia ese estado.
"""

import os
import re
import sys
import urllib.request

FONT_URL = (
    "https://raw.githubusercontent.com/google/material-design-icons/master/"
    "variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf"
)
OUT_FONT = "public/fonts/material-symbols-subset.woff2"
OUT_MANIFEST = "public/fonts/ICONOS.txt"
# Fuera de public/: es material del test, no del APK.
OUT_ALL_NAMES = "scripts/material-symbols-names.txt"


# Cualquier literal en minusculas y snake_case es CANDIDATO a icono. Se
# empaqueta solo si existe de verdad en Material Symbols, asi que sobrar no
# cuesta casi nada y faltar rompe la pantalla.
#
# Se intento primero reconocer las formas concretas en que el codigo escribe un
# icono — literal dentro del span, prop `icon=`, campo `icon:` — y fue un error:
# BottomNav los pasa como argumentos de una funcion, `btn('home', 'home', ...)`,
# que no encajaba en ninguna. El resultado fue empaquetar de menos y dejar la
# barra de navegacion mostrando HOME y EXPLORE como texto gigante. Adivinar la
# forma sintactica es fragil; intersecar con la fuente real no lo es.
CANDIDATE = re.compile(r"['\"`]([a-z][a-z0-9_]{2,40})['\"`]")
# Los iconos escritos como texto JSX no llevan comillas:
#     <span className="material-symbols-outlined">arrow_back</span>
# asi que el patron de literales no los ve. Se recogen aparte.
BARE = re.compile(r"material-symbols-outlined[^>]*>\s*([a-z][a-z0-9_]{2,40})\s*<")


def icon_candidates(root="src"):
    """Todo lo que PODRIA ser un nombre de icono; la fuente decide cual lo es."""
    found = set()
    for dirpath, _, files in os.walk(root):
        if "__tests__" in dirpath:
            continue
        for name in files:
            if not name.endswith((".tsx", ".ts")):
                continue
            src = open(os.path.join(dirpath, name), encoding="utf-8", errors="ignore").read()
            found.update(m.group(1) for m in CANDIDATE.finditer(src))
            found.update(m.group(1) for m in BARE.finditer(src))
    return found


def glyph_to_char(font):
    """Mapa glifo→caracter, prefiriendo minusculas (ver encabezado)."""
    mapping = {}
    for cp, glyph in font.getBestCmap().items():
        ch = chr(cp)
        if glyph not in mapping or (ch.islower() and not mapping[glyph].islower()):
            mapping[glyph] = ch
    return mapping


def ligature_subtables(lookup):
    for st in lookup.SubTable:
        yield st.ExtSubTable if st.__class__.__name__ == "ExtensionSubst" else st


def main():
    from fontTools import subset
    from fontTools.ttLib import TTFont

    wanted = icon_candidates()
    print(f"literales candidatos en el codigo: {len(wanted)}")

    cache = os.path.join(os.environ.get("TEMP", "/tmp"), "material-symbols-full.ttf")
    if not os.path.exists(cache):
        print("descargando la fuente completa…")
        urllib.request.urlretrieve(FONT_URL, cache)
    font = TTFont(cache)

    g2c = glyph_to_char(font)
    found, keep = set(), set()
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for st in ligature_subtables(lookup):
            if st.__class__.__name__ != "LigatureSubst":
                continue
            for first, ligs in list(st.ligatures.items()):
                survivors = []
                for lig in ligs:
                    name = "".join(g2c.get(g, "?") for g in [first] + list(lig.Component))
                    if name in wanted:
                        survivors.append(lig)
                        found.add(name)
                        keep.add(lig.LigGlyph)
                if survivors:
                    st.ligatures[first] = survivors
                else:
                    del st.ligatures[first]

    # Los candidatos que resultan no ser iconos (palabras normales del codigo)
    # se descartan solos al no existir en la fuente. Eso no es un error: la
    # regla es que empaquetar de mas es barato y empaquetar de menos rompe la
    # pantalla.

    order = set(font.getGlyphOrder())
    fills = {f"{g}.fill" for g in keep if f"{g}.fill" in order}

    opts = subset.Options()
    opts.layout_features = ["liga", "calt", "ccmp", "rlig"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    sub = subset.Subsetter(options=opts)
    sub.populate(text="".join(sorted(set("".join(found)))), glyphs=sorted(keep | fills))
    sub.subset(font)
    font.flavor = "woff2"
    font.save(OUT_FONT)

    with open(OUT_MANIFEST, "w", encoding="utf-8") as fh:
        fh.write(
            "# Generado por scripts/build-icon-subset.py — NO editar a mano.\n"
            "# Los iconos que contiene material-symbols-subset.woff2.\n"
            "# iconSubset.test.ts falla si el codigo usa uno que no este aqui.\n"
        )
        fh.write("\n".join(sorted(found)) + "\n")

    # Lista completa de nombres validos de Material Symbols. La usa el test para
    # distinguir un icono de una palabra cualquiera, y con ella detecta el caso
    # que se escapo: `btn('home', 'home', ...)`, un icono pasado como argumento.
    # Vive en scripts/ y NO en public/, para que no viaje dentro del APK.
    all_names = set()
    full = TTFont(cache)
    fg2c = glyph_to_char(full)
    for lookup in full["GSUB"].table.LookupList.Lookup:
        for st in ligature_subtables(lookup):
            if st.__class__.__name__ != "LigatureSubst":
                continue
            for first, ligs in st.ligatures.items():
                for lig in ligs:
                    all_names.add("".join(fg2c.get(g, "?") for g in [first] + list(lig.Component)))
    with open(OUT_ALL_NAMES, "w", encoding="utf-8") as fh:
        fh.write(chr(10).join(sorted(all_names)) + chr(10))

    print(f"iconos empaquetados: {len(found)}  ({os.path.getsize(OUT_FONT)} bytes)")
    print(f"nombres validos de Material Symbols: {len(all_names)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
