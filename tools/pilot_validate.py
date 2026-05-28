#!/usr/bin/env python3
"""Valida los 50 PNs del piloto contra la API de Steelhead.

Para cada idSH del piloto:
  1. Llama GetPartNumber (persisted query)
  2. Extrae customInputs, specs (activas/archivadas), labels, predictivos,
     defaultProcessNode (línea/depto), group
  3. Compara contra lo que esperaba el restore v5 (xlsm fuente)
  4. Emite JSON detallado + tabla legible con diffs

Uso:
  python3 tools/pilot_validate.py \\
    --report-json ~/Downloads/dualsource_report_v102.json \\
    --srg-xlsm "$HOME/Downloads/BD Numeros de Parte Reloaded v23 valores base final SRG.xlsm" \\
    --cg-xlsm "$HOME/Downloads/BD Numeros de Parte Reloaded v23 valores base final clientes generales.xlsm" \\
    --out-json ~/Downloads/pilot_validation.json \\
    --out-md ~/Downloads/pilot_validation.md \\
    --limit 50 --max-per-customer 8
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

REPORTES_SH = Path("/Users/oviazcan/Projects/Ecoplating/Reportes SH")
sys.path.insert(0, str(REPORTES_SH / "scripts"))
sys.path.insert(0, str(Path(__file__).parent))

import steelhead_client as sc  # noqa: E402
from dual_source_recovery import load_xlsm_originals  # noqa: E402
from pilot_select import select  # noqa: E402


# Hash de GetPartNumber tomado de remote/config.json del proyecto.
sc.PERSISTED_QUERIES["GetPartNumber"] = (
    "60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2"
)


SPEC_NAME_HEADERS = ("Spec 1", "Spec 2")
SPEC_ESP_HEADERS = ("Esp. Spec 1 (µm)", "Esp. Spec 2 (µm)")
PREDICTIVE_HEADERS = (
    "Plata (kg/pza)",
    "Estaño (kg/pza)",
    "Níquel (kg/pza)",
    "Zinc (kg/pza)",
    "Cobre (kg/pza)",
    "Antitarnish (L/pza)",
    "Epóx. MT (lb/pza)",
    "Epóx. BT (lb/pza)",
    "Epóx. MTR (lb/pza)",
)


def _is_dash(v) -> bool:
    return isinstance(v, str) and v.strip() == "-"


def _fetch_pn(client: sc.SteelheadClient, pn_id: int) -> dict:
    return client.call(
        "GetPartNumber",
        {"partNumberId": pn_id, "usagesLimit": 50, "usagesOffset": 0},
    )["partNumberById"]


def _summarize_sh(pn: dict) -> dict:
    """Extrae los campos relevantes del response de SH para comparar."""
    ci = pn.get("customInputs") or {}
    dnp = ci.get("DatosAdicionalesNP") or {}
    dp = ci.get("DatosPlanificacion") or {}
    df = ci.get("DatosFacturacion") or {}

    # Mapa specFieldSpecId → fieldName (sirve para detectar el row de 'Espesor').
    # El "espesor" del CSV vive en partNumberSpecFieldParams, NO en el nombre
    # del spec — hay que reconstruirlo para comparar contra 'Spec | espesor'.
    sfs_field_name: dict[int, str] = {}
    for s in (pn.get("partNumberSpecsByPartNumberId") or {}).get("nodes") or []:
        spec_obj = s.get("specBySpecId") or {}
        for sfs in (spec_obj.get("specFieldSpecsBySpecId") or {}).get("nodes") or []:
            sf = sfs.get("specFieldBySpecFieldId") or {}
            sfs_field_name[sfs.get("id")] = sf.get("name") or ""

    # Mapa specFieldSpecId → param name aplicado al PN (busca el row de espesor).
    pn_sfp_by_sfs: dict[int, str] = {}
    for p in (pn.get("partNumberSpecFieldParamsByPartNumberId") or {}).get("nodes") or []:
        if p.get("archivedAt"):
            continue
        sfp = p.get("specFieldParamBySpecFieldParamId") or {}
        sfs_id = sfp.get("specFieldSpecId")
        if sfs_id is not None:
            pn_sfp_by_sfs[sfs_id] = sfp.get("name") or ""

    def _spec_display_name(spec_obj: dict) -> str:
        """Reconstruye 'Name | espesor' si el PN tiene un specFieldParam de Espesor
        ligado a alguno de los specFieldSpecs de esta spec."""
        base = spec_obj.get("name") or ""
        for sfs in (spec_obj.get("specFieldSpecsBySpecId") or {}).get("nodes") or []:
            fname = (sfs_field_name.get(sfs.get("id")) or "").lower()
            if "espesor" not in fname:
                continue
            applied = pn_sfp_by_sfs.get(sfs.get("id"))
            if applied:
                return f"{base} | {applied}"
        return base

    # Specs: separar activas vs archivadas (con nombre reconstruido).
    specs_active: list[dict] = []
    specs_archived: list[dict] = []
    for s in (pn.get("partNumberSpecsByPartNumberId") or {}).get("nodes") or []:
        sp = s.get("specBySpecId") or {}
        record = {"id": sp.get("id"), "name": _spec_display_name(sp)}
        if s.get("archivedAt"):
            record["archivedAt"] = s["archivedAt"]
            specs_archived.append(record)
        else:
            specs_active.append(record)

    # Labels (solo nombre)
    labels: list[str] = []
    for l in (pn.get("partNumberLabelsByPartNumberId") or {}).get("nodes") or []:
        nm = ((l.get("labelByLabelId") or {}).get("name") or "").strip()
        if nm:
            labels.append(nm)

    # Predictivos: name + microQuantityPerPart o usagePerPart (depende del shape)
    predictives: list[dict] = []
    for u in (pn.get("predictedInventoryUsagesByPartNumberId") or {}).get("nodes") or []:
        item = u.get("inventoryItemByInventoryItemId") or {}
        usage_per_part = None
        micro = u.get("microQuantityPerPart")
        if micro is not None:
            try:
                usage_per_part = float(micro) / 1e6
            except (TypeError, ValueError):
                usage_per_part = None
        predictives.append({
            "inventoryItemId": u.get("inventoryItemId") or item.get("id"),
            "name": item.get("name"),
            "usagePerPart": usage_per_part,
            "microQuantityPerPart": micro,
        })

    # Default process node — nombre típico: "T206 (LAV)-T000 (TRT)-T206 (EST)-BI-BIMETALES (18.0)"
    pn_default = pn.get("processNodeByDefaultProcessNodeId") or {}
    default_node_name = pn_default.get("name")

    group_obj = pn.get("partNumberGroupByPartNumberGroupId") or {}

    return {
        "id": pn.get("id"),
        "name": pn.get("name"),
        "customer": (pn.get("customerByCustomerId") or {}).get("name"),
        "archivedAt": pn.get("archivedAt"),
        "inputSchemaId": pn.get("inputSchemaId"),
        "group": group_obj.get("name"),
        "customInputs": {
            "BaseMetal": dnp.get("BaseMetal"),
            "QuoteIBMS": dnp.get("QuoteIBMS"),
            "EstacionIBMS": dnp.get("EstacionIBMS"),
            "Plano": dnp.get("Plano"),
            "NumeroParteAlterno": dnp.get("NumeroParteAlterno"),
            "PiezasCarga": dp.get("PiezasCarga"),
            "CargasHora": dp.get("CargasHora"),
            "TiempoEntrega": dp.get("TiempoEntrega"),
            "CodigoSAT": df.get("CodigoSAT"),
            "NotasAdicionales": ci.get("NotasAdicionales"),
        },
        "specsActive": specs_active,
        "specsArchived": specs_archived,
        "labels": sorted(labels),
        "predictives": predictives,
        "defaultProcessNodeName": default_node_name,
    }


def _summarize_expected(src_rows: list, customer: str) -> dict:
    """Lo que esperaba que SH tuviera según el xlsm fuente (restore v5)."""
    # Merge si hay >1 fila (caso Bimetales consolidados).
    if not src_rows:
        return {}

    # Para customInputs/labels/predictivos toma el primer no-vacío.
    def first_nonempty(header):
        for r in src_rows:
            v = r.raw.get(header)
            if v is None:
                continue
            if isinstance(v, str):
                s = v.strip()
                if not s or _is_dash(s):
                    continue
                return s
            return v
        return None

    # Specs merged
    spec_pairs: list[tuple[str, object]] = []
    seen_spec = set()
    for r in src_rows:
        for name_h, esp_h in zip(SPEC_NAME_HEADERS, SPEC_ESP_HEADERS):
            raw = r.raw.get(name_h)
            if not isinstance(raw, str):
                continue
            name = raw.strip()
            if not name or _is_dash(name):
                continue
            if name in seen_spec:
                continue
            seen_spec.add(name)
            spec_pairs.append((name, r.raw.get(esp_h)))

    # Predictives esperados (solo los con valor > 0)
    predictives_exp: list[dict] = []
    for ph in PREDICTIVE_HEADERS:
        v = first_nonempty(ph)
        if v is None:
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:
            mat = ph.split(" (")[0]
            predictives_exp.append({"name": mat, "usagePerPart": f})

    labels_exp: list[str] = []
    for i in range(1, 6):
        v = first_nonempty(f"Etiqueta {i}")
        if v:
            labels_exp.append(str(v).strip())
    labels_exp = sorted(set(labels_exp))

    return {
        "customer": customer,
        "group": first_nonempty("Grupo"),
        "baseMetal": first_nonempty("Metal base"),
        "quoteIBMS": first_nonempty("QuoteIBMS"),
        "estIBMS": first_nonempty("EstacionIBMS"),
        "plano": first_nonempty("Plano"),
        "piezasCarga": first_nonempty("Piezas por Carga"),
        "cargasHora": first_nonempty("Cargas por Hora"),
        "tiempoEntrega": first_nonempty("Tiempo de Entrega"),
        "notasAdicionales": first_nonempty("Notas adicionales"),
        "codigoSAT": first_nonempty("Código SAT"),
        "specs": [{"name": n, "esp": e} for n, e in spec_pairs],
        "labels": labels_exp,
        "predictives": predictives_exp,
        "linea": first_nonempty("Línea"),
        "departamento": first_nonempty("Departamento"),
        "proceso": first_nonempty("Proceso"),
    }


def _diff_summary(exp: dict, sh: dict) -> list[str]:
    """Lista de diferencias campo-a-campo. Cada string es una observación."""
    out: list[str] = []
    if not exp:
        out.append("SKIP: no expected (sin filas xlsm)")
        return out

    # Identidad básica
    if sh.get("archivedAt"):
        out.append(f"PN ARCHIVADO en SH (archivedAt={sh['archivedAt']})")

    ci = sh.get("customInputs") or {}

    # Comparaciones string-safe
    pairs = [
        ("BaseMetal", exp.get("baseMetal"), ci.get("BaseMetal")),
        ("QuoteIBMS", exp.get("quoteIBMS"), ci.get("QuoteIBMS")),
        ("EstIBMS", exp.get("estIBMS"), ci.get("EstacionIBMS")),
        ("Plano", exp.get("plano"), ci.get("Plano")),
        ("Group", exp.get("group"), sh.get("group")),
    ]
    for label, e, s in pairs:
        e_n = (str(e).strip() if e is not None else "")
        s_n = (str(s).strip() if s is not None else "")
        if e_n != s_n:
            out.append(f"{label}: esperado={e_n!r} sh={s_n!r}")

    # Numéricos planificación
    num_pairs = [
        ("PiezasCarga", exp.get("piezasCarga"), ci.get("PiezasCarga")),
        ("CargasHora", exp.get("cargasHora"), ci.get("CargasHora")),
        ("TiempoEntrega", exp.get("tiempoEntrega"), ci.get("TiempoEntrega")),
    ]
    for label, e, s in num_pairs:
        try:
            ef = float(e) if e not in (None, "") else None
        except (TypeError, ValueError):
            ef = None
        try:
            sf = float(s) if s not in (None, "") else None
        except (TypeError, ValueError):
            sf = None
        if (ef is None) != (sf is None):
            out.append(f"{label}: esperado={e!r} sh={s!r}")
        elif ef is not None and sf is not None and abs(ef - sf) > 1e-9:
            out.append(f"{label}: esperado={e!r} sh={s!r}")

    # Specs: comparar nombres del set
    exp_specs = {s["name"] for s in (exp.get("specs") or [])}
    sh_active = {s["name"] for s in (sh.get("specsActive") or [])}
    sh_arch = {s["name"] for s in (sh.get("specsArchived") or [])}
    missing = exp_specs - sh_active
    extra = sh_active - exp_specs
    arch_was_expected = exp_specs & sh_arch
    if missing:
        out.append(f"Specs FALTANTES activas (esperadas, no en SH): {sorted(missing)}")
    if arch_was_expected:
        out.append(f"Specs ARCHIVADAS pero esperadas activas: {sorted(arch_was_expected)}")
    if extra:
        out.append(f"Specs EXTRA activas (no esperadas): {sorted(extra)}")

    # Labels
    exp_labels = set(exp.get("labels") or [])
    sh_labels = set(sh.get("labels") or [])
    missing_l = exp_labels - sh_labels
    extra_l = sh_labels - exp_labels
    if missing_l:
        out.append(f"Labels FALTANTES: {sorted(missing_l)}")
    if extra_l:
        # Solo informativo, no es bug
        out.append(f"Labels EXTRA en SH (informativo): {sorted(extra_l)}")

    # Predictivos: por nombre
    exp_pred = {p["name"].split(" ")[0].lower(): p["usagePerPart"]
                for p in (exp.get("predictives") or [])}
    sh_pred: dict[str, float] = {}
    for p in (sh.get("predictives") or []):
        nm = (p.get("name") or "").split(" ")[0].lower()
        if nm and p.get("usagePerPart") is not None:
            sh_pred[nm] = p["usagePerPart"]
    for k, ev in exp_pred.items():
        sv = sh_pred.get(k)
        if sv is None:
            out.append(f"Predictivo FALTANTE {k!r}: esperado={ev}")
        elif abs(float(ev) - float(sv)) / max(abs(float(ev)), 1e-12) > 0.01:
            # diff > 1% relativo
            out.append(f"Predictivo {k!r}: esperado={ev} sh={sv}")
    for k, sv in sh_pred.items():
        if k not in exp_pred:
            out.append(f"Predictivo EXTRA en SH (informativo) {k!r}={sv}")

    # Proceso/Línea: SH lo expone via defaultProcessNodeName.
    dpn = (sh.get("defaultProcessNodeName") or "").strip()
    exp_proc = (exp.get("proceso") or "").strip()
    if exp_proc and dpn != exp_proc:
        out.append(f"DefaultProcessNode: esperado={exp_proc!r} sh={dpn!r}")
    elif not exp_proc and not dpn:
        pass  # ambos vacíos, ok
    elif not dpn and exp_proc:
        out.append(f"DefaultProcessNode FALTANTE en SH: esperado={exp_proc!r}")

    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--report-json", required=True, type=Path)
    ap.add_argument("--srg-xlsm", required=True, type=Path)
    ap.add_argument("--cg-xlsm", required=True, type=Path)
    ap.add_argument("--out-json", required=True, type=Path)
    ap.add_argument("--out-md", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--max-per-customer", type=int, default=8)
    ap.add_argument("--domain", default="tlc")
    ap.add_argument("--sleep", type=float, default=0.2,
                    help="Sleep entre requests (rate-limit defensivo)")
    args = ap.parse_args(argv)

    report = json.loads(args.report_json.read_text(encoding="utf-8"))
    corrections = report["corrections"]
    picked = select(
        corrections,
        limit=args.limit,
        max_per_customer=args.max_per_customer,
    )
    print(f"Selected {len(picked)} PNs (mismo selector que pilot_select)", file=sys.stderr)

    print("Loading source xlsm files...", file=sys.stderr)
    xlsm_rows = load_xlsm_originals([
        (args.srg_xlsm, "xlsm_srg"),
        (args.cg_xlsm, "xlsm_cg"),
    ])
    by_pn: dict[str, list] = defaultdict(list)
    for r in xlsm_rows:
        if r.pn:
            by_pn[r.pn].append(r)
    print(f"  {len(xlsm_rows)} xlsm rows", file=sys.stderr)

    print("Auth Steelhead...", file=sys.stderr)
    client = sc.client_from_env(domain=args.domain)

    out: list[dict] = []
    for i, p in enumerate(picked, 1):
        pn_id = int(p["idSH"])
        try:
            raw = _fetch_pn(client, pn_id)
        except Exception as exc:
            print(f"  [{i:02d}] {p['pn']} idSH={pn_id} ERROR: {exc}", file=sys.stderr)
            out.append({
                "idSH": p["idSH"],
                "pn": p["pn"],
                "customer": p["customer"],
                "error": str(exc),
            })
            continue

        sh_sum = _summarize_sh(raw)

        # Filtrar filas xlsm: si hay >1 candidato, preferir match de cliente
        candidates = by_pn.get(p["pn"], [])
        src_rows: list = []
        if candidates:
            if len(candidates) == 1:
                src_rows = list(candidates)
            else:
                client_prefix = p["customer"].split("—")[0].strip().upper()
                filtered = [c for c in candidates
                            if (c.cliente or "").upper().startswith(client_prefix[:30])]
                src_rows = filtered if filtered else list(candidates)
        exp_sum = _summarize_expected(src_rows, p["customer"])

        diffs = _diff_summary(exp_sum, sh_sum)

        out.append({
            "idSH": p["idSH"],
            "pn": p["pn"],
            "customer": p["customer"],
            "expected": exp_sum,
            "sh": sh_sum,
            "diffs": diffs,
            "xlsmRowCount": len(src_rows),
        })
        status = "OK" if not diffs else f"{len(diffs)} diffs"
        print(f"  [{i:02d}/{len(picked)}] {p['pn']:>16}  idSH={pn_id:<8}  {status}",
              file=sys.stderr)
        time.sleep(args.sleep)

    args.out_json.write_text(
        json.dumps(out, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nWrote {args.out_json}", file=sys.stderr)

    # Markdown report
    md_lines = ["# Validación piloto 50 PNs vs SH",
                "",
                f"Total PNs validados: {len(out)}",
                "",
                "## Resumen de bugs por tipo",
                ""]

    bug_counters: dict[str, int] = defaultdict(int)
    pns_with_bugs: list[dict] = []
    for r in out:
        if r.get("error"):
            bug_counters["error_api"] += 1
            continue
        if r["diffs"]:
            pns_with_bugs.append(r)
            for d in r["diffs"]:
                cat = d.split(":")[0].strip()
                bug_counters[cat] += 1

    for cat, n in sorted(bug_counters.items(), key=lambda x: -x[1]):
        md_lines.append(f"- **{cat}**: {n}")

    md_lines += ["", "## Detalle por PN con diffs", ""]
    for r in pns_with_bugs:
        md_lines += [
            f"### {r['pn']}  (idSH {r['idSH']}) — {r['customer'][:60]}",
            "",
        ]
        for d in r["diffs"]:
            md_lines.append(f"- {d}")
        md_lines.append("")

    # PNs sin diffs (sanidad)
    clean = [r for r in out if not r.get("error") and not r["diffs"]]
    md_lines += ["## PNs sin diffs (OK)", ""]
    for r in clean:
        md_lines.append(f"- {r['pn']} (idSH {r['idSH']})")

    args.out_md.write_text("\n".join(md_lines), encoding="utf-8")
    print(f"Wrote {args.out_md}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
