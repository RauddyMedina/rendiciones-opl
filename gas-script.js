// ═══════════════════════════════════════════════════════════════
// GOOGLE APPS SCRIPT — Control de Rendiciones OPL
// ═══════════════════════════════════════════════════════════════
//
// INSTRUCCIONES DE DEPLOY:
// 1. Abre script.google.com → Nuevo proyecto
// 2. Pega este código (reemplaza todo lo que hay)
// 3. En el menú: Proyecto → Propiedades del script
//    Agrega estas propiedades en "Script Properties":
//      GITHUB_TOKEN  = tu_personal_access_token_de_github
//      GITHUB_REPO   = usuario/nombre-del-repo  (ej: rauddy/rendiciones-opl)
// 4. Despliega: Implementar → Nueva implementación
//    Tipo: Aplicación web
//    Ejecutar como: Yo (tu cuenta Google)
//    Acceso: Cualquier persona
// 5. Copia la URL generada → pégala en el HTML como GAS_URL
// ═══════════════════════════════════════════════════════════════

const SHEET_ID   = '1tHffZ6xU7dBuqS4w0vPW6H8tBy76uUBCu-XylrylZZo';
const TAB_ORIGEN = 'rendiciones';        // pestaña donde el jefe carga los datos
const TAB_HISTORIAL = 'Historial_Rendiciones'; // pestaña donde se guardan los resultados

// ── doGet: lee la pestaña rendiciones y retorna JSON ──────────
function doGet(e) {
  try {
    const ss    = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(TAB_ORIGEN);

    if (!sheet) {
      return jsonResponse({ error: 'Pestaña "rendiciones" no encontrada' }, 404);
    }

    const data    = sheet.getDataRange().getValues();
    const result  = {};
    let filasDatos = 0;

    // Columnas confirmadas (fila 1 = encabezados):
    // A=ID, B=fecha, C=patente, D=SUBESTADO, E=producto, F=QUIEN_VUELVE
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const id        = String(row[1] || '').trim();
      const patente   = String(row[3] || '').trim().toUpperCase();
      const subestado = String(row[4] || '').trim();
      const producto  = String(row[5] || '').trim();

      if (!id || !patente) continue; // saltar filas vacías

      if (!result[patente]) result[patente] = [];
      result[patente].push({ id, subestado, producto });
      filasDatos++;
    }

    // Filtrar patentes ya rendidas hoy
    const hoy = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const histSheet = ss.getSheetByName(TAB_HISTORIAL);
    if (histSheet && histSheet.getLastRow() > 1) {
      const hist = histSheet.getDataRange().getValues();
      for (let i = 1; i < hist.length; i++) {
        const fechaHist   = String(hist[i][1]).slice(0, 10); // col B = Fecha
        const patenteHist = String(hist[i][3]).trim().toUpperCase(); // col D = Patente
        if (fechaHist === hoy && result[patenteHist]) {
          delete result[patenteHist];
        }
      }
    }

    // Agregar metadata útil
    const meta = {
      total: filasDatos,
      patentes: Object.keys(result).length,
      timestamp: new Date().toISOString()
    };

    return jsonResponse({ data: result, meta });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ── doPost: recibe rendición, guarda en Sheet y GitHub ────────
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // 1. Guardar en la pestaña Historial_Rendiciones
    const props = PropertiesService.getScriptProperties();
    const repo  = props.getProperty('GITHUB_REPO');
    guardarEnHistorial(payload, repo);

    // 2. Subir datos + fotos a GitHub
    subirAGitHub(payload);

    return jsonResponse({ ok: true });

  } catch (err) {
    // Loguear el error para debugging
    console.error('doPost error:', err.message);
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// ── Escribe en la pestaña Historial_Rendiciones ───────────────
function guardarEnHistorial(payload, repo) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(TAB_HISTORIAL);

  // Crear la pestaña si no existe
  if (!sheet) {
    sheet = ss.insertSheet(TAB_HISTORIAL);
    const headers = [
      'Timestamp', 'Fecha', 'Bodeguero', 'Patente',
      'ID Orden', 'Producto', 'Subestado Original',
      'Estado Producto', 'Estado OK (sin daño)', 'Tipo Daño',
      'Cantidad Total', 'Cant. Dañadas', 'Cant. OK',
      'Bultos', 'Observación', 'Cant. Fotos', 'Ruta GitHub'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // Una fila por orden
  const rows = payload.ordenes.map(o => {
    const carpeta = `registros/${payload.fecha}/${payload.patente}/${o.id}`;
    const rutaGH = repo
      ? `https://github.com/${repo}/tree/main/${carpeta}`
      : carpeta;
    return [
      payload.timestamp,
      payload.fecha,
      payload.bodeguero,
      payload.patente,
      o.id,
      o.producto,
      o.subestado,
      o.estadoProducto,
      o.estadoOK || '',
      o.tipoDano || '',
      o.cantidad || 1,
      o.cantidadDanados || 0,
      o.cantidadOK !== undefined ? o.cantidadOK : (o.cantidad || 1),
      o.bultos,
      o.observacion || '',
      o.fotos ? o.fotos.length : 0,
      rutaGH
    ];
  });

  if (rows.length > 0) {
    const lastRow = sheet.getLastRow();
    const startRow = lastRow + 1;
    const numCols = rows[0].length;
    // Escribir todas las columnas excepto la última (Ruta GitHub)
    const rowsSinRuta = rows.map(r => r.slice(0, numCols - 1));
    sheet.getRange(startRow, 1, rows.length, numCols - 1).setValues(rowsSinRuta);
    // Escribir Ruta GitHub como fórmula HYPERLINK si es URL completa
    rows.forEach((r, i) => {
      const ruta = r[numCols - 1];
      const cell = sheet.getRange(startRow + i, numCols);
      if (ruta.indexOf('http') === 0) {
        const rich = SpreadsheetApp.newRichTextValue()
          .setText('Ver fotos')
          .setLinkUrl(ruta)
          .build();
        cell.setRichTextValue(rich);
      } else {
        cell.setValue(ruta);
      }
    });
  }
}

// ── Sube archivos al repositorio GitHub ───────────────────────
function subirAGitHub(payload) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo  = props.getProperty('GITHUB_REPO'); // ej: "rauddy/rendiciones-opl"

  if (!token || !repo) {
    console.warn('GITHUB_TOKEN o GITHUB_REPO no configurados en Script Properties');
    return;
  }

  payload.ordenes.forEach(orden => {
    const basePath = `registros/${payload.fecha}/${payload.patente}/${orden.id}`;

    // data.json — sin las fotos (las fotos van aparte)
    const dataObj = {
      timestamp:        payload.timestamp,
      fecha:            payload.fecha,
      bodeguero:        payload.bodeguero,
      patente:          payload.patente,
      id:               orden.id,
      producto:         orden.producto,
      subestado:        orden.subestado,
      estadoProducto:   orden.estadoProducto,
      estadoOK:         orden.estadoOK || '',
      tipoDano:         orden.tipoDano || '',
      cantidad:         orden.cantidad || 1,
      cantidadOK:       orden.cantidadOK !== undefined ? orden.cantidadOK : (orden.cantidad || 1),
      cantidadDanados:  orden.cantidadDanados || 0,
      bultos:           orden.bultos,
      observacion:      orden.observacion || '',
      cantFotos:        orden.fotos ? orden.fotos.length : 0
    };

    commitArchivoGitHub(
      token, repo,
      `${basePath}/data.json`,
      JSON.stringify(dataObj, null, 2),
      false // no es base64
    );

    // Fotos
    if (orden.fotos && orden.fotos.length > 0) {
      orden.fotos.forEach((fotoBase64, idx) => {
        // El string llega como "data:image/jpeg;base64,XXXXXX"
        const base64puro = fotoBase64.replace(/^data:image\/\w+;base64,/, '');
        commitArchivoGitHub(
          token, repo,
          `${basePath}/foto${idx + 1}.jpg`,
          base64puro,
          true // ya es base64
        );
      });
    }
  });
}

// ── Crea o actualiza un archivo en GitHub via API ─────────────
function commitArchivoGitHub(token, repo, path, contenido, esBase64) {
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;

  // Verificar si el archivo ya existe (para obtener su SHA)
  let sha = null;
  try {
    const checkResp = UrlFetchApp.fetch(apiUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      muteHttpExceptions: true
    });
    if (checkResp.getResponseCode() === 200) {
      sha = JSON.parse(checkResp.getContentText()).sha;
    }
  } catch (_) { /* archivo nuevo, sha = null */ }

  // Codificar contenido si no está ya en base64
  const contentBase64 = esBase64
    ? contenido
    : Utilities.base64Encode(contenido, Utilities.Charset.UTF_8);

  const body = {
    message: `rendicion: ${path}`,
    content: contentBase64,
    ...(sha ? { sha } : {})
  };

  UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
}

// ── Helper: respuesta JSON con CORS ───────────────────────────
function jsonResponse(obj, code) {
  const output = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}
