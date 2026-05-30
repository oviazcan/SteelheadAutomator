#!/usr/bin/env python3
"""Archivar lotes activos del inventory type "Números de Parte" (reinicio).

Dos fases:
  - DRY (default): lee la lista de lotes activos del snapshot DuckDB de
    Reportes SH (instantáneo) y guarda un JSON de candidatos. NO archiva.
  - EXEC (--exec): archiva esos lotes vía API (UpdateInventoryBatchesChecked,
    chunks de 20, backoff para 429). MUTACIÓN.

Filtro = mismo que la API con archivedOption:'NO', notCompleted:false:
  inventory_batch.archived_at IS NULL, items del tipo 'Números de Parte',
  sin filtrar completados ni cantidad.

Uso:
    python3 tools/archive_pn_batches.py --domain tlc           # dry-run
    python3 tools/archive_pn_batches.py --domain tlc --exec     # archiva
    python3 tools/archive_pn_batches.py --domain tlc --exec --from-json <ruta>
"""
import argparse
import glob
import json
import os
import random
import sys
import time
from pathlib import Path

REPO_RSH = Path("/Users/oviazcan/Projects/Ecoplating/Reportes SH")
TYPE_NAME = "Números de Parte"
ARCHIVE_HASH = "4981b6dcbb240d5f9ab763a3b0cedde1fc5bd22c4735e8a33fc717b1ef5e7ea0"

CANDIDATE_SQL = """
SELECT b.id AS batch_id, b.inventory_item_id AS item_id, i.name AS item_name,
       (b.completed_at IS NOT NULL) AS completed
FROM inventory_batch b
JOIN inventory_item i ON i.id = b.inventory_item_id
JOIN inventory_type t ON t.id = i.inventory_type_id
WHERE t.name = ? AND b.archived_at IS NULL
ORDER BY b.id
"""


def find_db(domain):
    d = REPO_RSH / "steelhead_snapshot" / domain / "duckdb"
    cands = sorted(glob.glob(str(d / "*.duckdb")), key=os.path.getmtime, reverse=True)
    if not cands:
        sys.exit(f"ERROR: no hay .duckdb en {d}")
    return cands[0]


def get_candidates(domain):
    import duckdb
    db = find_db(domain)
    con = duckdb.connect(db, read_only=True)
    rows = con.execute(CANDIDATE_SQL, [TYPE_NAME]).fetchall()
    con.close()
    return db, [
        {"batchId": r[0], "itemId": r[1], "itemName": r[2], "completed": bool(r[3])}
        for r in rows
    ]


def archive_via_api(domain, batch_ids, chunk=20):
    sys.path.insert(0, str(REPO_RSH / "scripts"))
    import steelhead_client as sc
    from steelhead_client import client_from_env
    sc.PERSISTED_QUERIES["UpdateInventoryBatchesChecked"] = ARCHIVE_HASH
    client = client_from_env(domain=domain)

    archived, errors = 0, []
    for i in range(0, len(batch_ids), chunk):
        part = batch_ids[i:i + chunk]
        ok = False
        delay = 1.0
        for attempt in range(7):
            try:
                client.call("UpdateInventoryBatchesChecked",
                            {"batches": [{"id": bid, "archive": True} for bid in part]})
                ok = True
                break
            except Exception as e:
                if "429" in str(e) and attempt < 6:
                    time.sleep(delay + random.uniform(0, 0.5))
                    delay = min(delay * 2, 30)
                    continue
                errors.extend({"id": bid, "error": str(e)[:200]} for bid in part)
                break
        if ok:
            archived += len(part)
        print(f"  archivados {archived}/{len(batch_ids)}", flush=True)
        time.sleep(0.15)
    return archived, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="tlc")
    ap.add_argument("--exec", dest="do_exec", action="store_true")
    ap.add_argument("--from-json", default=None, help="JSON de candidatos (en --exec)")
    ap.add_argument("--chunk", type=int, default=20)
    args = ap.parse_args()

    stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
    downloads = Path.home() / "Downloads"

    # Cargar candidatos
    if args.from_json:
        data = json.loads(Path(args.from_json).read_text())
        cands = data["batchDetail"] if "batchDetail" in data else data
        src = args.from_json
    else:
        src, cands = get_candidates(args.domain)

    batch_ids = [c["batchId"] for c in cands]
    completados = sum(1 for c in cands if c.get("completed"))
    items = len({c["itemId"] for c in cands})
    print(f"=== Archivar lotes PN — {args.domain} — {'EXEC' if args.do_exec else 'DRY-RUN'} ===")
    print(f"Fuente: {src}")
    print(f"Lotes activos: {len(batch_ids)} (completados: {completados}) en {items} items")

    if not args.do_exec:
        out = downloads / f"archive-pn-batches_DRYRUN_{args.domain}_{stamp}.json"
        out.write_text(json.dumps({
            "mode": "dry-run", "domain": args.domain, "stamp": stamp, "source": str(src),
            "totalBatches": len(batch_ids), "completed": completados, "items": items,
            "batchDetail": cands,
        }, indent=2, ensure_ascii=False))
        print(f"JSON candidatos: {out}")
        print("DRY-RUN: no se archivó nada. Para ejecutar agrega --exec.")
        return

    # EXEC
    print(f"Archivando {len(batch_ids)} lotes (chunks de {args.chunk})...", flush=True)
    archived, errors = archive_via_api(args.domain, batch_ids, args.chunk)
    print(f"\n=== RESULTADO ===\nArchivados: {archived}/{len(batch_ids)}\nErrores: {len(errors)}")
    out = downloads / f"archive-pn-batches_EXEC_{args.domain}_{stamp}.json"
    out.write_text(json.dumps({
        "mode": "exec", "domain": args.domain, "stamp": stamp,
        "totalBatches": len(batch_ids), "archived": archived, "errors": errors,
        "batchDetail": cands,
    }, indent=2, ensure_ascii=False))
    print(f"JSON resultado: {out}")


if __name__ == "__main__":
    main()
