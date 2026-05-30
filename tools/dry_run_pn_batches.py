#!/usr/bin/env python3
"""Dry-run: contar lotes activos de los inventory types de números de parte.

Reusa el cliente del proyecto Reportes SH (auth JWT contra /graphql).
Solo LECTURA: AllInventoryTypes + SearchInventoryTypeItems +
SearchInventoryItemBatches. NO archiva nada.

Concurrente en la fase de lotes (item-por-item) para no arrastrarse como
el snippet de consola.

Uso:
    python3 tools/dry_run_pn_batches.py --domain tlc [--workers 8]
"""
import argparse
import json
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def call_with_retry(client, op, variables, max_retry=6):
    """Reintenta con backoff exponencial cuando Steelhead responde 429."""
    delay = 1.0
    for attempt in range(max_retry + 1):
        try:
            return client.call(op, variables)
        except Exception as e:
            if "429" in str(e) and attempt < max_retry:
                time.sleep(delay + random.uniform(0, 0.5))
                delay = min(delay * 2, 30)
                continue
            raise

REPORTES_SH = Path("/Users/oviazcan/Projects/Ecoplating/Reportes SH/scripts")
sys.path.insert(0, str(REPORTES_SH))

import steelhead_client as sc  # noqa: E402
from steelhead_client import client_from_env  # noqa: E402

# Hashes de inventario (verificados en SteelheadAutomator/remote/config.json)
sc.PERSISTED_QUERIES.update({
    "AllInventoryTypes":          "c8df929bb155369cf5ee7c7939697cde53a939b644b9bd220bde662522537d4d",
    "SearchInventoryTypeItems":   "83964a4ab84b6fae39d781127dd7b08d0a0dd852a3e3f85a812bbeda627a6c9a",
    "SearchInventoryItemBatches": "d0c8079c928e46305bb3cbd8e10642b195e7bbc7b5417e7f88960912c229f926",
})

PAGE_TYPE_ITEMS = 50
PAGE_BATCHES = 100


def fetch_pn_types(client):
    data = client.call("AllInventoryTypes", {})
    nodes = (data.get("allInventoryTypes") or {}).get("nodes") or []
    return [
        {"id": n["id"], "name": n["name"]}
        for n in nodes
        if n.get("isPartNumberInventory") and not n.get("archivedAt")
    ]


def fetch_items_for_type(client, type_id):
    out, offset = [], 0
    while True:
        data = call_with_retry(client, "SearchInventoryTypeItems", {
            "fetchCustomer": False, "fetchCreator": False, "fetchPurchaseOrder": False,
            "fetchWorkOrder": False, "fetchVendor": False, "fetchReceivedOrder": False,
            "fetchLocation": False, "fetchMaterial": False,
            "inventoryTypeId": type_id, "searchString": "", "offset": offset,
            "first": PAGE_TYPE_ITEMS, "orderBy": ["ID_ASC"],
        })
        nodes = (data.get("searchInventoryItems") or {}).get("nodes") or []
        out.extend(nodes)
        if len(nodes) < PAGE_TYPE_ITEMS:
            break
        offset += PAGE_TYPE_ITEMS
    return out


def fetch_active_batches(client, item_id):
    out, offset = [], 0
    while True:
        data = call_with_retry(client, "SearchInventoryItemBatches", {
            "id": item_id, "archivedOption": "NO", "offset": offset,
            "notCompleted": False, "first": PAGE_BATCHES, "orderBy": ["ID_ASC"],
        })
        nodes = (data.get("searchInventoryBatches") or {}).get("nodes") or []
        out.extend(nodes)
        if len(nodes) < PAGE_BATCHES:
            break
        offset += PAGE_BATCHES
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="máx items por tipo (0=todos); para pruebas")
    args = ap.parse_args()

    client = client_from_env(domain=args.domain)
    print(f"=== DRY-RUN lotes PN — dominio {args.domain} ===", flush=True)

    types = fetch_pn_types(client)
    if not types:
        print("No hay inventory types con isPartNumberInventory=true. Nada que hacer.")
        return
    print("Tipos PN: " + ", ".join(f"{t['name']} (#{t['id']})" for t in types), flush=True)

    all_batch_ids = []
    batch_detail = []
    per_type = []
    t0 = time.time()

    for typ in types:
        items = fetch_items_for_type(client, typ["id"])
        if args.limit:
            items = items[:args.limit]
        print(f"  [{typ['name']}] {len(items)} items — buscando lotes (workers={args.workers})...", flush=True)
        type_count = 0
        done = 0
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(fetch_active_batches, client, it["id"]): it for it in items}
            for fut in as_completed(futs):
                it = futs[fut]
                done += 1
                if done % 100 == 0:
                    print(f"    {done}/{len(items)} items...", flush=True)
                try:
                    batches = fut.result()
                except Exception as e:
                    print(f"    error item {it['id']}: {str(e)[:120]}", flush=True)
                    continue
                for b in batches:
                    all_batch_ids.append(b["id"])
                    batch_detail.append({
                        "batchId": b["id"], "itemId": it["id"],
                        "itemName": it.get("name"), "typeName": typ["name"],
                    })
                    type_count += 1
        per_type.append({"typeId": typ["id"], "typeName": typ["name"],
                         "items": len(items), "batches": type_count})
        print(f"  {typ['name']}: {len(items)} items, {type_count} lotes activos", flush=True)

    elapsed = time.time() - t0
    print(f"\nTotal: {len(all_batch_ids)} lotes activos en {len(types)} tipos PN "
          f"({elapsed:.1f}s)", flush=True)
    print(f"{'TIPO':<35}{'ITEMS':>8}{'LOTES':>8}")
    for r in per_type:
        print(f"{r['typeName']:<35}{r['items']:>8}{r['batches']:>8}")

    stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
    out_path = Path.home() / "Downloads" / f"archive-pn-batches_DRYRUN_{args.domain}_{stamp}.json"
    out_path.write_text(json.dumps({
        "mode": "dry-run", "domain": args.domain, "stamp": stamp,
        "types": types, "perType": per_type,
        "totalBatches": len(all_batch_ids),
        "batchIds": all_batch_ids, "batchDetail": batch_detail,
    }, indent=2, ensure_ascii=False))
    print(f"\nJSON: {out_path}", flush=True)


if __name__ == "__main__":
    main()
