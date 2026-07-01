#!/usr/bin/env python3
"""safari-bundle-scan.py — escáner de integración del bundle Safari/iPad.

Compara remote/config.json (TODOS los applets) contra safari/bundle.json (la lista blanca
del bundle) y clasifica cada applet que NO está aún en el bundle, para que la skill
`safari-bundle-sync` sepa qué integrar, cómo (FAB directo y/o lanzador de popup), y qué
saltar (bloqueadores de iOS). También reporta applets YA en el bundle cuyos scripts tienen
cambios sin commitear (los tomará el rebuild) para el resumen de "actualizados".

Determinístico: solo SEÑALES + sugerencia. El juicio final (directo vs con-popup en casos
ambiguos, resolver un `fn` que no está en config) lo hace la skill. Salida legible + un
bloque JSON al final (marcado con === JSON ===) para consumo programático.

Uso:
  tools/safari-bundle-scan.py            # reporte legible + JSON
  tools/safari-bundle-scan.py --json     # solo el JSON
"""
import sys, os, json, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Helpers compartidos ya vetados para iOS — no los escaneamos por bloqueadores.
SHARED = {
    'scripts/steelhead-api.js', 'scripts/host-cleanup-shared.js', 'scripts/ov-operations.js',
    'scripts/process-shared.js', 'scripts/spec-shared.js',
}
# Sufijos de lógica pura (motores) — sin DOM/red, nunca bloquean.
PURE_SUFFIXES = ('-core.js', '-engine.js')

# Bloqueador DURO de iOS: descarga de archivos. Safari iOS ignora el atributo download del
# ancla y URL.createObjectURL+click no dispara descarga. Es el motivo #1 de "no-aplica".
HARD_DOWNLOAD = re.compile(r'URL\.createObjectURL|\.download\s*=|a\.download')
# Señales BLANDAS: funcionan pero con fricción / requieren gesto → "revisar".
SOFT = {
    'navigator.clipboard': re.compile(r'navigator\.clipboard'),
    'indexedDB':           re.compile(r'\bindexedDB\b'),
    'FileReader':          re.compile(r'\bnew FileReader\b'),
    'window.open':         re.compile(r'\bwindow\.open\s*\('),
    'chrome.storage':      re.compile(r'\bchrome\.storage\b'),
}
# chrome.* sin optional-chaining → ReferenceError bajo el shim (window.chrome={}) salvo chrome.runtime?.
CHROME_UNSAFE = re.compile(r'\bchrome\.(?!runtime\?\.)[a-zA-Z]+\.')


def load(p):
    with open(os.path.join(ROOT, p), encoding='utf-8') as f:
        return json.load(f)


def read_script(rel):
    p = os.path.join(ROOT, 'remote', rel)
    try:
        with open(p, encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return None


def scan_blockers(scripts):
    """Devuelve (hard:list, soft:list, chrome_unsafe:list) sobre los scripts propios del applet."""
    hard, soft, chrome_unsafe = [], [], []
    for rel in scripts:
        if rel in SHARED or rel.endswith(PURE_SUFFIXES):
            continue
        code = read_script(rel)
        if code is None:
            continue
        if HARD_DOWNLOAD.search(code):
            hard.append(rel)
        for name, rx in SOFT.items():
            if rx.search(code):
                soft.append(f'{name} ({os.path.basename(rel)})')
        if CHROME_UNSAFE.search(code):
            chrome_unsafe.append(os.path.basename(rel))
    return hard, soft, chrome_unsafe


def resolve_globals(main_script):
    """Heurística: nombres de global (window.X = ...) definidos en el script del applet."""
    code = read_script(main_script) or ''
    return sorted(set(re.findall(r'window\.([A-Z][A-Za-z0-9]+)\s*=', code)))


def launcher_for(app):
    """Extrae los lanzadores candidatos de las actions del applet (message + fn + icon + label)."""
    out = []
    for act in app.get('actions', []):
        if act.get('type') == 'toggle':
            continue  # los toggles no son lanzadores de UI
        if not act.get('message'):
            continue  # sin message no es lanzable por el canal (p. ej. file-picker/descarga)
        out.append({
            'message': act.get('message'),
            'fn': act.get('fn'),  # puede ser None → la skill lo resuelve por inspección
            'icon': act.get('icon') or '▶️',
            'label': act.get('label') or act.get('message'),
            'sublabel': act.get('sublabel') or '',
        })
    return out


def changed_scripts():
    """remote/scripts con cambios sin commitear (para el resumen de 'actualizados')."""
    try:
        out = subprocess.check_output(
            ['git', '-C', ROOT, 'status', '--porcelain', '--', 'remote/scripts'],
            text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return set()
    files = set()
    for line in out.splitlines():
        m = re.match(r'..\s+(remote/)?(scripts/\S+\.js)', line.strip())
        if m:
            files.add(m.group(2))
    return files


def main():
    json_only = '--json' in sys.argv
    config = load('remote/config.json')
    bundle = load('safari/bundle.json')
    bundle_ids = list(bundle.get('applets', []))
    bundle_set = set(bundle_ids)
    apps = {a['id']: a for a in config.get('apps', [])}
    changed = changed_scripts()

    candidates, in_bundle_changed = [], []

    for aid, app in apps.items():
        scripts = app.get('scripts', [])
        main_script = scripts[-1] if scripts else None
        hard, soft, chrome_unsafe = scan_blockers(scripts)
        launchers = launcher_for(app)

        if aid in bundle_set:
            touched = [s for s in scripts if s in changed]
            if touched:
                in_bundle_changed.append({'id': aid, 'changed': touched})
            continue

        # Sugerencia de clasificación (SEÑALES; el juicio final es de la skill).
        if hard:
            klass = 'NO-APLICA'
        elif soft or chrome_unsafe:
            klass = 'REVISAR'
        else:
            klass = 'INTEGRABLE'

        candidates.append({
            'id': aid,
            'suggest': klass,
            'autoInject': bool(app.get('autoInject')),
            'scripts': scripts,
            'globals': resolve_globals(main_script) if main_script else [],
            'launchers': launchers,
            'blockers_hard': hard,
            'blockers_soft': soft,
            'chrome_unsafe': chrome_unsafe,
        })

    # Orden: INTEGRABLE → REVISAR → NO-APLICA, luego por id.
    order = {'INTEGRABLE': 0, 'REVISAR': 1, 'NO-APLICA': 2}
    candidates.sort(key=lambda c: (order[c['suggest']], c['id']))

    result = {
        'bundle_version': bundle.get('version'),
        'in_bundle': bundle_ids,
        'in_bundle_changed': in_bundle_changed,
        'candidates': candidates,
    }

    if not json_only:
        print(f"Bundle Safari/iPad v{bundle.get('version')} — {len(bundle_ids)} applets\n")
        integ = [c for c in candidates if c['suggest'] == 'INTEGRABLE']
        rev = [c for c in candidates if c['suggest'] == 'REVISAR']
        noap = [c for c in candidates if c['suggest'] == 'NO-APLICA']

        def show(c):
            tags = []
            if c['autoInject']:
                tags.append('FAB')
            if c['launchers']:
                fns = ', '.join((l['fn'] or f"{c['globals']}?.{l['message']}") for l in c['launchers'])
                tags.append(f"LANZADOR[{fns}]")
            tagstr = (' · ' + ' · '.join(tags)) if tags else ''
            print(f"  • {c['id']}{tagstr}")
            if c['blockers_hard']:
                print(f"      ⛔ descarga: {', '.join(os.path.basename(x) for x in c['blockers_hard'])}")
            if c['blockers_soft']:
                print(f"      ⚠️  {', '.join(c['blockers_soft'])}")
            if c['chrome_unsafe']:
                print(f"      ⚠️  chrome.* sin optional-chaining: {', '.join(c['chrome_unsafe'])}")
            if c['launchers']:
                for l in c['launchers']:
                    fn = l['fn'] or f"(sin fn en config — resolver de globals: {c['globals']})"
                    print(f"      ↳ msg={l['message']}  fn={fn}  icon={l['icon']}  label={l['label']}")

        print(f"=== INTEGRABLE ({len(integ)}) — agrega a bundle.json (+ lanzador si tiene actions) ===")
        for c in integ:
            show(c)
        print(f"\n=== REVISAR ({len(rev)}) — señales blandas; la skill decide si es viable en iOS ===")
        for c in rev:
            show(c)
        print(f"\n=== NO-APLICA ({len(noap)}) — bloqueador de descarga; saltar y anotar razón ===")
        for c in noap:
            print(f"  • {c['id']}: descarga ({', '.join(os.path.basename(x) for x in c['blockers_hard'])})")
        if in_bundle_changed:
            print(f"\n=== YA EN BUNDLE, con cambios sin commitear (los toma el rebuild) ===")
            for c in in_bundle_changed:
                print(f"  • {c['id']}: {', '.join(os.path.basename(x) for x in c['changed'])}")
        print("\n=== JSON ===")

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
