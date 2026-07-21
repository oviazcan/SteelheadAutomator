# Migración del self-healing de hashes a un servidor 24/7 — Design

**Fecha:** 2026-07-15
**Estado:** Propuesta — pendiente de decisiones del usuario (§5) antes de planear implementación
**Sistema que migra:** `tools/hash-autopilot/` (motor headless) + `tools/validate-hashes.py` (validador) + su agendado hoy en `launchd` sobre la laptop del usuario
**No cubre (fuera de alcance):** `com.ecoplating.steelhead-weekly-snapshot` (refresh del DuckDB de Reportes SH) ni el cron diario `hash-validator-daily` de Claude Code — se mencionan como sistemas ENTRELAZADOS (comparten auth) en §1 y §4, pero su migración es una decisión aparte.

---

## 1. Contexto y motivación

### 1.1 Qué hace el sistema hoy

`tools/hash-autopilot/hash-autopilot.mjs` es un motor Node/Playwright que abre
Chromium headless ya autenticado, navega Steelhead (recetas de
`click-recipes.json` + ciclos "sentinela" para mutations), intercepta
`/graphql`, clasifica cada operación (`vigente` / `rotadoValidado` /
`sospechoso` / `noCapturado`) y **auto-deploya** los hashes rotados a
`gh-pages` con salvaguardas (`autopilot-deploy.sh`). `tools/validate-hashes.py`
es el detector liviano en Python que prueba los ~170-180 hashes vía POST
directo a `/graphql` (sin abrir navegador) para las operaciones que SÍ se
pueden validar desde un cliente externo.

Todo corre **desde la laptop del usuario**, agendado por dos jobs `launchd`
(`tools/launchd/*.plist`) invocados por el wrapper
`tools/run-hash-autopilot.sh` cada hora a `:23`:

- **Capa 1 (siempre, sin gate):** refresca el token ROCP y recaptura las 5
  queries + 1 mutation "enmascaradas" (session-sensitive, `masked-ops.json`)
  que el validador Python no puede ver de forma confiable.
- **Capa 2 (con gate por release):** si Steelhead publicó un build nuevo
  (compara `code-id` de `/version.json`), corre `validate-hashes.py` +
  el motor completo.

Nota de estado actual: solo `com.ecoplating.steelhead-hash-autopilot` está
cargado en `launchctl list` en esta laptop. El plist
`com.ecoplating.steelhead-hash-validator.plist` existe en el repo pero está
**huérfano** — el validador corre embebido dentro de la Capa 2 del wrapper de
arriba, no como job independiente (confirmado: no aparece en
`launchctl list`).

### 1.2 La evidencia que motiva migrar: el 13-jul

El 2026-07-13 a las 22:23:55 corrió `validate-hashes.py` y el resultado
(`tools/.hash-validation/2026-07-13.json`) fue:

```json
"totals": { "checked": 180, "ok": 0, "stale": 0, "skipped": 0, "unknown": 180, "auth_errors": 0 }
```

**180 de 180 hashes "unknown"** — el validador no pudo confirmar NADA, ni
vigente ni rotado. El motivo, textual del propio JSON:

```
red: ConnectionError: HTTPSConnectionPool(host='app.gosteelhead.com', port=443):
Max retries exceeded ... Caused by NameResolutionError("HTTPSConnection(
host='app.gosteelhead.com', port=443): Failed to resolve 'app.gosteelhead.com'
([Errno 8] nodename nor servname provided, or not known)")
```

Es decir: el DNS no resolvió el dominio de Steelhead. La causa más probable es
la más simple — la Mac estaba dormida o sin interfaz de red activa cuando
`launchd` disparó el tick de las 22:23. El job SÍ corrió (no fue un tick
saltado), pero corrió **a ciegas**: si en esa ventana un hash real se hubiera
rotado, el sistema no se habría enterado. Esto no es un bug de código — es la
consecuencia directa de que la única máquina que ejecuta el self-healing es
un laptop personal, que duerme, viaja, cambia de red y no tiene garantía de
uptime.

### 1.3 Por qué esto ya no es tolerable

- **El self-healing solo es tan bueno como su disponibilidad.** Un candado
  que se abre y cierra dependiendo de si alguien dejó la laptop despierta no
  es un candado 24/7 — y Steelhead puede publicar un release (y rotar un
  hash) a cualquier hora, incluida de noche o fin de semana.
- **La fragilidad de auth agrava el problema, no lo compensa.** La misma
  semana (`SELFHEAL-2026-07-14.md`) se diagnosticó que el token de acceso
  ROCP dura ~8h y el refresh token de Authentik **rota en cada uso** — si el
  SPA headless lo refresca a medio-vuelo, el refresh persistido queda
  invalidado y la siguiente corrida cae en `authFailed` silencioso (0
  capturas, sin avisar por qué). Se mitigó forzando un refresh ANTES de abrir
  el navegador (`run-hash-autopilot.sh`, líneas 40-57), pero esa mitigación
  **depende de que el wrapper efectivamente corra** — si la laptop está
  dormida, ni siquiera llega a intentar el refresh, y cada hora sin correr es
  una hora en la que el token vivo se puede acercar más a su ventana de
  vencimiento sin que nadie lo reactive.
- **El costo de una rotación no detectada es real y ya pasó.** El caso
  histórico `AllCustomers` (2026-07-03, citado en el propio README) dejó una
  carga masiva con 0 clientes sin que el validador lo viera venir —
  exactamente el tipo de falla silenciosa que un gap de disponibilidad
  reproduce.

**Motivación de este documento:** mover la ejecución (no necesariamente todo
el diseño) a una máquina Linux always-on, para que "¿la laptop está despierta
y conectada?" deje de ser una variable del sistema de detección de rotaciones.

---

## 2. Arquitectura propuesta

### 2.1 Resumen

```
┌─────────────────────────────────────────────────────────────┐
│  Servidor Linux 24/7 (VPS o equivalente, fuera de la laptop) │
│                                                                │
│  systemd timer (hash-autopilot.timer, OnCalendar cada hora)  │
│         │                                                     │
│         ▼                                                     │
│  systemd service (oneshot) → run-hash-autopilot.sh            │
│         │                                                     │
│         ├─ Capa 1: refresh ROCP (force) + --masked-only       │
│         │     (usa credenciales propias del servidor,         │
│         │      NO comparte token-cache con la laptop)         │
│         │                                                     │
│         ├─ Gate por release (curl a /version.json)            │
│         │                                                     │
│         └─ Capa 2: validate-hashes.py + motor completo         │
│               │                                                │
│               ├─ Playwright Chromium headless → app.gosteelhead.com
│               ├─ auth.gosteelhead.com (Authentik, refresh OAuth) │
│               └─ github.com (push a gh-pages vía deploy key)   │
│                                                                │
│  Notificación: gh issue create (ya portable) + SMTP            │
│  Secretos: archivo .env fuera del repo, 600, usuario dedicado  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Cómputo

Servidor Linux **always-on**, dedicado (no compartido con otras cargas
pesadas que puedan competir por red/CPU en el minuto exacto del tick). No
necesita ser grande: el trabajo real es abrir Chromium headless una vez por
hora durante segundos-a-minutos, no un servicio siempre corriendo. Una VM de
1-2 vCPU / 2 GB RAM es holgada para Playwright+Chromium+Node+Python.

Recomiendo (ver §5 para la decisión final del usuario, incluye alternativas):
**VPS Linux administrado** (ej. un droplet/instancia pequeña) con IP estática
y proveedor de red confiable, en vez de reusar un Mac mini/NAS de oficina —
mismo argumento que motiva la migración: la garantía de "encendido y con
red" de un proveedor cloud (SLA, red redundante) es estructuralmente mejor
que la de un equipo físico en una oficina que también puede perder luz/WiFi.
Si el usuario prefiere no depender de un proveedor cloud (control de datos,
costo cero recurrente), un Mac mini o mini-PC dedicado en la oficina/casa con
UPS y conexión cableada (no WiFi) es una alternativa razonable — cambia el
runbook de "systemd en Linux" por "launchd en un segundo Mac", pero resuelve
el mismo problema de raíz (la ejecución deja de depender de LA LAPTOP que el
usuario usa a diario). Documento asume Linux porque así lo pidió el usuario en
el encargo; la sección de requisitos técnicos (§3) señala qué cambia si se
opta por macOS en su lugar.

### 2.3 Sistema operativo y runtime

- **Ubuntu 22.04 LTS o 24.04 LTS** (o Debian 12) — son las distros que
  Playwright soporta oficialmente y para las que `playwright install --with-deps`
  resuelve automáticamente las dependencias de sistema de Chromium.
- **Node.js** — el motor ya es JS puro (`hash-autopilot.mjs`, `type: module`,
  dependencia única `playwright ^1.57.0`). Recomiendo Node 20 LTS o 22 LTS
  (soporte largo) vía `apt`/`nvm`. La laptop hoy corre v25.8.2 (current, no
  LTS) — no hace falta igualar esa versión exacta, solo cumplir el mínimo de
  Playwright (Node ≥18).
- **Python 3.10+** para `validate-hashes.py` (la laptop corre 3.9.6 vía
  `/usr/bin/python3` del sistema; en Linux instalar explícitamente, el
  `python3` de base de Ubuntu ya sirve).
- **Chromium de Playwright**: `npx playwright install --with-deps chromium`
  dentro de `tools/hash-autopilot/`. El flag `--with-deps` instala los
  paquetes `apt` que Chromium necesita en Linux (`libnss3`,
  `libatk-bridge2.0-0`, `libgtk-3-0`, `libgbm1`, `libasound2`, fuentes, etc.)
  — en macOS esas dependencias vienen del sistema operativo, así que esto es
  un requisito **nuevo** que no existe hoy en la laptop.

### 2.4 Agendado: `systemd timer` en vez de `launchd`

Reemplaza los dos `.plist` por un **timer unit** de systemd (equivalente
directo de `StartCalendarInterval`):

```ini
# /etc/systemd/system/hash-autopilot.service
[Unit]
Description=Steelhead hash-autopilot (self-heal de persisted-query hashes)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=svc-hashautopilot
WorkingDirectory=/opt/steelhead-automator
ExecStart=/opt/steelhead-automator/tools/run-hash-autopilot.sh
EnvironmentFile=/etc/steelhead-automator/hash-autopilot.env
```

```ini
# /etc/systemd/system/hash-autopilot.timer
[Unit]
Description=Corre hash-autopilot cada hora a :23

[Timer]
OnCalendar=*-*-* *:23:00
Persistent=true

[Install]
WantedBy=timers.target
```

Notas de diseño:
- `After=network-online.target` + `Wants=network-online.target` es el
  equivalente systemd de "no dispares hasta que la red esté lista" — algo
  que `launchd` en la laptop NO garantiza (por eso el DNS falló el 13-jul).
  Esto por sí solo cierra buena parte de la brecha que motivó la migración.
- `Persistent=true` hace que un tick perdido (ej. reboot por patch de
  seguridad) se recupere al arrancar, en vez de esperar hasta la próxima hora
  en punto — barato en un servidor 24/7, no relevante hoy en la laptop porque
  ahí "perder un tick" es casi el estado normal.
- `journalctl -u hash-autopilot.service` sustituye los `StandardOutPath`/
  `StandardErrorPath` de los plists; opcionalmente seguir escribiendo también
  a `tools/.hash-autopilot/launchd.out.log` si se quiere mantener el mismo
  lugar que hoy inspeccionan los scripts/bitácoras.
- El wrapper `run-hash-autopilot.sh` **no necesita reescribirse** — su lógica
  de dos capas + gate por release es agnóstica de si lo dispara `launchd` o
  `systemd`. Sí necesita los `export REPO_ROOT/NODE/PYTHON/REPORTES_SH`
  ajustados a paths de Linux (ver §2.5 y §3).

### 2.5 Flujo de auth (resumen — detalle de riesgo en §4.1)

Hoy `hash-autopilot.mjs` y `validate-hashes.py` **no tienen auth propia**:
ambos leen credenciales del proyecto hermano `Reportes SH`
(`/Users/oviazcan/Projects/Ecoplating/Reportes SH/.cache/tokens.json` y
`.env`, un repo git **separado** que vive solo en la laptop). Esto es la
pieza de arquitectura que más cambia con la migración, porque un servidor
remoto no tiene ese repo ni ese `.env` a mano por defecto.

Arquitectura propuesta (decisión final depende de §5.2):
1. **Vender/copiar** la lógica mínima de `steelhead_auth.py` +
   `steelhead_client.py` dentro de `SteelheadAutomator` (p.ej.
   `tools/hash-autopilot/auth/`), rompiendo la dependencia cruzada del repo
   `Reportes SH`. El servidor NO clona `Reportes SH` — solo tiene lo que
   necesita para refrescar tokens y pegar a `/graphql`.
2. El servidor mantiene **su propio** `refresh_token` y `tokens.json`, sembrado
   una vez de forma manual por el usuario (pegar un refresh token capturado
   de una sesión real), independiente del que usa la laptop para `Reportes
   SH`/`steelhead-hash-validator`. Esto evita que dos procesos en dos
   máquinas compitan por rotar el mismo refresh token (ver §4.1 — es el
   riesgo #1).
3. `run-hash-autopilot.sh` sigue haciendo el "force refresh antes de abrir el
   navegador" que ya se implementó el 2026-07-15 — ese patrón no cambia, solo
   el archivo de credenciales que consulta.

### 2.6 Deploy (`git push` a `gh-pages`)

`autopilot-deploy.sh` exige estar en `main`, sin WIP ajeno en `remote/`, edita
`config.json`, y llama a `tools/deploy.sh` (bump + commit + espejo `gh-pages`
+ push de ambas ramas + `check-deploy`). Esa cadena de scripts **no cambia**;
lo que cambia es cómo el servidor se autentica contra GitHub para el `push`:

- El remoto hoy es HTTPS (`https://github.com/oviazcan/SteelheadAutomator.git`)
  y en la laptop probablemente usa un credential helper del Keychain de
  macOS — eso no existe en un servidor Linux sin sesión interactiva.
- **Propuesta: SSH deploy key** dedicada, con permiso de escritura, agregada
  SOLO a este repo (Settings → Deploy keys, "Allow write access"). Es el
  mecanismo más acotado: si se filtra, el radio de daño es un repo, no toda
  la cuenta de GitHub del usuario (a diferencia de un PAT clásico). El
  servidor usaría un remote `git@github.com:oviazcan/SteelheadAutomator.git`
  (o un remote alias aparte, ej. `origin-deploy`, para no tocar el remote
  `origin` que ya usan otros flujos).
- Alternativa: **fine-grained PAT** limitado a `Contents: write` sobre este
  repo únicamente. Funciona igual de bien sobre HTTPS; la deploy key evita
  tener que rotar un PIN con expiración y es el patrón más estándar para
  automatización single-repo.
- Cualquiera de las dos opciones es una **decisión que el usuario debe
  tomar y provisionar** (crear la key/PAT, agregarla al repo) — no es algo
  que se pueda inferir del código actual. Ver §5.4.

### 2.7 Firmado ECDSA del config (item de seguridad #1 del proyecto)

Hoy `SA_KMS_KEY` **no está seteada en ningún lado** — la Fase 0 (provisionar
el keyring en GCP) y la Fase 2 (republicar la extensión con la pública
embebida) siguen **pendientes y manuales** según
`docs/applets/security-integrity-signing.md` y `docs/deploy-signing-setup.md`.
Es decir: **hoy los deploys (incluidos los del autopilot) NO están firmados**
— `tools/deploy.sh` avisa y deploya sin firma si `SA_KMS_KEY` no existe.

Esto significa que la migración del autopilot **no tiene, hoy, una
dependencia dura de KMS** — puede avanzar sin resolver el firmado. Pero si el
usuario decide completar la Fase 0/2 en paralelo o después, el servidor
necesitará:
- `gcloud` autenticado (vía cuenta de servicio de GCP con su JSON key, o
  Workload Identity Federation si el proveedor cloud lo soporta) con el rol
  `roles/cloudkms.signerVerifier` sobre la llave `config-signing`.
- Esa es una credencial adicional (JSON key de GCP) a resguardar en el mismo
  gestor de secretos del servidor — mismo estándar que el resto (§3, §4.6).

Recomiendo tratar esto como una **fase posterior** (no bloquea la migración
del self-healing) pero dejarlo escrito para que la Fase 0 de KMS, cuando se
haga, incluya de una vez el IAM binding de la cuenta de servicio del
servidor.

### 2.8 Notificación

`autopilot-notify.sh` usa `osascript` + Mail.app — **no funciona** en Linux
headless (Mail.app requiere macOS con sesión gráfica) y tampoco en un Mac
sin usuario logueado en consola. Reemplazo propuesto:

- **Canal primario: `gh issue create`.** Ya existe un patrón idéntico y
  probado en este mismo repo — `tools/notify-stale-hashes.sh` (usado por el
  cron diario `hash-validator-daily`, no por `autopilot-notify.sh`) ya abre
  issues con label `hash-rotation` vía `gh` CLI. Es 100% portable a Linux
  (`gh` es un binario multiplataforma), no depende de sesión gráfica, y
  reusa la MISMA credencial de GitHub que ya necesita el servidor para el
  `git push` del deploy (§2.6) — sin secreto nuevo si se reusa el mismo
  token/gh-auth con scope suficiente (`repo`), o con un token separado si se
  prefiere separar "puede escribir código" de "puede abrir issues"
  (principio de menor privilegio — decisión de diseño, no técnica).
- **Canal secundario (opcional): email por SMTP.** Si se quiere mantener el
  correo como hoy, cambiar `autopilot-notify.sh` de `osascript`/Mail.app a
  `sendmail`/`msmtp`/`smtplib` contra un proveedor SMTP (Gmail con app
  password, o un servicio transaccional tipo Resend/SendGrid en su capa
  gratuita). Requiere una credencial SMTP nueva en el gestor de secretos.
- **`PushNotification` (push al teléfono) NO es portable tal cual.** Es una
  herramienta de una sesión de **Claude Code**, no una API HTTP que un script
  bash pueda invocar de forma independiente. Si se quiere mantener ese canal,
  hace falta decidir si Claude Code también corre en el servidor (ver
  entrelazamiento con el cron diario, §4.7) o si se sustituye por otro
  push (ej. ntfy.sh, ambas gratuitas y con API HTTP simple) — pendiente en
  §5.6.
- **Recomendación adicional (dead-man's-switch):** un heartbeat externo
  (ej. healthchecks.io, capa gratuita) que el wrapper hace `curl` al final de
  cada corrida exitosa. Si el heartbeat no llega dentro de la ventana
  esperada, el PROVEEDOR avisa por su cuenta — así se cierra el hueco de
  "¿quién nota que el propio sistema de notificación se calló?", que es
  justo lo que pasó el 13-jul (nadie se enteró de que el validador corrió a
  ciegas hasta revisar el JSON días después).

---

## 3. Requisitos técnicos (checklist)

### Sistema operativo y cómputo
- [ ] Servidor Linux always-on decidido y aprovisionado (Ubuntu 22.04/24.04
      LTS o Debian 12 recomendado) — **pendiente decisión del usuario (§5.1)**
- [ ] Acceso administrativo (SSH con llave, no password) para setup inicial
- [ ] Al menos 1-2 vCPU / 2 GB RAM / 10+ GB disco (Chromium + navegador +
      node_modules + logs)
- [ ] IP estática o hostname estable (facilita cualquier allow-list futura
      del lado de Steelhead, y hace el troubleshooting reproducible)
- [ ] Reloj sincronizado (NTP) — el gate por release y el timer de systemd
      dependen de hora correcta

### Runtime
- [ ] Node.js 20 LTS o 22 LTS instalado (`node --version`)
- [ ] `npm install` en `tools/hash-autopilot/` (dependencia única:
      `playwright ^1.57.0`)
- [ ] `npx playwright install --with-deps chromium` — instala el navegador Y
      los paquetes `apt` que Chromium necesita en Linux (nuevo vs. macOS)
- [ ] Python 3.10+ instalado, con `pip install requests` (o el
      `requirements.txt` que use `steelhead_client.py`/su versión vendida)
- [ ] `git` instalado y configurado (usuario/email del commit del deploy)
- [ ] `gh` CLI instalado y autenticado (`gh auth login` con el token
      correspondiente) — necesario para el canal de notificación por issue
- [ ] `curl` disponible (usado por el wrapper para `GET /version.json`)

### Red / DNS
- [ ] Egress HTTPS (443) permitido hacia: `app.gosteelhead.com` (GraphQL +
      SPA + `/version.json`), `auth.gosteelhead.com` (Authentik, refresh
      OAuth), `github.com`/`api.github.com` (push + `gh issue create`)
- [ ] Resolver DNS confiable configurado explícitamente (ej. `1.1.1.1` /
      `8.8.8.8` en `/etc/resolv.conf` o vía el proveedor cloud) — el fallo
      del 13-jul fue justo una falla de resolución DNS; no asumir que el
      DNS default del proveedor es suficiente sin verificarlo
- [ ] `network-online.target` verificado como dependencia real en el
      `.service` (que el timer no dispare antes de que la red esté lista)

### Secretos y credenciales
- [ ] Usuario Linux dedicado, sin privilegios de login interactivo amplio
      (ej. `svc-hashautopilot`), dueño del proceso y de los archivos de
      secretos
- [ ] Directorio de secretos fuera del repo git, `chmod 700`, archivos
      `chmod 600` (refresh token / token cache del servidor — ver §2.5)
- [ ] Refresh token propio del servidor sembrado manualmente (no compartido
      con el de la laptop/`Reportes SH` — ver riesgo #1, §4.1)
- [ ] Credencial de git para push: SSH deploy key con write access **o**
      fine-grained PAT `Contents: write`, scopeada a este repo (§2.6)
- [ ] `gh auth` con token con permiso de `issues: write` sobre el repo (puede
      ser el mismo que el de arriba o uno separado — decisión de diseño)
- [ ] (Si se activa firmado KMS más adelante) credencial de GCP con rol
      `roles/cloudkms.signerVerifier` — ver §2.7
- [ ] Ningún secreto commiteado al repo ni impreso en logs (regla ya vigente
      en el proyecto — "nunca se loguea el valor de los tokens")

### Agendado y observabilidad
- [ ] `hash-autopilot.service` + `hash-autopilot.timer` instalados y
      habilitados (`systemctl enable --now hash-autopilot.timer`)
- [ ] Logs accesibles (`journalctl -u hash-autopilot`) y/o espejados a
      `tools/.hash-autopilot/*.log` como hoy
- [ ] Heartbeat/dead-man's-switch configurado (recomendado, §2.8)
- [ ] Alerta si el servicio falla repetidamente (`systemd` soporta
      `OnFailure=` para disparar una unidad de notificación)

---

## 4. Riesgos y mitigaciones

### 4.1 RIESGO #1 (el más grande): auth headless persistente sin login interactivo

**El problema de fondo.** El flujo de auth actual asume implícitamente una
laptop donde un humano ya se logueó alguna vez en Steelhead con su cuenta
personal, y desde ahí todo vive de refrescar ese mismo refresh token para
siempre. Eso funciona mientras:
(a) el refresh token se use con la frecuencia suficiente para no expirar por
inactividad, y
(b) **nadie más lo use en paralelo**, porque Authentik lo **rota en cada
uso** (`refresh_access_token` en `steelhead_auth.py` reemplaza el refresh
token viejo por uno nuevo en cada llamada) — si dos procesos refrescan "al
mismo tiempo" con el mismo refresh token de partida, el segundo en llegar
recibe `invalid_grant` porque el primero ya lo invalidó.

Hoy ya existe una versión leve de este problema **dentro de la misma
laptop**: `Reportes SH/.cache/tokens.json` es compartido por
`hash-autopilot`, `validate-hashes.py`, el cron diario
`hash-validator-daily`, y cualquier script de `Reportes SH` (DuckDB refresh,
report-sync). Si el servidor migrado usa **una copia** de ese mismo refresh
token en vez de uno propio, se **multiplica** el riesgo de colisión: ahora
dos máquinas físicas distintas (laptop + servidor) refrescan de forma
independiente, sin ningún lock compartido entre ellas — es solo cuestión de
tiempo hasta que ambas intenten refrescar en la misma ventana y una invalide
a la otra, produciendo un `authFailed` que, en el servidor, nadie está
mirando en tiempo real.

**Opciones evaluadas:**

| Opción | Descripción | Pros | Contras |
|---|---|---|---|
| **A. Refresh token propio y dedicado del servidor** (recomendada) | El servidor tiene su PROPIO `tokens.json`/`.env`, sembrado una vez con un refresh token capturado de una sesión real, y NUNCA comparte ese refresh token con la laptop. Se refresca solo desde el servidor. | Elimina la condición de carrera por completo — un solo escritor por token. No requiere que Steelhead soporte nada especial (usa el mismo mecanismo OAuth público que ya existe). | Sigue atado a la identidad de la persona cuya sesión originó el refresh token (no es una "cuenta de servicio" real de Steelhead) — si esa cuenta se desactiva o cambia de password, el refresh se revoca igual. Requiere re-sembrar manualmente si Authentik alguna vez fuerza un re-login completo (ej. política de expiración absoluta del lado del IdP, no solo por rotación). |
| **B. Cuenta de servicio dedicada en Steelhead/Authentik** | Si Steelhead soporta un usuario tipo "service account" (no ligado a una persona), crear uno solo para el autopilot, con permisos mínimos (idealmente solo lectura sobre lo que hace falta para las queries `vigente`/`rotadoValidado`, aunque las mutations sentinela SÍ necesitan permisos de escritura sobre los objetos "Sentinela"). | Desacopla el sistema de automatización de la identidad de una persona — sobrevive a que el usuario cambie de password o se vaya. Más alineado con buenas prácticas de automatización productiva. | **No sabemos si Steelhead/Authentik expone esto.** Requiere confirmarlo con soporte de Steelhead o probarlo (crear usuario, ver si Authentik permite un client-credentials grant o un usuario sin MFA/sin expiración de sesión distinta). Es trabajo de descubrimiento antes de poder ejecutar esta opción — no se puede asumir que existe. |
| **C. Cookie de sesión de larga duración** | En vez de OAuth/ROCP, usar `STEELHEAD_COOKIE_STRING` (Modo A de `steelhead_auth.py`) con una cookie capturada manualmente. | Ya existe como fallback en el código (`get_cookie_string`). Evita la complejidad de rotación de refresh token para el CLIENTE PYTHON (`validate-hashes.py`). | **No resuelve el problema para el motor Playwright**, que necesita simular login REAL del SPA (inyecta tokens ROCP en `localStorage`, no cookies) — la cookie sola no basta para que el frontend cargue autenticado. Las cookies de sesión web típicamente expiran más rápido y sin mecanismo de auto-renovación (a diferencia del refresh token OAuth) — probablemente empeora, no mejora, la persistencia headless. |

**Recomendación:** Opción A como punto de partida pragmático (no requiere
nada nuevo de Steelhead, solo disciplina operativa de "un solo dueño por
refresh token"), **investigando en paralelo** si la Opción B (cuenta de
servicio) existe — sería la solución estructuralmente correcta a mediano
plazo. Ver pregunta abierta §5.2.

**Mitigación adicional, independiente de la opción elegida:** el wrapper YA
implementa (desde 2026-07-15) "fail RUIDOSO, no silencioso" — si el refresh
falla, notifica y no abre el navegador en vez de fingir un `authFailed`
genérico. Ese patrón debe preservarse íntegro en el servidor, y reforzarse
con el heartbeat de §2.8 para que un `authFailed` recurrente dispare alerta
incluso si el canal de notificación normal también falla.

### 4.2 Notificación no portable (Mail.app/osascript)

**Riesgo:** silencio total en fallas si no se reemplaza antes de apagar el
job de la laptop. **Mitigación:** cambio de canal descrito en §2.8
(`gh issue create` como primario) — **debe estar validado en vivo ANTES**
de la Fase 3 (cortar la laptop), no después.

### 4.3 `git push` a `gh-pages` sin credenciales portables

**Riesgo:** el deploy automático del hash rotado es el corazón del
"self-healing" — si el servidor no puede hacer push, el sistema solo
detecta pero ya no repara solo, perdiendo la mitad del valor. **Mitigación:**
deploy key SSH o PAT fine-grained, aprovisionado ANTES de mover el cron
(§2.6, decisión pendiente en §5.4). Verificar también que
`autopilot-deploy.sh` — que exige rama `main` sin WIP ajeno en `remote/` —
siga siendo seguro con un `checkout` limpio y dedicado en el servidor (no
comparte worktree con las sesiones de desarrollo de la laptop, así que la
salvaguarda "sin WIP ajeno" debería cumplirse trivialmente ahí, pero
conviene un checkout **read+write exclusivo** del servidor, no un clone
compartido).

### 4.4 Firmado KMS (dependencia futura, no actual)

**Riesgo:** si se activa la Fase 0/2 de firmado ECDSA sin haber dado acceso
IAM al servidor, los deploys del autopilot empezarían a fallar (o a deployar
sin firma si `deploy.sh` degrada de forma silenciosa — **confirmar ese
comportamiento exacto antes de activar KMS con el autopilot ya migrado**).
**Mitigación:** tratar como fase posterior explícita (§2.7); cuando se
provisione KMS, incluir de una vez el IAM binding para la identidad que usa
el servidor.

### 4.5 Dependencia cruzada de repo (`Reportes SH`)

**Riesgo:** tanto `validate-hashes.py` como `hash-autopilot.mjs` dependen HOY
de rutas absolutas hacia `/Users/oviazcan/Projects/Ecoplating/Reportes SH`
— un repo git **distinto**, que no está pensado para vivir en un servidor de
automatización (tiene archivos `.duckdb` de cientos de MB, es el proyecto de
reportes, no de esta extensión). Migrar sin resolver esto obligaría a clonar
un repo entero ajeno al servidor solo para tomar prestado un cliente HTTP.
**Mitigación:** vendorizar/copiar la porción mínima de auth (§2.5, opción 1)
dentro de `SteelheadAutomator` — decisión de diseño que además resuelve de
raíz el riesgo #1 (deja de compartir el token cache).

### 4.6 Gestión de secretos en un servidor remoto (superficie nueva)

**Riesgo:** hoy los secretos viven en el filesystem de una laptop personal
bajo el control físico directo del usuario. Moverlos a un servidor remoto
(sobre todo si es un VPS de terceros) agrega superficie: acceso SSH
comprometido, backups del proveedor que incluyan el `.env`, logs que
accidentalmente impriman un token. **Mitigación:** usuario dedicado sin
privilegios amplios, permisos de archivo estrictos, SSH solo con llave
(nunca password), y mantener la disciplina ya vigente en el proyecto de
"nunca loguear el valor de los tokens" — auditar que ningún log de systemd
capture el `tokens.json` completo.

### 4.7 Entrelazamiento con el cron diario `hash-validator-daily` (Claude Code)

**Riesgo no obvio, descubierto al leer el skill `steelhead-hash-validator`:**
existe un SEGUNDO sistema, hoy separado del `hash-autopilot`, que también
corre `validate-hashes.py` — un cron de Claude Code (`CronCreate`,
lun-vie 8:03am, auto-expira a 7 días) que detecta (no repara) y notifica por
`gh issue` + Mail.app + `PushNotification`. Comparte el mismo
`validate-hashes.py`, la misma dependencia de auth de `Reportes SH`, y
potencialmente el mismo refresh token. Si el `hash-autopilot` se muda al
servidor pero este cron diario se queda en la laptop (corriendo dentro de
una sesión de Claude Code), **se reintroduce exactamente la condición de
carrera del riesgo #1** — dos consumidores independientes del mismo refresh
token, ahora en máquinas distintas. Además, ese cron es él mismo un
candidato al mismo problema de fondo (depende de que la laptop tenga Claude
Code corriendo a las 8:03am). **Mitigación:** esto no se resuelve dentro de
este documento (está fuera de alcance declarado), pero se deja escrito como
decisión pendiente — ver §5.7.

---

## 5. Preguntas abiertas para el usuario

### Decisiones tomadas (2026-07-15)

- **§5.1 Servidor:** EQUIPO FÍSICO DEDICADO (no VPS). Pendiente definir CUÁL
  equipo y su SO (Mac mini → sigue con `launchd`; mini-PC Linux → `systemd`).
- **§5.2 Auth:** REFRESH TOKEN DEDICADO DEL SERVIDOR (Opción A) — el equipo
  tiene su propio token, nunca compartido con la laptop. Elimina la carrera.
- **§5.7 Cron diario `hash-validator-daily`:** SE APAGA. Aclaración de
  arquitectura: NO son dos sistemas por diseño sino por historia — el
  `hash-validator-daily` (cron de Claude, solo detecta+notifica) es REDUNDANTE
  hoy porque el `hash-autopilot` ya corre el validador embebido (Capa 2) Y
  además repara. La meta del usuario ("un solo cron, todo migrado") se cumple
  migrando SOLO el `hash-autopilot` (que es el completo) y apagando el viejo →
  UN solo sistema autónomo en el servidor, sin duplicación ni carrera de token.

### Pendientes

Estas son decisiones que Claude no puede tomar por su cuenta — necesitan tu
criterio de negocio/operación antes de planear la implementación:

1. **¿Qué servidor?** ¿Prefieres un VPS cloud (pagado, ej. $5-10 USD/mes,
   con SLA de uptime) o un equipo físico dedicado (Mac mini/mini-PC en
   oficina/casa, costo cero recurrente pero sujeto a luz/WiFi locales — el
   mismo tipo de riesgo que estamos tratando de eliminar, solo que en otra
   ubicación)? Si es un equipo físico, ¿tiene UPS y conexión cableada?

2. **¿Existe (o se puede crear) una cuenta de servicio en Steelhead/Authentik**
   distinta de tu cuenta personal, para que el refresh token del servidor no
   dependa de tu login individual? Si no lo sabes, ¿autorizas que se
   investigue/pregunte a soporte de Steelhead, o prefieres avanzar de una vez
   con la Opción A (refresh token dedicado pero atado a tu identidad) y
   revisar esto después?

3. **¿Tienes acceso para provisionar** una deploy key SSH o un fine-grained
   PAT en el repo `oviazcan/SteelheadAutomator` de GitHub? (Necesario para
   que el servidor pueda hacer `git push` a `gh-pages`.)

4. **Deploy key SSH vs. PAT fine-grained** — ¿alguna preferencia, o delego
   la elección a la recomendación de este documento (deploy key, §2.6)?

5. **KMS de firmado (Fase 0/2, `security-integrity-signing`)**: ¿quieres que
   la migración del autopilot espere/coordine con esa Fase 0, o avanzan en
   paralelo sin dependencia (recomendación de este doc — §2.7)?

6. **Notificación:** ¿mantenemos email como canal (requiere credencial SMTP
   nueva) o basta con `gh issue create` + el heartbeat externo? Si quieres
   mantener el push al teléfono (`PushNotification`), ¿aceptas que eso
   implique correr Claude Code también en el servidor (o monitorearlo desde
   la laptop), o prefieres sustituirlo por un servicio de push HTTP simple
   (ej. ntfy.sh)?

7. **El cron diario `hash-validator-daily`** (Claude Code, separado del
   autopilot) — ¿se queda en la laptop tal cual, se apaga (si el
   `hash-autopilot` en el servidor ya cubre esa detección), o también se
   migra? Esto afecta directamente el riesgo #1 (§4.1, §4.7) — si ambos
   sistemas van a existir en paralelo, necesitan un refresh token separado
   cada uno desde el día uno.

8. **Presupuesto/tiempo:** ¿hay urgencia de fecha, o el plan por fases de §6
   puede tomarse con calma (validando cada fase antes de avanzar, como ya es
   costumbre en este proyecto)?

---

## 6. Plan de migración por fases

El criterio rector: **nunca apagar la laptop hasta que el servidor haya
demostrado, con evidencia real (no solo "debería funcionar"), que detecta Y
repara una rotación real de principio a fin.**

### Fase 0 — Provisionar (sin tocar el sistema en producción)
- Decidir y levantar el servidor (§5.1).
- Instalar runtime: Node, Python, `git`, `gh` CLI, Chromium+deps de
  Playwright (§3).
- Crear usuario dedicado + estructura de secretos (§4.6).
- Clonar `SteelheadAutomator` en el servidor (checkout dedicado, propio,
  no compartido con la laptop).
- **No agendar nada todavía.** El objetivo de esta fase es solo "el
  software corre a mano en el servidor sin tronar por falta de dependencias".

### Fase 1 — Auth y deploy standalone
- Resolver la dependencia cruzada de `Reportes SH` (§4.5): vendorizar la
  porción mínima de auth dentro de `SteelheadAutomator`.
- Sembrar el refresh token dedicado del servidor (§4.1, opción A) — o el de
  la cuenta de servicio si §5.2 se resuelve a tiempo.
- Provisionar la credencial de deploy (§2.6, según respuesta a §5.3/§5.4).
- Correr `hash-autopilot.mjs --dry-run` a mano en el servidor y confirmar
  que autentica, navega y clasifica sin usar NADA de la laptop.
- Correr un deploy real controlado (op de prueba, no una rotación real) para
  validar que `autopilot-deploy.sh` → `deploy.sh` completa el push desde el
  servidor.

### Fase 2 — Correr en paralelo (laptop + servidor)
- Agendar el `systemd timer` en el servidor (§2.4), **pero dejar el
  `launchd` de la laptop encendido también** — ambos corriendo en paralelo
  durante un periodo de observación (mínimo 1-2 semanas, o hasta ver pasar
  al menos una rotación real de hash).
- **Ojo:** durante esta fase el riesgo #1 (§4.1) está activo por diseño (dos
  sistemas, dos refresh tokens si se siguió la recomendación — verificar que
  efectivamente sean independientes y no el mismo).
- Comparar los resultados de ambos (`tools/.hash-autopilot/<fecha>.json` de
  cada lado) — deben coincidir en clasificación. Cualquier divergencia se
  investiga antes de continuar.
- Validar el canal de notificación nuevo (`gh issue create` + heartbeat) en
  vivo, con una rotación real o simulada.

### Fase 3 — Cortar la laptop
- Solo después de que la Fase 2 haya demostrado paridad y al menos un ciclo
  completo de detección+reparación exitoso desde el servidor:
  - `launchctl unload` + eliminar
    `~/Library/LaunchAgents/com.ecoplating.steelhead-hash-autopilot.plist`
    de la laptop.
  - Decidir sobre el cron diario `hash-validator-daily` (§5.7) — si se
    apaga, se apaga explícitamente, no por omisión.
  - Actualizar `tools/hash-autopilot/README.md` y el índice de applets en
    `CLAUDE.md` para reflejar que la ejecución vive en el servidor (path,
    cómo revisar logs remotos, cómo re-sembrar el refresh token si se cae).
  - Documentar el runbook de "qué hacer si el servidor se cae" (a quién
    avisa el heartbeat, cómo se reinicia el servicio, cómo se re-siembra
    auth) — el mismo tipo de fragilidad que motivó este documento no debe
    reaparecer sin que nadie se entere, ahora en la nueva máquina.
