#!/usr/bin/env python3
"""Bridge para Power Tools / Low-Code de Steelhead — read-only por ahora.

Lee los hooks low-code desde Steelhead vía GraphQL (8 categorías documentadas
en docs/applets/powertools-catalog.md) y materializa cada uno en
`powertools/synced/<categoria>/<slot>.ts` + `<slot>.meta.json`.

Comandos:
  list                       — catálogo activo en TLC (single-slot + multi-slot)
  pull                       — descarga TODOS los slots activos a powertools/synced/
  pull --all-versions        — incluye versiones inactivas (.versions/)
  pull --category <name>     — sólo una categoría
  diff <slug>                — local vs server activo
  show <slug>                — vuelca el .ts activo a stdout

Slugs:
  Single-slot: received-order, invoice, inventory-usage, schedule
  Multi-slot:  pdf:<PDF_TYPE>, file-import:<FILE_IMPORT_TYPE>, fee:<FEE_ID>

Reusa SteelheadClient de Reportes SH (sys.path injection). Lee credenciales
desde `~/Projects/Ecoplating/Reportes SH/.env` — single source of cookie/JWT.

Push (Create*LowCode con `code` + `compiled`) queda en v2: requiere compilar
TS a JS localmente con el mismo target que el editor de Steelhead (ES2017,
ver lección sobre `??=` en docs/applets/powertools-ordendeventa.md).
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
SYNCED_DIR = REPO_ROOT / "powertools" / "synced"
REPORTES_SH_SCRIPTS = Path("/Users/oviazcan/Projects/Ecoplating/Reportes SH/scripts")

# ── Hashes capturados (ver docs/applets/powertools-catalog.md) ────────────
PERSISTED_QUERIES_LOWCODE: dict[str, str] = {
    # Reads (queries)
    "ReceivedOrderLowCode":   "09d7531d28944684340fdf6449c4f6196253c0a97db37b142c9e8a826b118858",
    "InvoiceLowCode":         "736c36db4d05b408e0e475b679361f2b91ae28c1737380a6ac7f55a6c44e2438",
    "PdfLowCode":             "3952791b76693673c2f7e3ae38f1cd880e5591954c484a7b7ba01502be434788",
    "CsvLowCode":             "0e3f7e4853c277c504f60eac342e7b4f3adba8455f00a83b6eb25d4b0e0eab6c",
    "FileImportLowCode":      "62c85b627d0346ed842f33f2a6e87357886b5290be6e377d27beec830a3ddb63",
    "InventoryUsageLowCode":  "06242ff2f943e16c64f7694ccfcad11e2397829154851f745505e0fe53c2705b",
    "FeeLowCode":             "7ebaf6d6382d4588d828a0fda129bd8c614f7ba48d487e6a02979b28c0d65fb0",
    "ScheduleLowCode":        "7a69b000ef2d80185bb6a982cbdeeefc89bb8ef4e9015dbd24c4531d6329b24b",
    # Writes (mutations) — reservadas para v2 (push)
    "CreateReceivedOrderLowCode":   "17ce5facb8d56ff314b20ed800abaffdab684aec9ab4b5803667bdcfc0dbdf36",
    "CreateInvoiceLowCode":         "0b7ba49b6ad498f225d3f532a27a0ec77d9241eaca18d3f2ea66083cbe733447",
    "CreatePdfLowCode":             "d62963890dc2ea10df8e5be2dc2b8f85443074969a3ecdb337d7e9459afbd9d4",
    "CreateFileImportLowCode":      "0be38b3d6c362b5ed516dd71eefcde6f19391a0528ea23ffd49fce6b468a7185",
    "CreateInventoryUsageLowCode":  "cd920bb05f59c398e90eb25bd8142140960a9275e77713d7ecac9936d907e4bf",
    "CreateFeeLowCode":             "3617aa40398014d64d2f6060cd546f029c363b03c2b92647b87c5a09ea2a4ca7",
    "CreateScheduleLowCode":        "1aadcd386e8c3a78956d8a2163a5b30590512adb34b59bc58e2699475cc7ab12",
    # Catálogo
    "GetAllLowCodeConfigs":         "d56b0a4112beeb7d7c7e6bf2b61ca829a870a1527e0de9ec8c5711ad5fcb1a13",
}

# pdfType enums conocidos en TLC (del scan + observación UI). Si Steelhead
# devuelve [] para uno, se ignora silenciosamente — sólo enumeramos los
# que estimamos viables. Para agregar más, ver el catálogo de pdfTemplates
# que devuelve GetAllLowCodeConfigs.
KNOWN_PDF_TYPES = [
    # Validados contra TLC 2026-05-25 — Steelhead sopla enum names en errores.
    "INVOICE_TEMPLATE",
    "WORK_ORDER_PART_NUMBER_TEMPLATE",
    "WORK_ORDER_PART_NUMBER_VERBOSE_TEMPLATE",
    "WORK_ORDER_TEMPLATE",
    "PART_NUMBER_TEMPLATE",
    "PACKING_SLIP_TEMPLATE",
    "QUOTE_UNIT_PRICE_TEMPLATE",
    "RECEIVER_TEMPLATE",
    "CERTIFICATION_TEMPLATE",
    "VENDOR_SHIPPER_TEMPLATE",
    "BILL_OF_LADING_TEMPLATE",
    "QMS_CAR_TEMPLATE",
    "RACK_TEMPLATE",
]

KNOWN_FILE_IMPORT_TYPES = [
    "QUOTE_IMPORT",
    "PART_TRANSFORM_IMPORT",
]

KNOWN_CSV_TYPES = [
    "INVOICE_TEMPLATE",
]


def _import_client():
    if not REPORTES_SH_SCRIPTS.exists():
        print(f"FATAL: no existe {REPORTES_SH_SCRIPTS}", file=sys.stderr)
        sys.exit(2)
    sys.path.insert(0, str(REPORTES_SH_SCRIPTS))
    try:
        import steelhead_client  # type: ignore
    except ImportError as e:
        print(f"FATAL: no pude importar steelhead_client: {e}", file=sys.stderr)
        sys.exit(2)
    # Inyectar nuestros hashes en el dict global del cliente para que client.call() los acepte.
    steelhead_client.PERSISTED_QUERIES.update(PERSISTED_QUERIES_LOWCODE)
    return steelhead_client.client_from_env


@dataclass
class HookSlot:
    """Un slot low-code descubierto (con su versión activa)."""
    category: str            # 'received-order', 'pdf', etc.
    slug: str                # ej. 'received-order', 'pdf:INVOICE_TEMPLATE'
    discriminator: Any       # None | str (pdfType) | int (feeId)
    active_id: Optional[int]
    active_code: Optional[str]
    active_compiled: Optional[str]
    active_created_at: Optional[str]
    active_creator: Optional[str]
    all_versions: list[dict]  # nodos crudos de la query


def _fetch_single_slot(client, operation: str, category: str, slug: str,
                       extra_vars: dict | None = None) -> Optional[HookSlot]:
    """Lee una query *LowCode single-slot y devuelve la versión más reciente.

    Convención: la versión activa = la más reciente por createdAt. Confirmado
    por usuario 2026-05-25 (la UI no expone Activate explícita).
    """
    vars_ = {"first": 50, "offset": 0}
    if extra_vars:
        vars_.update(extra_vars)
    try:
        data = client.call(operation, vars_)
    except Exception as e:
        print(f"  [skip] {operation} {extra_vars or ''}: {e}", file=sys.stderr)
        return None
    # La respuesta tiene una sola key tipo allReceivedOrderLowCodes / allPdfLowCodes / etc.
    top_keys = [k for k in data.keys() if k.startswith("all") and k.endswith("LowCodes")]
    if not top_keys:
        return None
    nodes = (data[top_keys[0]] or {}).get("nodes") or []
    if not nodes:
        return None
    nodes_sorted = sorted(nodes, key=lambda n: n.get("createdAt") or "", reverse=True)
    active = nodes_sorted[0]
    creator = (active.get("userByCreatorId") or {}).get("name")
    return HookSlot(
        category=category,
        slug=slug,
        discriminator=(extra_vars or {}).get(next(iter(extra_vars), ""), None) if extra_vars else None,
        active_id=active.get("id"),
        active_code=active.get("code"),
        active_compiled=active.get("compiled"),
        active_created_at=active.get("createdAt"),
        active_creator=creator,
        all_versions=nodes_sorted,
    )


# Catálogo de categorías y cómo enumerarlas. Cada entrada produce 0..N HookSlot.
SINGLE_SLOTS: list[tuple[str, str, str]] = [
    # (category-slug, operation, hook-name hint)
    ("received-order",  "ReceivedOrderLowCode",  "getReceivedOrderCustomization"),
    ("invoice",         "InvoiceLowCode",        "getInvoicePricing"),
    ("inventory-usage", "InventoryUsageLowCode", "getInventoryItemPredictedUsageCustomization"),
    ("schedule",        "ScheduleLowCode",       "schedule-hook"),
]

MULTI_SLOTS: list[tuple[str, str, str, list[Any]]] = [
    # (category-slug, operation, var-name, enum-list)
    ("pdf",         "PdfLowCode",        "pdfType",         KNOWN_PDF_TYPES),
    ("file-import", "FileImportLowCode", "fileImportType",  KNOWN_FILE_IMPORT_TYPES),
    ("csv",         "CsvLowCode",        "csvType",         KNOWN_CSV_TYPES),
]


def discover_all(client) -> list[HookSlot]:
    """Recorre todas las categorías y devuelve los slots con contenido."""
    found: list[HookSlot] = []
    for cat, op, _hint in SINGLE_SLOTS:
        slot = _fetch_single_slot(client, op, cat, cat)
        if slot:
            found.append(slot)
    for cat, op, var_name, enums in MULTI_SLOTS:
        for v in enums:
            slot = _fetch_single_slot(client, op, cat, f"{cat}:{v}", {var_name: v})
            if slot:
                found.append(slot)
    # Fee es por feeId — necesita enumeración aparte (sin endpoint catálogo conocido).
    # Lo dejamos pendiente para una segunda iteración.
    return found


# ── Comandos ─────────────────────────────────────────────────────────────

def cmd_list(args) -> int:
    client = _import_client()(do_keep_alive=True)
    slots = discover_all(client)
    print(f"{len(slots)} slot(s) activos descubiertos:\n")
    print(f"{'categoría':<16}  {'slug':<45}  {'id':>6}  {'creado':<20}  por")
    print("─" * 110)
    for s in sorted(slots, key=lambda x: (x.category, x.slug)):
        print(f"{s.category:<16}  {s.slug:<45}  {s.active_id or '?':>6}  "
              f"{(s.active_created_at or '')[:19]:<20}  {s.active_creator or '?'}")
    return 0


def _write_slot(slot: HookSlot, base_dir: Path, include_versions: bool) -> None:
    cat_dir = base_dir / slot.category
    cat_dir.mkdir(parents=True, exist_ok=True)
    # Slug "received-order" → archivo received-order.ts. Slug "pdf:INVOICE_TEMPLATE" → INVOICE_TEMPLATE.ts
    if ":" in slot.slug:
        fname = slot.slug.split(":", 1)[1] + ".ts"
    else:
        fname = slot.slug + ".ts"
    ts_path = cat_dir / fname
    meta_path = cat_dir / (fname.rsplit(".", 1)[0] + ".meta.json")

    ts_path.write_text(slot.active_code or "", encoding="utf-8")
    meta = {
        "category": slot.category,
        "slug": slot.slug,
        "discriminator": slot.discriminator,
        "active_id": slot.active_id,
        "active_created_at": slot.active_created_at,
        "active_creator": slot.active_creator,
        "total_versions": len(slot.all_versions),
        "all_version_ids": [n.get("id") for n in slot.all_versions],
    }
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    if include_versions and len(slot.all_versions) > 1:
        ver_dir = cat_dir / ".versions" / fname.rsplit(".", 1)[0]
        ver_dir.mkdir(parents=True, exist_ok=True)
        for n in slot.all_versions[1:]:  # 0 ya quedó como activa
            vid = n.get("id")
            (ver_dir / f"{vid}.ts").write_text(n.get("code") or "", encoding="utf-8")
            (ver_dir / f"{vid}.meta.json").write_text(json.dumps({
                "id": vid,
                "createdAt": n.get("createdAt"),
                "creator": (n.get("userByCreatorId") or {}).get("name"),
            }, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_pull(args) -> int:
    client = _import_client()(do_keep_alive=True)
    slots = discover_all(client)
    if args.category:
        slots = [s for s in slots if s.category == args.category]
    SYNCED_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for s in slots:
        _write_slot(s, SYNCED_DIR, include_versions=args.all_versions)
        written += 1
        flag = f" + {len(s.all_versions) - 1} versión(es)" if (args.all_versions and len(s.all_versions) > 1) else ""
        print(f"  ↓ {s.slug:<45}  id={s.active_id}  ({len(s.active_code or '')} chars){flag}")
    print(f"\n{written} slot(s) escritos en {SYNCED_DIR.relative_to(REPO_ROOT)}/")
    return 0


def cmd_diff(args) -> int:
    """Compara local (powertools/synced/<categoria>/<slot>.ts) vs server activo."""
    client = _import_client()(do_keep_alive=True)
    # Resolver slug → (categoría, operation, extra_vars)
    target = args.slug
    cat = target.split(":")[0] if ":" in target else target
    slot_obj = None
    for c, op, _hint in SINGLE_SLOTS:
        if c == cat:
            slot_obj = _fetch_single_slot(client, op, c, c)
            break
    if slot_obj is None:
        for c, op, var_name, _enums in MULTI_SLOTS:
            if c == cat and ":" in target:
                disc = target.split(":", 1)[1]
                slot_obj = _fetch_single_slot(client, op, c, target, {var_name: disc})
                break
    if slot_obj is None:
        print(f"FATAL: no encontré slot {target} en server", file=sys.stderr)
        return 2

    # Path local
    fname = (target.split(":", 1)[1] if ":" in target else target) + ".ts"
    local_path = SYNCED_DIR / cat / fname
    if not local_path.exists():
        print(f"FATAL: no existe local {local_path}", file=sys.stderr)
        return 2
    local = local_path.read_text(encoding="utf-8")
    remote = slot_obj.active_code or ""
    if local == remote:
        print(f"OK — local == server activo (id={slot_obj.active_id})")
        return 0
    import difflib
    diff = difflib.unified_diff(
        local.splitlines(keepends=True),
        remote.splitlines(keepends=True),
        fromfile=str(local_path.relative_to(REPO_ROOT)),
        tofile=f"server:{slot_obj.slug}#{slot_obj.active_id}",
    )
    sys.stdout.writelines(diff)
    return 1


CREATE_MUTATIONS: dict[str, tuple[str, Optional[str]]] = {
    # category → (mutation, discriminator-var)
    "received-order":  ("CreateReceivedOrderLowCode",  None),
    "invoice":         ("CreateInvoiceLowCode",        None),
    "inventory-usage": ("CreateInventoryUsageLowCode", None),
    "schedule":        ("CreateScheduleLowCode",       None),
    "pdf":             ("CreatePdfLowCode",            "pdfType"),
    "file-import":     ("CreateFileImportLowCode",     "fileImportType"),
    # csv: CreateCsvLowCode pendiente de capturar (no urgente).
}


def _compile_ts(code: str) -> str:
    """TS → JS con tsc ES2017 (matchea el target del runtime de Steelhead).

    Preserva comentarios + fuerza 'use strict' porque ese es el output que el
    server-side emite (verificado contra compiled de INVOICE_TEMPLATE id=10475).
    """
    import subprocess, tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "hook.ts"
        src.write_text(code, encoding="utf-8")
        out_dir = Path(tmp) / "out"
        cmd = [
            "npx", "--yes", "-p", "typescript", "tsc",
            str(src),
            "--target", "es2017",
            "--alwaysStrict",
            "--skipLibCheck",
            "--ignoreDeprecations", "6.0",
            "--outDir", str(out_dir),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode not in (0, 2):  # 2 = type warnings, no fatal
            raise RuntimeError(f"tsc falló (rc={proc.returncode}): {proc.stderr or proc.stdout}")
        out_file = out_dir / "hook.js"
        if not out_file.exists():
            raise RuntimeError(f"tsc no emitió output: {proc.stdout}")
        return out_file.read_text(encoding="utf-8")


def cmd_push(args) -> int:
    """Sube un .ts local como nueva versión activa del slot."""
    target = args.slug
    cat = target.split(":")[0] if ":" in target else target
    file_path = Path(args.file)
    if not file_path.is_absolute():
        file_path = (REPO_ROOT / file_path).resolve()
    if not file_path.exists():
        print(f"FATAL: no existe {file_path}", file=sys.stderr)
        return 2
    if cat not in CREATE_MUTATIONS:
        print(f"FATAL: categoría desconocida {cat}. Disponibles: {list(CREATE_MUTATIONS)}", file=sys.stderr)
        return 2
    mutation, disc_var = CREATE_MUTATIONS[cat]

    code = file_path.read_text(encoding="utf-8")
    print(f"  compilando {file_path.relative_to(REPO_ROOT)} ({len(code)} chars TS)...")
    try:
        compiled = _compile_ts(code)
    except Exception as e:
        print(f"FATAL: compilación falló: {e}", file=sys.stderr)
        return 2
    print(f"  compilado: {len(compiled)} chars JS")

    if args.dry_run:
        print(f"\n--- DRY RUN — NO se llama {mutation} ---")
        print(f"  mutation: {mutation}")
        if disc_var:
            disc = target.split(":", 1)[1]
            print(f"  {disc_var}: {disc}")
        print(f"  primeras 200 chars del compiled:\n{compiled[:200]}")
        return 0

    vars_ = {"code": code, "compiled": compiled}
    if disc_var:
        if ":" not in target:
            print(f"FATAL: {cat} requiere discriminador, usa slug tipo {cat}:VALUE", file=sys.stderr)
            return 2
        vars_[disc_var] = target.split(":", 1)[1]

    client = _import_client()(do_keep_alive=True)
    print(f"  push → {mutation} {vars_.get(disc_var) if disc_var else ''}...")
    try:
        resp = client.call(mutation, vars_)
    except Exception as e:
        print(f"FATAL: mutation falló: {e}", file=sys.stderr)
        return 2

    # La respuesta varía: {createReceivedOrderLowCode: {receivedOrderLowCode: {id, ...}}}.
    # Hacemos un fetch del slot fresco para reportar el id nuevo y confirmar visibilidad.
    if cat in [c for c, _, _ in SINGLE_SLOTS]:
        op = next(op for c, op, _ in SINGLE_SLOTS if c == cat)
        slot = _fetch_single_slot(client, op, cat, cat)
    else:
        op, var_name, _ = next((op, vn, enums) for c, op, vn, enums in MULTI_SLOTS if c == cat)
        disc = target.split(":", 1)[1]
        slot = _fetch_single_slot(client, op, cat, target, {var_name: disc})

    if slot:
        print(f"\n  ✓ nueva versión activa: id={slot.active_id}  ({slot.active_created_at})  by {slot.active_creator}")
        print(f"    total versiones del slot: {len(slot.all_versions)}")
        print(f"\n  Validación: abre el editor de Steelhead y verifica que el código cargue + el flujo funcione.")
        print(f"  Si algo se rompe, la versión anterior queda en historial — usa 'pull --all-versions' para recuperarla.")
    else:
        print(f"\n  ⚠ mutation respondió pero no pude re-fetchar el slot. Respuesta cruda:\n  {resp}")
    return 0


def cmd_show(args) -> int:
    """Vuelca el .ts activo del servidor (sin escribir disco)."""
    client = _import_client()(do_keep_alive=True)
    target = args.slug
    cat = target.split(":")[0] if ":" in target else target
    slot_obj = None
    for c, op, _hint in SINGLE_SLOTS:
        if c == cat:
            slot_obj = _fetch_single_slot(client, op, c, c)
            break
    if slot_obj is None:
        for c, op, var_name, _enums in MULTI_SLOTS:
            if c == cat and ":" in target:
                disc = target.split(":", 1)[1]
                slot_obj = _fetch_single_slot(client, op, c, target, {var_name: disc})
                break
    if slot_obj is None:
        print(f"FATAL: no encontré {target}", file=sys.stderr)
        return 2
    sys.stdout.write(slot_obj.active_code or "")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Bridge Power Tools / Low-Code de Steelhead")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("list", help="Catálogo activo")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("pull", help="Descarga slots activos a powertools/synced/")
    sp.add_argument("--all-versions", action="store_true",
                    help="Incluir versiones inactivas en .versions/")
    sp.add_argument("--category", help="Filtrar a una categoría (ej. pdf, invoice)")
    sp.set_defaults(func=cmd_pull)

    sp = sub.add_parser("diff", help="Diff local vs server activo")
    sp.add_argument("slug", help="ej. received-order, pdf:INVOICE_TEMPLATE")
    sp.set_defaults(func=cmd_diff)

    sp = sub.add_parser("show", help="Vuelca el .ts activo del servidor a stdout")
    sp.add_argument("slug", help="ej. received-order, pdf:INVOICE_TEMPLATE")
    sp.set_defaults(func=cmd_show)

    sp = sub.add_parser("push", help="Compila + sube .ts local como nueva versión activa")
    sp.add_argument("file", help="path al .ts local (ej. powertools/facturacion.ts)")
    sp.add_argument("slug", help="ej. invoice, pdf:INVOICE_TEMPLATE")
    sp.add_argument("--dry-run", action="store_true",
                    help="Compila pero no llama mutation")
    sp.set_defaults(func=cmd_push)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
