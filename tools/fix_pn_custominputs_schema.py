#!/usr/bin/env python3
"""fix_pn_custominputs_schema.py — ONE-TIME: CargasHora→string + bump inputSchema.

ALCANCE (decidido con el usuario): solo los NP cuyo customInputs.DatosPlanificacion.CargasHora
es NUMÉRICO (no string). A esos: CargasHora→str + inputSchemaId→LATEST (3955). Los NP sin el
campo CargasHora se OMITEN (no se tocan).

Estrategia de seguridad: SavePartNumber es la única mutación con customInputs+inputSchemaId, y
hace REPLACE en varios arrays. Se reconstruye el input PRESERVANDO todo el estado del PN
(labelIds, dims, dimCustomValueIds, optInOuts, inventoryItemInput/unit-conversions, grupo,
geometría) leído de GetPartNumber, espejando el template probado `cleanupInput` del bulk-upload.
Los campos additive (predictivos, specs, params, locations) van [] (NO los borra; así lo
documenta el bulk-upload 1.5.17).

Modos:
  (default)      DRY-RUN: barre y reporta scope. NO escribe.
  --test PNID    Aplica a UN PN, re-lee y hace DIFF COMPLETO antes/después (verificación).
                 Guarda snapshots en /tmp para restaurar si algo se borrara.
  --apply        Aplica a TODOS los afectados (resume + log). Pide --yes para confirmar.
  --yes          Confirma el --apply (sin esto, --apply solo muestra qué haría).
  --limit N      Tope de PNs (apply/sweep).
  --schema ID    Override del inputSchemaId destino (default 3955).

Auth: steelhead_client de "Reportes SH" (igual que validate-hashes.py).
"""
from __future__ import annotations
import argparse
import json
import math
import sys
import time
from pathlib import Path


def cargas_to_str(v):
    """CargasHora → string ENTERA con floor (entero inferior inmediato).
    4.2→'4', 4.9→'4', 12.0→'12'. No infla eficiencias (nunca redondea hacia arriba)."""
    if isinstance(v, bool):
        return str(int(v))
    if isinstance(v, (int, float)):
        return str(int(math.floor(v)))
    return str(v)

REPO = Path(__file__).resolve().parent.parent
REPORTES = Path.home() / "Projects/Ecoplating/Reportes SH"
sys.path.insert(0, str(REPORTES / "scripts"))
from steelhead_client import client_from_env  # noqa: E402

LATEST_SCHEMA_DEFAULT = 3955
PAGE = 200
REQUEST_TIMEOUT = 30
RESUME_FILE = REPO / "tools" / ".fix-custominputs" / "processed.jsonl"


def load_hashes():
    cfg = json.loads((REPO / "remote/config.json").read_text())
    h = cfg["steelhead"]["hashes"]
    return {**h.get("queries", {}), **h.get("mutations", {})}


def gql(client, hashes, op, variables):
    url = client.graphql_url
    nano = getattr(client, "domain_nano_id", None)
    if nano:
        url = f"{url}{'&' if '?' in url else '?'}domainNanoId={nano}"
    headers = {"x-steelhead-idp-token": client.access_token} if client.access_token else None
    payload = {"operationName": op, "variables": variables,
               "extensions": {"persistedQuery": {"version": 1, "sha256Hash": hashes[op]}}}
    r = client.session.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    if data.get("errors"):
        raise RuntimeError(json.dumps(data["errors"], ensure_ascii=False)[:400])
    return data["data"]


def nodes(o, key):
    v = (o or {}).get(key)
    if isinstance(v, dict):
        return v.get("nodes") or []
    return []


def cargas_hora(ci):
    """(valor, es_string, existe) de DatosPlanificacion.CargasHora."""
    if not isinstance(ci, dict):
        return (None, True, False)
    dp = ci.get("DatosPlanificacion")
    if not isinstance(dp, dict) or "CargasHora" not in dp:
        return (None, True, False)
    return (dp["CargasHora"], isinstance(dp["CargasHora"], str), True)


def get_full_pn(client, hashes, pnid):
    d = gql(client, hashes, "GetPartNumber", {"partNumberId": pnid})
    return (d or {}).get("partNumberById")


def build_save_input(pn, target_schema):
    """Espeja el cleanupInput probado del bulk-upload: preserva TODO, cambia solo
    customInputs.DatosPlanificacion.CargasHora (→str) e inputSchemaId (→target)."""
    label_ids = [n["labelByLabelId"]["id"] for n in nodes(pn, "partNumberLabelsByPartNumberId")
                 if not n.get("archivedAt") and (n.get("labelByLabelId") or {}).get("id")]
    dims = []
    for d in nodes(pn, "partNumberDimensionsByPartNumberId"):
        if d.get("archivedAt"):
            continue
        gtdt = d.get("geometryTypeDimensionTypeId")
        unit = (d.get("unitByUnitId") or {}).get("id") or d.get("unitId")
        if gtdt is None or unit is None:
            continue
        dims.append({"geometryTypeDimensionTypeId": gtdt, "dimensionValue": d.get("dimensionValue"), "unitId": unit})
    dim_cv = [s["dimensionCustomValueId"] for s in nodes(pn, "acctPnDimensionValueSelectionsByPartNumberId")
              if s.get("dimensionCustomValueId")]
    opt_in_outs = [{"processNodeId": o["processNodeId"],
                    "processNodeOccurrence": o.get("processNodeOccurrence") or 1,
                    "cancelOthers": o.get("cancelOthers") or False}
                   for o in nodes(pn, "processNodePartNumberOptInoutsByPartNumberId")
                   if o.get("processNodeId") is not None]
    inv_input = None
    ex_inv = pn.get("inventoryItemByPartNumberId")
    if ex_inv:
        ucs = [{"unitId": (u.get("unitByUnitId") or {}).get("id"), "factor": u.get("factor")}
               for u in nodes(ex_inv, "inventoryItemUnitConversionsByInventoryItemId")
               if (u.get("unitByUnitId") or {}).get("id") is not None and u.get("factor") is not None]
        inv_input = {
            "materialId": (ex_inv.get("materialByMaterialId") or {}).get("id"),
            "purchasable": False,
            "sourceMaterialConversionType": ex_inv.get("sourceMaterialConversionType"),
            "providedMaterialConversionType": ex_inv.get("providedMaterialConversionType"),
            "defaultLeadTime": ex_inv.get("defaultLeadTime"),
            "unitConversions": ucs,
            "inventoryItemVendors": [],
        }
    ci = json.loads(json.dumps(pn.get("customInputs") or {}))  # deep copy
    ci["DatosPlanificacion"]["CargasHora"] = cargas_to_str(ci["DatosPlanificacion"]["CargasHora"])
    return {
        "id": pn["id"], "name": pn["name"],
        "customerId": (pn.get("customerByCustomerId") or {}).get("id") or pn.get("customerId"),
        "defaultProcessNodeId": (pn.get("processNodeByDefaultProcessNodeId") or {}).get("id") or pn.get("defaultProcessNodeId"),
        "inputSchemaId": target_schema,        # ← cambio
        "customInputs": ci,                     # ← cambio (CargasHora str)
        "geometryTypeId": (pn.get("geometryTypeByGeometryTypeId") or {}).get("id"),
        "userFileName": None,
        "inventoryItemInput": inv_input,
        "glAccountId": None, "taxCodeId": None, "certPdfTemplateId": None,
        "isOneOff": False, "isTemplatePartNumber": False, "isCoupon": False,
        "partNumberGroupId": (pn.get("partNumberGroupByPartNumberGroupId") or {}).get("id"),
        "descriptionMarkdown": pn.get("descriptionMarkdown") or "",
        "customerFacingNotes": pn.get("customerFacingNotes") or "",
        "labelIds": label_ids, "ownerIds": [], "defaults": [], "optInOuts": opt_in_outs,
        "inventoryPredictedUsages": [], "specsToApply": [], "paramsToApply": [],
        "partNumberDimensions": dims, "partNumberLocations": [], "dimensionCustomValueIds": dim_cv,
        "partNumberSpecsToArchive": [], "partNumberSpecsToUnarchive": [],
        "partNumberSpecFieldParamsToArchive": [], "partNumberSpecFieldParamsToUnarchive": [],
        "partNumberSpecClassificationsToUpdate": [],
        "partNumberSpecFieldParamUpdates": [], "specFieldParamUpdates": [],
    }


def save_pn(client, hashes, save_input):
    return gql(client, hashes, "SavePartNumber", {"input": [save_input]})


CRITICAL = {
    "partNumberLabelsByPartNumberId": lambda n: sorted(x["labelByLabelId"]["id"] for x in n if (x.get("labelByLabelId") or {}).get("id") and not x.get("archivedAt")),
    "partNumberSpecsByPartNumberId": lambda n: sorted((x.get("specBySpecId") or {}).get("id") for x in n if not x.get("archivedAt") and (x.get("specBySpecId") or {}).get("id")),
    "partNumberSpecFieldParamsByPartNumberId": lambda n: len([x for x in n if not x.get("archivedAt")]),
    "partNumberDimensionsByPartNumberId": lambda n: len([x for x in n if not x.get("archivedAt")]),
    "acctPnDimensionValueSelectionsByPartNumberId": lambda n: len(n),
    "processNodePartNumberOptInoutsByPartNumberId": lambda n: len(n),
}


def fingerprint(pn):
    fp = {}
    for k, fn in CRITICAL.items():
        try:
            fp[k] = fn(nodes(pn, k))
        except Exception:
            fp[k] = "ERR"
    inv = pn.get("inventoryItemByPartNumberId") or {}
    fp["unitConversions"] = sorted((str((u.get("unitByUnitId") or {}).get("id")), u.get("factor"))
                                   for u in nodes(inv, "inventoryItemUnitConversionsByInventoryItemId"))
    fp["geometryTypeId"] = (pn.get("geometryTypeByGeometryTypeId") or {}).get("id")
    fp["partNumberGroupId"] = (pn.get("partNumberGroupByPartNumberGroupId") or {}).get("id")
    fp["descriptionMarkdown"] = pn.get("descriptionMarkdown")
    fp["customerFacingNotes"] = pn.get("customerFacingNotes")
    # customInputs SIN CargasHora (lo demás debe quedar idéntico)
    ci = json.loads(json.dumps(pn.get("customInputs") or {}))
    try:
        ci.get("DatosPlanificacion", {}).pop("CargasHora", None)
    except Exception:
        pass
    fp["customInputs_sinCargasHora"] = json.dumps(ci, sort_keys=True, ensure_ascii=False)
    return fp


def diff_test(before, after, target_schema):
    print("\n" + "=" * 60)
    print("DIFF antes/después (lo ESPERADO: solo inputSchemaId + CargasHora)")
    print(f"  inputSchemaId:  {before.get('inputSchemaId')} → {after.get('inputSchemaId')}  (esperado → {target_schema})")
    b_ch = cargas_hora(before.get("customInputs"))
    a_ch = cargas_hora(after.get("customInputs"))
    expected_ch = cargas_to_str(b_ch[0])
    print(f"  CargasHora:     {b_ch[0]!r} ({type(b_ch[0]).__name__}) → {a_ch[0]!r} ({type(a_ch[0]).__name__})  (esperado floor → {expected_ch!r})")
    fb, fa = fingerprint(before), fingerprint(after)
    bad = []
    for k in fb:
        if fb[k] != fa[k]:
            bad.append((k, fb[k], fa[k]))
    print("\n  Campos preservados (deben ser IDÉNTICOS):")
    for k in fb:
        ok = "✓" if fb[k] == fa[k] else "✗ CAMBIÓ"
        val = fb[k] if not isinstance(fb[k], str) or len(str(fb[k])) < 40 else f"{str(fb[k])[:40]}…"
        print(f"    {ok}  {k}: {val if fb[k]==fa[k] else f'{fb[k]} → {fa[k]}'}")
    if bad:
        print("\n  ❌ SE DETECTARON CAMBIOS NO ESPERADOS — el SavePartNumber pisó datos. NO mass-aplicar.")
        return False
    if after.get("inputSchemaId") != target_schema:
        print("\n  ❌ inputSchemaId no quedó en el target.")
        return False
    if a_ch[0] != expected_ch or not isinstance(a_ch[0], str):
        print(f"\n  ❌ CargasHora no quedó como esperado ({expected_ch!r}).")
        return False
    print("\n  ✅ DIFF LIMPIO: solo cambiaron inputSchemaId y CargasHora. Reconstrucción SEGURA.")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--test", type=int, default=None, metavar="PNID")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--schema", type=int, default=LATEST_SCHEMA_DEFAULT)
    args = ap.parse_args()

    hashes = load_hashes()
    client = client_from_env(do_keep_alive=False)
    if not client.access_token:
        print("FATAL: sin access_token", file=sys.stderr)
        return 2
    target = args.schema
    print(f"Schema destino (LATEST): {target}")

    # ── TEST: 1 PN, snapshot + diff ──
    if args.test is not None:
        pnid = args.test
        print(f"\n[TEST] PN {pnid}: snapshot → SavePartNumber → re-lee → diff")
        before = get_full_pn(client, hashes, pnid)
        if not before:
            print("  No se encontró el PN."); return 1
        snap_dir = REPO / "tools" / ".fix-custominputs"
        snap_dir.mkdir(parents=True, exist_ok=True)
        (snap_dir / f"before_{pnid}.json").write_text(json.dumps(before, ensure_ascii=False, indent=1))
        val, is_str, exists = cargas_hora(before.get("customInputs"))
        if not exists:
            print("  Este PN no tiene CargasHora — elige otro para el test."); return 1
        print(f"  CargasHora actual: {val!r} ({type(val).__name__}); schema {before.get('inputSchemaId')}")
        save_input = build_save_input(before, target)
        print("  Enviando SavePartNumber…")
        try:
            save_pn(client, hashes, save_input)
        except Exception as e:
            print(f"  ❌ SavePartNumber falló: {e}"); return 1
        after = get_full_pn(client, hashes, pnid)
        (snap_dir / f"after_{pnid}.json").write_text(json.dumps(after, ensure_ascii=False, indent=1))
        ok = diff_test(before, after, target)
        print(f"\n  Snapshots: {snap_dir}/before_{pnid}.json , after_{pnid}.json")
        return 0 if ok else 1

    # ── Barrido (scope / apply) ──
    print("Barriendo AllPartNumbers (incl. archivados)…")
    offset, affected, total = 0, [], 0
    while True:
        d = gql(client, hashes, "AllPartNumbers", {"first": PAGE, "offset": offset, "searchQuery": "", "includeArchived": "YES"})
        block = d.get("allPartNumbers") or d.get("pagedData") or {}
        ns = block.get("nodes") or []
        if not ns:
            break
        total += len(ns)
        for n in ns:
            val, is_str, exists = cargas_hora(n.get("customInputs"))
            if exists and not is_str:   # CargasHora numérico → afectado
                affected.append({"id": n["id"], "name": n.get("name"), "schema": n.get("inputSchemaId"), "cargas": val})
        offset += len(ns)
        sys.stderr.write(f"\r  barridos {total}, afectados {len(affected)}…"); sys.stderr.flush()
        if args.limit and total >= args.limit:
            break
        if len(ns) < PAGE:
            break
        time.sleep(0.05)
    sys.stderr.write("\n")
    print(f"\nTotal barridos: {total} · Afectados (CargasHora numérico): {len(affected)}")

    if not args.apply:
        print("\n(DRY-RUN. Usa --test PNID para verificar 1 PN; luego --apply --yes para todos.)")
        return 0

    if not args.yes:
        print(f"\n[--apply SIN --yes] Aplicaría a {len(affected)} PNs. Agrega --yes para ejecutar de verdad.")
        return 0

    # ── APPLY ──
    RESUME_FILE.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if RESUME_FILE.exists():
        for line in RESUME_FILE.read_text().splitlines():
            try:
                done.add(json.loads(line)["id"])
            except Exception:
                pass
    print(f"Ya procesados (resume): {len(done)}")
    ok_n, err_n = 0, 0
    with RESUME_FILE.open("a") as rf:
        for i, a in enumerate(affected, 1):
            if a["id"] in done:
                continue
            try:
                full = get_full_pn(client, hashes, a["id"])
                v, s, ex = cargas_hora(full.get("customInputs"))
                if not ex or s:   # ya corregido / sin campo
                    rf.write(json.dumps({"id": a["id"], "skip": "no-op"}) + "\n"); rf.flush()
                    continue
                save_pn(client, hashes, build_save_input(full, target))
                ok_n += 1
                rf.write(json.dumps({"id": a["id"], "ok": True}) + "\n"); rf.flush()
            except Exception as e:
                err_n += 1
                rf.write(json.dumps({"id": a["id"], "error": str(e)[:200]}) + "\n"); rf.flush()
            if i % 50 == 0:
                sys.stderr.write(f"\r  {i}/{len(affected)} (ok {ok_n}, err {err_n})…"); sys.stderr.flush()
            time.sleep(0.03)
    print(f"\nAPPLY terminado: {ok_n} OK, {err_n} errores. Log: {RESUME_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
