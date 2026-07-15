#!/usr/bin/env python3
"""Genera el bloque enriquecido de hashes rotados para las notificaciones.

Para cada operación stale que reporta `validate-hashes.py`, resuelve:
  - **Applets que truenan**: escanea `remote/scripts/*.js` buscando la op
    citada entre comillas (como se usa en `query('Op', …)` / `getHash('Op')`),
    match preciso que evita falsos matches en comentarios/substrings.
    Complementa con `knownOperations.usedBy` de `config.json`.
  - **Descripción**: de `config.knownOperations[op].description`.
  - **Whitelist**: si la op está en `hash-validator-whitelist.json` es un
    falso-positivo probable del validador (cliente externo). El hash es
    válido en el navegador; NO tocar `config.json` sin verificar el scan.

Uso:
  hash-stale-report.py <result.json> [--format md|plain]

Salida: bloque de texto listo para pegar en el issue / email / bitácora.
"""
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONFIG = REPO / "remote" / "config.json"
WHITELIST = REPO / "tools" / "hash-validator-whitelist.json"
SCRIPTS = REPO / "remote" / "scripts"


def applets_for(op: str) -> list[str]:
    """Applets cuyo .js referencia la op citada entre comillas."""
    pat = re.compile(r"['\"]" + re.escape(op) + r"['\"]")
    hits = []
    if not SCRIPTS.exists():
        return hits
    for f in sorted(SCRIPTS.glob("*.js")):
        try:
            if pat.search(f.read_text(errors="ignore")):
                hits.append(f.stem)
        except Exception:
            pass
    return hits


def main() -> int:
    if len(sys.argv) < 2:
        print("uso: hash-stale-report.py <result.json> [--format md|plain]", file=sys.stderr)
        return 2
    result = Path(sys.argv[1])
    fmt = "md"
    if "--format" in sys.argv:
        fmt = sys.argv[sys.argv.index("--format") + 1]

    d = json.loads(result.read_text())
    cfg = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    known = cfg.get("knownOperations", {})
    wl_ops = set()
    if WHITELIST.exists():
        wl_ops = {e["operation"] for e in json.loads(WHITELIST.read_text()).get("falseStale", [])}

    stale = d.get("stale", [])
    if not stale:
        print("(sin operaciones rotadas)")
        return 0

    out: list[str] = []
    for s in stale:
        op = s["operation"]
        kind = s.get("kind", "query")
        h = s.get("hash", "")
        applets = applets_for(op)
        ku = known.get(op, {})
        usedby = ku.get("usedBy", "")
        desc = (ku.get("description", "") or "").strip()
        if len(desc) > 140:
            desc = desc[:140] + "…"
        wl = op in wl_ops
        applets_str = ", ".join(applets) if applets else "(ningún applet referencia la op directamente — ¿op nativa/huérfana?)"

        if fmt == "md":
            out.append(f"#### {'🟡' if wl else '⚠️'} `{kind} {op}` · hash `{h[:12]}…`")
            out.append(f"- **Applets que truenan:** {applets_str}")
            if usedby:
                out.append(f"- **usedBy (config):** {usedby}")
            if desc:
                out.append(f"- **Qué hace:** {desc}")
            if wl:
                out.append("- 🟡 **En whitelist = falso-positivo probable.** El hash es válido en el navegador; el validador (cliente externo) recibe 'Must provide' aunque la op funcione in-page. Verifica en el scan antes de tocar `config.json`.")
            out.append("")
        else:  # plain (email)
            tag = "  [FALSO POSITIVO probable — en whitelist]" if wl else ""
            out.append(f"- {kind} {op} (hash {h[:12]}…){tag}")
            out.append(f"    Applets que truenan: {applets_str}")
            if usedby:
                out.append(f"    usedBy: {usedby}")
            if desc:
                out.append(f"    Qué hace: {desc}")

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
