#!/usr/bin/env python3
"""sandbox_pn.py — Escrituras CONTROLADAS sobre un PN de pruebas ("Pruebas Claude").

Autorizado por el usuario para validar buildPreserveInput (F4) contra SH real sin tocar
PNs productivos. Reutiliza la auth de Reportes SH + los hashes de config.json.

GUARDA: solo opera sobre PNs cuyo name empiece con 'Pruebas Claude' (verificación de
nombre antes de cualquier SavePartNumber que NO sea la creación inicial).

Uso:
  python3 tools/sandbox_pn.py create                      # crea "Pruebas Claude (refactor F4)"
  python3 tools/sandbox_pn.py get <id>                    # GetPartNumber (shape)
  python3 tools/sandbox_pn.py save <id> '<input-json>'    # SavePartNumber con guarda de nombre
  python3 tools/sandbox_pn.py archive <id>                # archiva el sandbox al terminar
"""
import json
import sys
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
REPORTES = pathlib.Path.home() / "Projects/Ecoplating/Reportes SH"
sys.path.insert(0, str(REPORTES / "scripts"))
from steelhead_client import client_from_env  # noqa: E402

GRAPHQL_URL = "https://app.gosteelhead.com/graphql"
SANDBOX_NAME = "Pruebas Claude (refactor F4)"
SANDBOX_PREFIX = "Pruebas Claude"
CUSTOMER_ID = 176980          # cliente real existente (validado vía probe)
INPUT_SCHEMA_ID = 3932        # DOMAIN.inputSchemaId_PN (TLC)


def _hashes():
    cfg = json.loads((REPO / "remote/config.json").read_text())
    h = cfg["steelhead"]["hashes"]
    return {**h.get("queries", {}), **h.get("mutations", {})}


def _call(client, operation, variables):
    payload = {
        "operationName": operation,
        "variables": variables,
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": _hashes()[operation]}},
    }
    url = client.graphql_url
    nano = getattr(client, "domain_nano_id", None)
    if nano:
        url = f"{url}{'&' if '?' in url else '?'}domainNanoId={nano}"
    headers = {"x-steelhead-idp-token": client.access_token} if client.access_token else None
    r = client.session.post(url, json=payload, headers=headers, timeout=client.timeout)
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise SystemExit("GraphQL errors: " + json.dumps(body["errors"])[:800])
    return body["data"]


def min_input(name):
    return {
        "id": None, "name": name, "customerId": CUSTOMER_ID, "defaultProcessNodeId": None,
        "inputSchemaId": INPUT_SCHEMA_ID, "customInputs": {},
        "geometryTypeId": None, "userFileName": None, "inventoryItemInput": None,
        "glAccountId": None, "taxCodeId": None, "certPdfTemplateId": None,
        "isOneOff": False, "isTemplatePartNumber": False, "isCoupon": False, "partNumberGroupId": None,
        "descriptionMarkdown": "", "customerFacingNotes": "",
        "labelIds": [], "ownerIds": [], "defaults": [], "optInOuts": [],
        "inventoryPredictedUsages": [], "specsToApply": [], "paramsToApply": [],
        "partNumberDimensions": [], "partNumberLocations": [], "dimensionCustomValueIds": [],
        "partNumberSpecsToArchive": [], "partNumberSpecsToUnarchive": [],
        "partNumberSpecFieldParamsToArchive": [], "partNumberSpecFieldParamsToUnarchive": [],
        "partNumberSpecClassificationsToUpdate": [],
        "partNumberSpecFieldParamUpdates": [], "specFieldParamUpdates": [],
    }


def create(client):
    data = _call(client, "SavePartNumber", {"input": [min_input(SANDBOX_NAME)]})
    pn = (data.get("savePartNumbers") or [{}])[0]
    return pn.get("id")


def get(client, pid):
    return _call(client, "GetPartNumber", {"partNumberId": int(pid), "usagesLimit": 1, "usagesOffset": 0})


def _assert_sandbox(client, pid):
    d = get(client, pid)
    name = (d.get("partNumberById") or {}).get("name", "")
    if not name.startswith(SANDBOX_PREFIX):
        raise SystemExit(f"GUARDA: PN {pid} se llama '{name}', NO empieza con '{SANDBOX_PREFIX}'. Abortado.")
    return d


def save(client, pid, input_obj):
    _assert_sandbox(client, pid)  # nunca escribir sobre un PN que no sea el sandbox
    input_obj = dict(input_obj)
    input_obj["id"] = int(pid)
    return _call(client, "SavePartNumber", {"input": [input_obj]})


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "get"
    client = client_from_env()
    if cmd == "create":
        print("id creado:", create(client))
    elif cmd == "get":
        print(json.dumps(get(client, sys.argv[2]), indent=2, ensure_ascii=False)[:4000])
    elif cmd == "save":
        print(json.dumps(save(client, sys.argv[2], json.loads(sys.argv[3])), indent=2, ensure_ascii=False)[:2000])
    else:
        raise SystemExit(f"comando desconocido: {cmd}")
