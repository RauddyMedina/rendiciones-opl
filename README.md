# Control de Rendiciones OPL

**App web (PWA) para que los bodegueros rindan desde el celular lo que vuelve a bodega al cierre
del día**: qué órdenes retornaron, en qué estado, con cuántos bultos y con respaldo fotográfico.
Reemplazó un proceso de papel y mensajes de WhatsApp por un registro trazable y auditable.

🔗 **Demo en vivo:** https://rauddymedina.github.io/rendiciones-opl/

> **English summary** — A field-data-capture PWA for last-mile warehouse workers in Chile. At the
> end of each shift, a worker picks their vehicle plate, goes order by order recording status,
> package count and damage photos, and submits. Static front-end on GitHub Pages, Google Apps
> Script as the backend, Google Sheets as the database, and a **private** GitHub repo as the photo
> store. Vanilla JS, single file, no build step. The engineering worth reading is in
> **Decisiones de ingeniería**: chunked uploads that stopped low-end phones from freezing,
> server-side deduplication that makes any retry safe, and IndexedDB drafts that survive a refresh
> or a crash mid-shift.

---

## El problema

Al cierre del día, cada camión vuelve a bodega con productos que no se entregaron: rechazos,
domicilios cerrados, retiros que no se pudieron hacer, mercadería dañada en el trayecto. Alguien
tiene que dejar registro de **qué volvió, en qué estado y con qué respaldo**, porque de eso
dependen los cobros al cliente y las disputas por daños.

Eso se hacía en papel y por WhatsApp: fotos sueltas en un grupo, planillas escritas a mano, y al
día siguiente nadie podía reconstruir qué pasó con una orden puntual. La app cierra ese hueco: el
bodeguero rinde desde su propio teléfono y todo queda en una planilla con las fotos enlazadas.

---

## Flujo de uso

```
1. Login por nombre (queda registrado quién rindió)
        ↓
2. Elegir la patente del camión
        ↓
3. Seleccionar las órdenes que volvieron
        ↓
4. Por cada orden:
     ✅ Todo OK        → cantidad de bultos
     ⚠️  Con Daños      → tipo de daño + fotos obligatorias
     ↩️  No Retirado    → solo en órdenes de retiro; se confirma sin foto ni bultos
     🚨 No rendido     → pinta la fila roja en la planilla para revisión del jefe
        ↓
5. Si hubo daños → foto obligatoria de la hoja de ruta como respaldo
        ↓
6. "Enviar todas" → recibo en pantalla:
     "✅ Registrado y verificado en el sistema"
```

Las órdenes ya confirmadas se pueden **reabrir y corregir** (con sus fotos y valores precargados) o
quitar antes de enviar, y un banner avisa si quedan órdenes confirmadas sin enviar antes de cambiar
de patente. La app también se **cierra sola los domingos**, con una lista de fechas de excepción
configurable para los domingos que sí se trabaja.

---

## Arquitectura

```
┌────────────────────────────────┐                  ┌────────────────────────────────┐
│  PWA estática (este repo)      │   POST rendición │  Google Apps Script            │
│  GitHub Pages · repo PÚBLICO   │ ───────────────▶ │  doPost() + LockService        │
│                                │                  │  · dedup fecha+patente+ID      │
│  · IndexedDB (borradores)      │ ◀─────────────── │  · escribe en el Sheet         │
│  · compresión de fotos         │   GET verificar  │  · sube fotos a GitHub         │
│  · envío por tandas            │                  └────────┬──────────────┬────────┘
└────────────────────────────────┘                           │              │
                                                             ▼              ▼
                                        ┌────────────────────────┐  ┌──────────────────────┐
                                        │  Google Sheets         │  │  repo PRIVADO        │
                                        │  Historial_Rendiciones │  │  rendiciones-fotos   │
                                        │  (+ link "Ver fotos")  │  │  registros/fecha/... │
                                        └────────────────────────┘  └──────────────────────┘
```

### Por qué dos repositorios

GitHub Pages gratuito exige que el repo sea **público**. Pero las fotos de una rendición son
material operativo del cliente y no pueden quedar indexadas en internet. La solución fue separar:

- `rendiciones-opl` (**público**) → solo la app. Es lo que estás viendo.
- `rendiciones-fotos` (**privado**) → las imágenes y un `data.json` por orden, escritos por el
  Apps Script vía la API de GitHub. Abrir el link "Ver fotos" de la planilla exige estar
  autenticado en GitHub como colaborador del repo privado.

```
rendiciones-fotos/ (privado)
└── registros/
    └── 2026-04-28/
        └── KLDS81/
            └── 1757757901/
                ├── data.json
                ├── foto1.jpg
                └── foto2.jpg
```

---

## Decisiones de ingeniería

Casi todas estas decisiones salieron de un incidente real en producción, no de una pizarra.

### 1. Envío por tandas, porque un solo POST grande congelaba los teléfonos

Una rendición de 8 órdenes con fotos son varios MB. Serializar y URL-encodear eso en un único
`form POST` **bloquea el hilo principal** en un teléfono de gama baja: la app se quedaba "pegada en
Enviando…", el bodeguero refrescaba, y perdía todo el trabajo del día.

`partirEnTandas()` divide el envío en POSTs de **≤ ~2,5 MB de fotos**. Cada tanda:

- se manda por `form POST` en un iframe (dispara el POST sin bloquear la UI),
- se **verifica por separado** con un `GET &ids=a,b,c` que sondea cada 2 s,
- si no verifica, se **reenvía una vez** (seguro gracias al punto 2),
- y si aun así falla, aparece un botón **"🔄 Reintentar envío"** que reanuda desde esa tanda, no
  desde cero.

### 2. Deduplicación en el servidor: lo que hace seguro reintentar

Un reintento automático es una mala idea si el servidor no es idempotente. El 12-06 una rendición
quedó con **6 filas duplicadas** porque la verificación falló en el teléfono y el fallback reenvió
el payload completo.

El arreglo fue del lado del servidor, no del cliente: `doPost()` toma un `LockService` para
serializar envíos concurrentes y **ignora toda orden que ya tenga fila con la misma
fecha + patente + ID**, respondiendo `{ok: true, dedup: true}` si estaban todas guardadas. A partir
de ahí, reenviar es inofensivo — y eso es lo que permite que el fallback, el reintento por tanda y
el "volver a enviar después de refrescar" existan sin miedo.

### 3. Borrador persistente en IndexedDB: el avance sobrevive a un refresh

Cada vez que el bodeguero confirma una orden, el avance completo —**fotos incluidas**— se guarda en
IndexedDB bajo la clave `fecha::patente`. Si refresca la página o el teléfono se cuelga, al volver
a entrar con la misma patente el mismo día la app pregunta **"¿Continuar donde quedaste?"** y
restaura todo.

Los detalles que importan: solo se restauran órdenes que **sigan pendientes** en la planilla (las ya
registradas vienen filtradas desde el `doGet`), el borrador se borra **solo cuando la rendición
queda verificada** en el Sheet, y los borradores de días anteriores se purgan al abrir la app.

### 4. Pintar el recibo primero, hacer el trabajo pesado después

`mostrarExito()` dibuja la pantalla de recibo **de inmediato**, luego `cederHilo()` deja al
navegador repintar, y recién ahí arranca `enviarPostGAS()` en segundo plano. El estado del recibo
se va actualizando en vivo ("enviando" → "verificado"). Para el bodeguero la app responde al
instante; el trabajo lento ocurre detrás y solo interrumpe si algo falla de verdad.

### 5. Un commit por tanda, no uno por foto

La primera versión hacía un commit a GitHub por cada archivo, en secuencia. Con 9 órdenes × 4 fotos
eran 36 commits encadenados y el script se acercaba al **límite de 6 minutos de ejecución de Apps
Script** — resultado: "colgado en enviando". Ahora los blobs se crean en paralelo con
`UrlFetchApp.fetchAll()` en lotes de 5 y todos los archivos de la tanda entran en **un solo commit**.

### 6. Compresión de fotos en el cliente

Antes de salir del teléfono, cada foto pasa por `compressPhoto()`: se escala a 1200 px en el lado
mayor y se reencoda como JPEG al 75 %. Menos datos móviles del bodeguero, tandas más chicas y
menos riesgo de topar el límite de payload del Apps Script.

### 7. Self-test que corre al abrir la app

`correrSelfTest()` ejecuta un set de asserts en cada arranque sobre la lógica que más duele si se
rompe en silencio: la detección de órdenes dañadas (que decide si se pide la foto de hoja de ruta)
y `construirSubPayload()` (que la foto de hoja de ruta viaje solo en la tanda 0 pero el flag en
todas). Si algo falla, se ve al instante en vez de descubrirse con una rendición perdida.

---

## Modelo de seguridad

Vale la pena ser explícito, porque el código está a la vista:

**`GAS_URL` y `GAS_SECRET` están embebidos en el `index.html` público.** No es un descuido, es la
consecuencia de la arquitectura: GitHub Pages sirve archivos estáticos y no hay backend propio
donde esconder nada — cualquier valor que el navegador necesite para hablar con el Apps Script es,
por definición, público. Sacarlo a un `config.js` en `.gitignore` no lo hace más seguro; solo hace
que la app deje de funcionar al desplegarla.

Lo que sí se hizo fue **acotar el daño**:

- El `GAS_SECRET` es un token compartido de **bajo privilegio**: solo habilita escribir rendiciones
  del día en una planilla concreta. No da acceso a lectura masiva, ni a otras hojas, ni a borrar.
- El **token de GitHub** que sube las fotos al repo privado vive en las *Script Properties* del
  Apps Script y **nunca llega al cliente**. El navegador jamás lo ve.
- Las fotos quedan en un repo **privado**; el link de la planilla exige sesión de GitHub.
- El backend corre bajo la cuenta del dueño del Sheet, no bajo la del bodeguero.

**Qué haría distinto con presupuesto de servidor:** un proxy propio delante del Apps Script, con
autenticación por usuario (no un secreto compartido), rate limiting y rotación de token. Para esta
operación —usuarios conocidos, red interna, dato de bajo valor fuera de contexto— el costo de esa
infraestructura no se justificaba frente al riesgo real.

> **Nota sobre `gas-script.js`:** el archivo del repo es una versión **antigua** del backend, que se
> dejó como referencia del diseño inicial. El backend en producción evolucionó bastante (tandas,
> dedup, `LockService`, subida en lote a GitHub) y vive en el proyecto de Apps Script, fuera de
> este repositorio.

---

## Stack

- **Front-end:** HTML + CSS + JavaScript vanilla en un solo archivo (~3.300 líneas). Sin framework,
  sin bundler, sin build step.
- **Persistencia local:** IndexedDB (borradores con fotos) + `localStorage` (sesión, fechas de
  excepción).
- **Backend:** Google Apps Script — `doGet`/`doPost`, `LockService`, `UrlFetchApp.fetchAll`.
- **Base de datos:** Google Sheets (pestaña `Historial_Rendiciones`).
- **Almacenamiento de fotos:** GitHub Contents/Git API sobre un repositorio privado.
- **Deploy:** GitHub Pages (automático al hacer push a `main`).

## Estructura

| Archivo | Qué es |
|---|---|
| `index.html` | La app completa: UI, cámara/fotos, IndexedDB, tandas de envío, verificación |
| `gas-script.js` | Versión inicial del backend de Apps Script, dejada como referencia |
