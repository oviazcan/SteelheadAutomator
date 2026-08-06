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
const IDP_TOKEN = arg('idp-token') || process.env.STEELHEAD_IDP_TOKEN || idpTokenFromProject();
const OUT_DIR = arg('out', path.join(REPORTES, 'eje1_specfields'));
const PAUSA = Number(arg('pausa', 900));
const ROOTS_FILE = arg('roots');
const RESUME = !!arg('resume');
const CKPT = path.join(OUT_DIR, '.extract-checkpoint.json');

// `?domainNanoId=<nano>` en la URL de /graphql. NO es opcional y su ausencia NO se ve como
// error: el ERP responde **HTTP 200, sin `errors`, y con todos los campos en null** — idéntico
// a como se ve un token vencido. Medido el 2026-08-05: la corrida daba `0/246 · árbol 0 ·
// specFields 0` en cada raíz y parecía problema de sesión; con el nano la MISMA petición
// devuelve el árbol (proceso 244434 → 30 relaciones). El cliente de `Reportes SH` siempre lo
// mandó (`steelhead_client.call()`); este extractor no, y por eso nunca volvió a extraer nada.
const DOMAIN = arg('domain', 'tlc');
const DOMAIN_NANO = arg('domain-nano') || process.env.STEELHEAD_DOMAIN_NANO || nanoFromProject(DOMAIN);

function nanoFromProject(dom) {
  try {
    const env = fs.readFileSync(path.join(REPORTES, '.env'), 'utf8');
    const key = 'STEELHEAD_DOMAIN_' + String(dom).toUpperCase();
    for (const line of env.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === key) {
        return line.slice(i + 1).trim().replace(/^["']|["']$/g, '') || null;
      }
    }
  } catch { /* sin proyecto hermano: seguimos y el aviso de abajo lo dice */ }
  return null;
}

// El access_token de OAuth lo administra `Reportes SH` (rota el refresh token y cachea).
// Reusarlo evita duplicar aquí el flujo de Authentik; si ese proyecto no está, seguimos sin
// token y el aviso de sesión hace el resto.
function idpTokenFromProject() {
  try {
    return execFileSync('/usr/bin/python3', ['-c',
      'import sys; sys.path.insert(0, "scripts"); import steelhead_auth; ' +
      'print(steelhead_auth.get_access_token())'],
      { cwd: REPORTES, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

if (!COOKIE) {
  console.error('ERROR: falta la cookie de sesión.\n' +
    '  node tools/extract-process-tree.mjs --cookie "<cookie>"\n' +
    '  o exporta STEELHEAD_COOKIE_STRING. Ver la skill `steelhead-auth`.');
  process.exit(1);
}

// Sin el nano la corrida NO falla: devuelve todo vacío y se lee como sesión caducada. Avisar
// aquí es la diferencia entre 4 minutos perdidos y un diagnóstico inmediato.
if (!DOMAIN_NANO) {
  console.error('ERROR: falta el domainNanoId del dominio "' + DOMAIN + '".\n' +
    '  Sin él /graphql responde 200 con TODOS los campos en null y la extracción sale vacía.\n' +
    '  Pásalo con --domain-nano <nano>, exporta STEELHEAD_DOMAIN_NANO, o deja que se lea de\n' +
    '  `Reportes SH/.env` (STEELHEAD_DOMAIN_' + String(DOMAIN).toUpperCase() + ').');
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
  // Estos headers NO son decorativos — son el contrato que ya usa en producción
  // `Reportes SH/scripts/steelhead_client.py`, y quitarlos rompe de dos maneras distintas:
  //
  //   sin `x-steelhead-idp-token` → HTTP 200, sin `errors`, y TODOS los campos en null.
  //                                 Un fallo de sesión disfrazado de «no hay datos».
  //   sin los `sec-fetch-*`       → HTTP 401 aunque la cookie sea válida (validación CSRF).
  //
  // Se replica el set completo en vez de adivinar el mínimo: el que ya funciona es ése.
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/graphql-response+json,application/json;q=0.9',
    'origin': BASE,
    'referer': `${BASE}/Reporting/Databases`,
    'apollographql-client-name': 'steelhead-web',
    'apollographql-client-version': '1.0.0',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
    'sec-ch-ua': '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'accept-language': 'es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7',
    cookie: COOKIE
  };
  if (IDP_TOKEN) headers['x-steelhead-idp-token'] = IDP_TOKEN;
  const url = BASE + '/graphql' + (DOMAIN_NANO ? '?domainNanoId=' + encodeURIComponent(DOMAIN_NANO) : '');
  const res = await fetch(url, {
    method: 'POST',
    headers,
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

// NO escribir una extracción incompleta encima de la buena. Sin este guard, una corrida que
// falla entera (sesión caducada, hash rotado) deja los 3 CSV con solo el encabezado y BORRA el
// corte anterior — y como los SQL leen esos archivos, la auditoría siguiente sale en ceros y se
// lee como «ya no hay huecos». Pasó el 2026-08-04. Un fallo total tiene que dejar el disco como
// estaba, no peor.
if (!done.size || !TREE.length) {
  console.error(`\n✗ No se cosechó nada (${done.size}/${roots.length} raíces). ` +
                `NO se escriben los CSV — se conserva el corte anterior.`);
  if (errores.length) console.error(`  Primer error: ${errores[0].error}`);
  process.exit(1);
}
// Cobertura parcial: se escribe, pero se avisa. Un 60% silencioso mentiría igual que un 0%.
if (done.size < roots.length) {
  console.warn(`\n⚠ Cobertura PARCIAL: ${done.size}/${roots.length} raíces ` +
               `(${(done.size / roots.length * 100).toFixed(1)}%). ` +
               `Los CSV que siguen NO cubren el dominio completo.`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// `en_proceso` = el nodo cuelga de al menos un proceso raíz. El paso 0 de la auditoría filtra
// por esta columna: los nodos sueltos son configuración huérfana y meterlos inventaría lugares
// donde el NP nunca pasa.
const montados = new Set(TREE.map(r => r.node_id));
const nodeRows = [...NODES.values()].map(n => ({ ...n, en_proceso: montados.has(n.id) ? 1 : 0 }));

const n1 = writeCsv(path.join(OUT_DIR, 'process_tree.csv'),
  ['root_process_node_id', 'node_id', 'parent_node_id', 'child_ind', 'spec_id'], TREE);
// La declaración nodo→campo NO depende del proceso, pero `harvest` corre una vez por raíz y un
// nodo vive en muchas (medido: `T101-IC00-001` aparece en 851 raíces con sus mismos 23 campos).
// Sin deduplicar, el CSV sale 5.7× más grande —19,470 filas para 3,401 pares reales— y aunque el
// SQL lo absorbe (`eje1` es un SELECT DISTINCT), el conteo de filas deja de ser comparable entre
// cortes: parece que la configuración se multiplicó cuando no cambió nada. El grano del archivo
// es el par, y así se escribe.
const sfUnicos = [...new Map(SF.map(r => [r.process_node_id + '|' + r.spec_field_id, r])).values()];
const n2 = writeCsv(path.join(OUT_DIR, 'process_node_spec_field.csv'),
  ['process_node_id', 'spec_field_id', 'spec_field_name', 'order_index'], sfUnicos);
const n3 = writeCsv(path.join(OUT_DIR, 'process_node.csv'),
  ['id', 'name', 'type', 'treatment_id', 'treatment_name', 'en_proceso'], nodeRows);

console.log(`\n✓ process_tree.csv             ${n1.toLocaleString()} filas`);
console.log(`✓ process_node_spec_field.csv  ${n2.toLocaleString()} filas`);
console.log(`✓ process_node.csv             ${n3.toLocaleString()} filas`);
console.log(`  raíces cubiertas: ${done.size}/${roots.length}`);

if (errores.length) {
  // Si fallaron TODAS por «sin treeRoot», no son 246 fallos independientes: es la sesión.
  // /graphql devuelve 200 sin `errors` y con los campos en null cuando falta el idp-token,
  // así que el síntoma no se parece a un problema de auth y se diagnostica mal.
  const todasSinTree = errores.length === roots.length &&
    errores.every(e => /sin treeRoot/.test(e.error));
  if (todasSinTree) {
    console.log(`\n⚠ Fallaron las ${errores.length} raíces con «respuesta sin treeRoot».`);
    console.log(`  Eso NO es un problema de datos: es la sesión. /graphql responde 200 y sin`);
    console.log(`  errores, pero con todo en null, cuando falta el header x-steelhead-idp-token`);
    console.log(`  o la cookie caducó.`);
    console.log(`  idp-token en esta corrida: ${IDP_TOKEN ? 'presente' : 'AUSENTE'}`);
    console.log(`  Revisa el .env de «Reportes SH» (skill steelhead-auth) y reintenta.`);
  } else {
    console.log(`\n⚠ ${errores.length} raíces fallaron:`);
    for (const e of errores.slice(0, 10)) console.log(`   ${e.id} — ${e.error}`);
    console.log(`  Vuelve a correr con --resume para reintentarlas.`);
  }
  process.exitCode = 1;
} else if (fs.existsSync(CKPT)) {
  fs.unlinkSync(CKPT);
}
