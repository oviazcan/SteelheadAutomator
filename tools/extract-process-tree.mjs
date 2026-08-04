#!/usr/bin/env node
/**
 * extract-process-tree.mjs — extrae el EJE 1 de la auditoría de specFields.
 *
 * POR QUÉ EXISTE
 * La auditoría «specFields que nunca se miden» se alimenta de dos insumos y solo uno vive en
 * DuckDB:
 *
 *   EJE 1 — DÓNDE se mide     specFields declarados en cada nodo del proceso  → ESTE SCRIPT
 *   EJE 2 — BAJO QUÉ CRITERIO specs del NP / del tratamiento, proceso default → DuckDB
 *
 * El eje 1 NO existe en la base de reportes: hay que sacarlo del ERP por GraphQL. La primera
 * extracción (2026-07-30) se hizo a mano y no quedó herramienta, así que al querer repetir la
 * auditoría el 2026-08-04 hubo que reconstruir el procedimiento desde cero. Este script es esa
 * reconstrucción, ya versionada.
 *
 * QUÉ PRODUCE  (los 3 CSV que consume `Reportes SH/eje1_specfields/`)
 *   process_tree.csv             root_process_node_id, node_id, parent_node_id, child_ind, spec_id
 *   process_node_spec_field.csv  process_node_id, spec_field_id, spec_field_name, order_index
 *   process_node.csv             id, name, type, treatment_id, treatment_name, en_proceso
 *
 * CÓMO
 * Un solo `GetProcessNode(id, occurrence, rootId)` por proceso RAÍZ devuelve el árbol completo
 * en `data.treeRoot.descendantRelationships[]`, y cada nodo trae sus specFields embebidos en
 * `processNodeSpecFieldsByProcessNodeId`. No hace falta recorrer nodo por nodo: son ~260
 * peticiones, no ~6000.
 *
 *   OJO con la forma: `treeRoot` cuelga de `data`, NO de `data.processNodeById`. Y en cada
 *   relación, `processNodeByFromId` es el HIJO y `toId` el PADRE.
 *
 * RITMO — no lo subas
 * El `/graphql` se cuelga bajo volumen sostenido: deja de responder sin devolver 429, no se
 * recupera al recargar la pestaña y tumba también la UI nativa, porque el límite es POR SESIÓN,
 * no por pestaña. Medido el 2026-08-04: ~170 peticiones con pausa de 300 ms lo tumbaron a la
 * mitad de la corrida (se destrabó solo a los pocos minutos). Por eso la pausa por omisión es de
 * 900 ms y las peticiones van EN SERIE. Una corrida completa toma ~4 minutos; no vale la pena
 * apurarla.
 *
 * USO
 *   node tools/extract-process-tree.mjs --cookie "<cookie de sesión>" [opciones]
 *
 *   --roots <archivo>   lista de ids raíz, uno por línea. Por omisión los deriva del snapshot
 *                       DuckDB (los procesos que usa algún NP activo).
 *   --out <dir>         destino de los CSV (default: Reportes SH/eje1_specfields/)
 *   --pausa <ms>        pausa entre peticiones (default 900)
 *   --resume            no repite las raíces ya presentes en el checkpoint
 *
 * La cookie sale de la sesión del navegador; ver la skill `steelhead-auth`.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const REPORTES = path.resolve(REPO, '..', 'Reportes SH');
const CONFIG = path.join(REPO, 'remote', 'config.json');

const BASE = 'https://app.gosteelhead.com';
const APOLLO_VERSION = '4.0.8';

// ── argumentos ──────────────────────────────────────────────────────────────
function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const COOKIE = arg('cookie') || process.env.STEELHEAD_COOKIE_STRING;
const OUT_DIR = arg('out', path.join(REPORTES, 'eje1_specfields'));
const PAUSA = Number(arg('pausa', 900));
const ROOTS_FILE = arg('roots');
const RESUME = !!arg('resume');
const CKPT = path.join(OUT_DIR, '.extract-checkpoint.json');

if (!COOKIE) {
  console.error('ERROR: falta la cookie de sesión.\n' +
    '  node tools/extract-process-tree.mjs --cookie "<cookie>"\n' +
    '  o exporta STEELHEAD_COOKIE_STRING. Ver la skill `steelhead-auth`.');
  process.exit(1);
}

// El hash de la persisted query se lee de config.json — nunca se hardcodea: rota con los
// releases del front y el hash-autopilot ya lo mantiene ahí.
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const HASH = cfg?.steelhead?.hashes?.queries?.GetProcessNode;
if (!HASH) {
  console.error('ERROR: no encuentro el hash de GetProcessNode en remote/config.json.');
  process.exit(1);
}

// ── GraphQL ─────────────────────────────────────────────────────────────────
async function gql(operationName, variables, hash) {
  const res = await fetch(BASE + '/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({
      operationName, variables,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: APOLLO_VERSION },
        persistedQuery: { version: 1, sha256Hash: hash }
      }
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // HTTP 400 «Must provide a query string» = el hash rotó. Abortar con mensaje claro en vez
    // de acumular cientos de fallos crípticos.
    if (/must provide a query string|persistedquerynotfound/i.test(t)) {
      throw new Error(`HASH ROTADO en ${operationName}: corre tools/run-hash-validation.sh`);
    }
    throw new Error(`HTTP ${res.status} en ${operationName}: ${t.slice(0, 160)}`);
  }
  const j = await res.json();
  if (j.errors) throw new Error(`${operationName}: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.data;
}

// ── raíces ──────────────────────────────────────────────────────────────────
function rootsFromDuckdb() {
  const py = `
import duckdb, glob, os, json
d = sorted(glob.glob(os.path.join(${JSON.stringify(REPORTES)}, 'steelhead_snapshot/tlc/duckdb/*.duckdb')),
           key=os.path.getmtime, reverse=True)
c = duckdb.connect(d[0], read_only=True)
ids = [r[0] for r in c.execute("""
  SELECT DISTINCT default_process_node_id FROM part_number
  WHERE archived_at IS NULL AND default_process_node_id IS NOT NULL
""").fetchall()]
print(json.dumps(sorted(ids)))
`;
  // /usr/bin/python3 es el que trae duckdb instalado en esta máquina; el del PATH no.
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', py], { encoding: 'utf8' }));
}

function loadRoots() {
  if (ROOTS_FILE && ROOTS_FILE !== true) {
    return fs.readFileSync(ROOTS_FILE, 'utf8').split('\n')
      .map(s => s.trim()).filter(Boolean).map(Number);
  }
  return rootsFromDuckdb();
}

// ── cosecha ─────────────────────────────────────────────────────────────────
const TREE = [];
const SF = [];
const NODES = new Map();

function harvestNode(p) {
  if (!p || p.id == null) return;
  NODES.set(p.id, {
    id: p.id, name: p.name || '', type: p.type || '',
    treatment_id: p.treatmentByTreatmentId?.id ?? '',
    treatment_name: p.treatmentByTreatmentId?.name ?? ''
  });
  for (const s of (p.processNodeSpecFieldsByProcessNodeId?.nodes || [])) {
    SF.push({
      process_node_id: p.id,
      spec_field_id: s.specFieldBySpecFieldId?.id ?? '',
      spec_field_name: s.specFieldBySpecFieldId?.name ?? '',
      order_index: s.orderIndex ?? ''
    });
  }
}

function harvest(root, data) {
  const tr = data?.treeRoot;
  if (!tr) throw new Error('respuesta sin treeRoot');
  harvestNode(tr);
  TREE.push({ root_process_node_id: root, node_id: tr.id, parent_node_id: '', child_ind: '', spec_id: '' });
  for (const rel of (tr.descendantRelationships || [])) {
    const child = rel.processNodeByFromId;   // OJO: `From` es el HIJO, `toId` el PADRE
    if (!child) continue;
    harvestNode(child);
    TREE.push({
      root_process_node_id: root, node_id: child.id,
      parent_node_id: rel.toId ?? '', child_ind: rel.childInd ?? '', spec_id: rel.specId ?? ''
    });
  }
}

// ── CSV ─────────────────────────────────────────────────────────────────────
const esc = v => {
  v = v == null ? '' : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
function writeCsv(file, cols, rows) {
  const body = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  fs.writeFileSync(file, body + '\n', 'utf8');
  return rows.length;
}

// ── main ────────────────────────────────────────────────────────────────────
const roots = loadRoots();
const done = new Set(RESUME && fs.existsSync(CKPT)
  ? JSON.parse(fs.readFileSync(CKPT, 'utf8')).done || [] : []);
const errores = [];

console.log(`procesos raíz: ${roots.length}${done.size ? ` (${done.size} ya hechos, --resume)` : ''}`);
console.log(`pausa: ${PAUSA} ms · destino: ${OUT_DIR}`);

let i = 0;
for (const id of roots) {
  i++;
  if (done.has(id)) continue;
  try {
    harvest(id, await gql('GetProcessNode', { id, processNodeOccurrence: 1, rootId: id }, HASH));
    done.add(id);
  } catch (e) {
    errores.push({ id, error: String(e.message || e) });
    // Un hash rotado no se arregla reintentando: aborta y deja el checkpoint.
    if (/HASH ROTADO/.test(String(e.message))) break;
  }
  if (i % 20 === 0) {
    console.log(`  ${done.size}/${roots.length} · árbol ${TREE.length} · specFields ${SF.length}`);
    fs.writeFileSync(CKPT, JSON.stringify({ done: [...done] }), 'utf8');
  }
  await new Promise(r => setTimeout(r, PAUSA));
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// `en_proceso` = el nodo cuelga de al menos un proceso raíz. El paso 0 de la auditoría filtra
// por esta columna: los nodos sueltos son configuración huérfana y meterlos inventaría lugares
// donde el NP nunca pasa.
const montados = new Set(TREE.map(r => r.node_id));
const nodeRows = [...NODES.values()].map(n => ({ ...n, en_proceso: montados.has(n.id) ? 1 : 0 }));

const n1 = writeCsv(path.join(OUT_DIR, 'process_tree.csv'),
  ['root_process_node_id', 'node_id', 'parent_node_id', 'child_ind', 'spec_id'], TREE);
const n2 = writeCsv(path.join(OUT_DIR, 'process_node_spec_field.csv'),
  ['process_node_id', 'spec_field_id', 'spec_field_name', 'order_index'], SF);
const n3 = writeCsv(path.join(OUT_DIR, 'process_node.csv'),
  ['id', 'name', 'type', 'treatment_id', 'treatment_name', 'en_proceso'], nodeRows);

console.log(`\n✓ process_tree.csv             ${n1.toLocaleString()} filas`);
console.log(`✓ process_node_spec_field.csv  ${n2.toLocaleString()} filas`);
console.log(`✓ process_node.csv             ${n3.toLocaleString()} filas`);
console.log(`  raíces cubiertas: ${done.size}/${roots.length}`);

if (errores.length) {
  console.log(`\n⚠ ${errores.length} raíces fallaron:`);
  for (const e of errores.slice(0, 10)) console.log(`   ${e.id} — ${e.error}`);
  console.log(`  Vuelve a correr con --resume para reintentarlas.`);
  process.exitCode = 1;
} else if (fs.existsSync(CKPT)) {
  fs.unlinkSync(CKPT);
}
