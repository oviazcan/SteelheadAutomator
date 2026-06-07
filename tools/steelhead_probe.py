#!/usr/bin/env python3
"""steelhead_probe.py — Lecturas NO DESTRUCTIVAS contra Steelhead /graphql.

Reutiliza la auth de Reportes SH (steelhead_auth.get_access_token) y los hashes
de persisted queries del extension (remote/config.json). SOLO operaciones de
lectura — nunca mutaciones. Sirve para validar shapes de respuesta sin tocar datos.

Uso:
  python3 tools/steelhead_probe.py GetPartNumber '{"id": 123}'
  python3 tools/steelhead_probe.py AllPartNumbers '{"first": 1, "offset": 0}'
  python3 tools/steelhead_probe.py CurrentUserDetails '{}'
"""
import json
import sys
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
REPORTES = pathlib.Path.home() / "Projects/Ecoplating/Reportes SH"
sys.path.insert(0, str(REPORTES / "scripts"))

# Reutiliza TODA la maquinaria de auth probada de Reportes SH (cookies + JWT +
# headers de browser + keep-alive + domainNanoId). Solo inyectamos el hash.
from steelhead_client import client_from_env  # noqa: E402

# Allowlist defensiva — el probe NUNCA muta. Solo operaciones de lectura.
READ_ONLY = {
    "GetPartNumber", "AllPartNumbers", "AllSpecs", "SpecFieldsAndOptions",
    "GetQuote_v8", "GetQuote_v71", "GetQuoteRelatedData", "CurrentUserDetails",
    "GetPartNumbersInputSchema", "AllLabels", "AllRackTypes", "AllProcesses",
    "PNGroupSelect", "SearchPartNumberPrices", "CustomerSearchByName",
    "GetDimension", "SearchLocationsOnPath",
}


def load_hashes():
    cfg = json.loads((REPO / "remote/config.json").read_text())
    h = cfg["steelhead"]["hashes"]
    return {**h.get("queries", {}), **h.get("mutations", {})}


def probe(operation, variables, domain=None):
    if operation not in READ_ONLY:
        raise SystemExit(f"BLOQUEADO: '{operation}' no está en la allowlist de lectura.")
    hashes = load_hashes()
    if operation not in hashes:
        raise SystemExit(f"Sin hash para '{operation}' en config.json.")

    client = client_from_env(domain=domain)
    payload = {
        "operationName": operation,
        "variables": variables,
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": hashes[operation]}},
    }
    url = client.graphql_url
    nano = getattr(client, "domain_nano_id", None)
    if nano:
        url = f"{url}{'&' if '?' in url else '?'}domainNanoId={nano}"
    headers = {"x-steelhead-idp-token": client.access_token} if client.access_token else None
    resp = client.session.post(url, json=payload, headers=headers, timeout=client.timeout)
    resp.raise_for_status()
    return resp.json()


if __name__ == "__main__":
    op = sys.argv[1] if len(sys.argv) > 1 else "CurrentUserDetails"
    vars_ = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    dom = sys.argv[3] if len(sys.argv) > 3 else None
    print(json.dumps(probe(op, vars_, dom), indent=2, ensure_ascii=False))
