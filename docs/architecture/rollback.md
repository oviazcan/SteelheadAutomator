# Rollback de deploys (gh-pages)

Procedimiento para revertir un deploy malo de la extensión a un estado conocido.
Cierra el pendiente de seguridad #3 del audit pre-producción (antes: sin tags, sin
CHANGELOG, sin procedimiento de reversión).

## Modelo

- La extensión es un cascarón: en runtime fetchea `config.json` + `scripts/*.js` desde
  **gh-pages** (GitHub Pages). Revertir un deploy = devolver **gh-pages** a un estado previo.
- **`tools/deploy.sh` crea un tag `vX.Y.Z`** sobre el commit de `main` de cada bump
  (`X.Y.Z` = `config.version`). Ese tag es el ancla de rollback: contiene el `remote/`
  exacto que se publicó.
- El tag es el **CHANGELOG**: `git tag -l 'v*' --sort=-version:refname` con el subject de
  cada deploy da el historial de releases sin mantener un archivo aparte.

## Revertir (emergencia)

```bash
tools/rollback.sh --list          # ver tags de deploy disponibles (más reciente primero)
tools/rollback.sh v1.7.118        # revierte gh-pages al estado del deploy v1.7.118
```

`rollback.sh`:
1. Valida el tag y que el worktree de `main` esté limpio.
2. Muestra **versión viva** (gh-pages) vs **destino** (tag) y pide confirmación escribiendo el tag.
3. Re-espeja `<tag>:remote/` → gh-pages byte-a-byte (config.json + config.sig + scripts
   servidos), con el mismo mecanismo self-healing de `deploy.sh`. Scripts que no existen en
   el tag se eliminan de gh-pages (no deja huérfanos).
4. Commit `rollback: gh-pages a <tag>` + push de **gh-pages únicamente**.

GitHub Pages publica en ~30-60s. Verifica en vivo con `tools/deploy-status.sh`. Los operadores
recargan la extensión (o Chrome la recarga por el cambio de `config.version`).

## Después de estabilizar: arreglar `main`

`rollback.sh` **solo toca gh-pages**. `main` sigue apuntando al commit malo, así que el
**próximo `deploy.sh` re-espejaría `main` y re-introduciría el problema**. Antes del siguiente
deploy:

```bash
# en el worktree de main
git revert <commit-malo>          # o corrige el bug de raíz y commitea
```

Así `main` y gh-pages vuelven a converger y el invariante byte-a-byte
(`tools/deploy-status.sh`) queda sano.

## Notas

- El tagging es **aditivo y tolerante**: si `deploy.sh` no logra crear/pushear el tag, el
  deploy ya quedó vivo igual (no se aborta) y se avisa para crear el ancla a mano.
- Tags previos al esquema de deploy (sin `remote/config.json` en el árbol) se rechazan con
  mensaje claro.
- El rollback de la **extensión empaquetada** (el `.zip` en gh-pages / Chrome Web Store) es
  aparte: si el deploy malo tocó `extension/`, hay que republicar el `.zip` de la versión
  anterior. `rollback.sh` cubre los scripts remotos (que es el 99% de los deploys).
