#!/usr/bin/env python3
"""Valida la vigencia de los persisted-query hashes que usa la extensión.

Lee `remote/config.json`, dispara un POST mínimo a `/graphql` por cada hash
y clasifica cada operación como:

  - ok      : el server reconoce el hash (responde data o error de schema/
              args; ambos prueban que el hash existe en el registry).
  - stale   : el server respondió "Must provide a query string" o
              "PersistedQueryNotFound" — el hash fue rotado.
  - unknown : HTTP/respuesta inesperada (auth roto, red caída, etc.).

Exit code:
  0 → todos los hashes vigentes
  1 → hay stale (gatilla notificaciones desde el cron)
  2 → error fatal (auth, config faltante)

Usa el `SteelheadClient` del proyecto Reportes SH (`~/Projects/Ecoplating/
Reportes SH/scripts/`) para reusar auth (refresh_token + JWT + cookies +
domainNanoId). No duplica OAuth aquí.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path

# Fuentes de hashes ADEMÁS de la extensión (Reportes SH + PowerTools). hash_sources
# vive en tools/ (mismo dir que este script) → lo aseguramos en sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hash_sources import load_external_sources, build_validation_items  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "remote" / "config.json"
OUT_DIR = REPO_ROOT / "tools" / ".hash-validation"
WHITELIST_PATH = REPO_ROOT / "tools" / "hash-validator-whitelist.json"
MASKED_OPS_PATH = REPO_ROOT / "tools" / "hash-autopilot" / "masked-ops.json"
REPORTES_SH = Path("/Users/oviazcan/Projects/Ecoplating/Reportes SH")
REPORTES_SH_SCRIPTS = REPORTES_SH / "scripts"

REQUEST_DELAY_S = 0.1
REQUEST_TIMEOUT_S = 15


def _import_client():
    if not REPORTES_SH_SCRIPTS.exists():
        print(f"FATAL: no existe {REPORTES_SH_SCRIPTS}", file=sys.stderr)
        sys.exit(2)
    sys.path.insert(0, str(REPORTES_SH_SCRIPTS))
    try:
        from steelhead_client import client_from_env  # type: ignore
    except ImportError as e:
        print(f"FATAL: no pude importar steelhead_client: {e}", file=sys.stderr)
        sys.exit(2)
    return client_from_env


def _probe(session, url: str, headers: dict, op_name: str, sha256: str) -> tuple[str, str]:
    """Devuelve (clase, motivo). Clase ∈ {ok, stale, unknown, auth}.

    Criterio de clasificación:
      - "Must provide a query string" / "PersistedQueryNotFound" → STALE
      - HTTP 401/403 → AUTH
      - **cualquier otra respuesta** (200/400/500/timeout) → OK
        Razonamiento: si el server respondió con error de schema/args (400),
        error interno (500 con `errors`), o timeó intentando ejecutar la
        query con variables vacías → el hash SÍ existe en el registry
        server-side. Solo "Must provide a query string" indica rotación.
    """
    payload = {
        "operationName": op_name,
        "variables": {},
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": sha256}},
    }
    try:
        r = session.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_S)
    except Exception as e:
        name = type(e).__name__
        # Timeout = server intentó ejecutar el query pesada → hash existe.
        if "Timeout" in name:
            return ("ok", f"timeout (hash existe, query pesada con vars vacías)")
        return ("unknown", f"red: {name}: {e}")

    status = r.status_code
    text = r.text or ""

    if status in (401, 403):
        return ("auth", f"HTTP {status} — auth roto")
    if "Must provide a query string" in text:
        return ("stale", "Must provide a query string")
    if "PersistedQueryNotFound" in text or "PERSISTED_QUERY_NOT_FOUND" in text:
        return ("stale", "PersistedQueryNotFound")
    return ("ok", f"HTTP {status}")


def main() -> int:
    if not CONFIG_PATH.exists():
        print(f"FATAL: no existe {CONFIG_PATH}", file=sys.stderr)
        return 2

    client_from_env = _import_client()
    try:
        client = client_from_env(do_keep_alive=False)
    except Exception as e:
        print(f"FATAL: client_from_env falló: {e}", file=sys.stderr)
        return 2

    if not client.access_token:
        print("FATAL: access_token vacío en cliente", file=sys.stderr)
        return 2

    url = client.graphql_url
    if client.domain_nano_id:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}domainNanoId={client.domain_nano_id}"
    headers = {"x-steelhead-idp-token": client.access_token}

    config = json.loads(CONFIG_PATH.read_text())
    hashes_block = config.get("steelhead", {}).get("hashes", {})
    queries = hashes_block.get("queries", {})
    mutations = hashes_block.get("mutations", {})

    # Ops ENMASCARADAS (session-sensitive) desde la FUENTE ÚNICA DE VERDAD:
    # tools/hash-autopilot/masked-ops.json. Este cliente externo (idp-token) no las
    # puede validar de forma confiable (Steelhead responde "Must provide a query
    # string" a clientes que no son el Apollo del navegador, a veces intermitente) →
    # se reportan como 'skipped', nunca STALE. El hash-autopilot headless las
    # RECAPTURA SIEMPRE (misma lista → skipeamos EXACTAMENTE lo que el motor cubre,
    # sin huecos). Fallback al viejo hash-validator-whitelist.json solo si masked-ops
    # no existe (defensa transicional).
    whitelist_ops = set()
    if MASKED_OPS_PATH.exists():
        mo = json.loads(MASKED_OPS_PATH.read_text())
        whitelist_ops = set(mo.get("queries", [])) | set(mo.get("mutations", []))
    elif WHITELIST_PATH.exists():
        wl = json.loads(WHITELIST_PATH.read_text())
        whitelist_ops = {entry["operation"] for entry in wl.get("falseStale", [])}

    # Unir las 3 fuentes que consumen la API de Steelhead con hashes propios:
    #   extension (config.json) + reportes-sh (steelhead_client.py) + powertools (sync/*.py).
    # Dedup por (op, hash): cada par único se prueba UNA vez; las fuentes que lo usan
    # se listan en entry["sources"]. Así un hash que solo usa Reportes SH/PowerTools se
    # detecta igual (incidente 2026-07-20: GenerateDuckDb rotó y RSH quedó con el muerto).
    external = load_external_sources()
    ext_src_counts = {src: len(ops) for src, ops in external.items()}
    items = build_validation_items(queries, mutations, external)  # [{kind,operation,hash,sources}]

    total = len(items)
    ok: list[dict] = []
    stale: list[dict] = []
    skipped: list[dict] = []
    unknown: list[dict] = []
    auth_errors: list[dict] = []

    ext_desc = ", ".join(f"{src}={n}" for src, n in ext_src_counts.items()) or "ninguna externa"
    print(f"Validando {total} hashes únicos por (op,hash). "
          f"Fuentes: extension={len(queries) + len(mutations)}, {ext_desc}")
    if whitelist_ops:
        print(f"Whitelist activa: {len(whitelist_ops)} operación(es) (falsos positivos conocidos)")
    started = time.time()
    for idx, item in enumerate(items, 1):
        kind, op, h, sources = item["kind"], item["operation"], item["hash"], item["sources"]
        src_tag = ",".join(sources)
        klass, reason = _probe(client.session, url, headers, op, h)
        entry = {"kind": kind, "operation": op, "hash": h, "sources": sources, "reason": reason}
        # Whitelist: si un op está marcado como falso-positivo-conocido y el
        # validador lo reporta stale, lo bajamos a 'skipped' (no alerta).
        if klass == "stale" and op in whitelist_ops:
            skipped.append(entry)
            print(f"  [SKIP] {kind} {op}: stale del validador, pero whitelist (verificar con hash-scanner)")
            time.sleep(REQUEST_DELAY_S)
            continue
        if klass == "ok":
            ok.append(entry)
        elif klass == "stale":
            stale.append(entry)
            print(f"  [STALE] {kind} {op} [{src_tag}]: {reason}")
        elif klass == "auth":
            auth_errors.append(entry)
            print(f"  [AUTH] {op}: {reason}")
            if len(auth_errors) >= 3:
                print("FATAL: 3+ auth errors consecutivos, abortando.", file=sys.stderr)
                return 2
        else:
            unknown.append(entry)
            print(f"  [UNKNOWN] {kind} {op}: {reason}")
        if idx % 25 == 0:
            print(f"  ...{idx}/{total}")
        time.sleep(REQUEST_DELAY_S)

    elapsed = time.time() - started
    today = datetime.now().strftime("%Y-%m-%d")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{today}.json"
    result = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "config_version": config.get("version"),
        "elapsed_s": round(elapsed, 1),
        "totals": {
            "checked": total,
            "ok": len(ok),
            "stale": len(stale),
            "skipped": len(skipped),
            "unknown": len(unknown),
            "auth_errors": len(auth_errors),
        },
        "stale": stale,
        "skipped": skipped,
        "unknown": unknown,
        "auth_errors": auth_errors,
        "ok_count": len(ok),
    }
    out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))

    print()
    print("─" * 60)
    print(f"Resultado: {len(ok)} ok / {len(stale)} stale / {len(skipped)} skipped / {len(unknown)} unknown / {len(auth_errors)} auth")
    print(f"Elapsed: {elapsed:.1f}s")
    print(f"Output: {out_path}")
    if stale:
        print()
        print("STALE:")
        for s in stale:
            print(f"  - {s['kind']} {s['operation']} [{','.join(s.get('sources', []))}]")
        return 1
    if auth_errors:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
