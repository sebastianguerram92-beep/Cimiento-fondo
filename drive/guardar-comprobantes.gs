/**
 * Cimiento: guarda en Google Drive el pantallazo de cada aporte.
 * Estructura: <carpeta del fondo>/<Nombre del integrante>/Aporte N/<archivo>
 *
 * Instalación (una vez, desde un computador):
 * 1. Abre https://script.new con la cuenta de Google dueña de la carpeta del fondo.
 * 2. Borra lo que haya, pega este archivo completo y pon el ID de la carpeta en CARPETA_FONDO.
 * 3. Implementar > Nueva implementación > tipo "Aplicación web".
 *    Ejecutar como: Yo. Quién tiene acceso: Cualquier usuario. Autoriza el acceso a Drive.
 * 4. Copia la URL de la aplicación web y guárdala en Netlify como variable DRIVE_WEBHOOK_URL.
 *    Esa URL es la llave: no la compartas.
 */
const CARPETA_FONDO = 'PEGA_AQUI_EL_ID_DE_LA_CARPETA';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (!d.integrante || !d.carpeta || !d.archivo) throw new Error('Faltan datos');
    const raiz = DriveApp.getFolderById(CARPETA_FONDO);
    const persona = subcarpeta_(raiz, String(d.integrante));
    const aporte = subcarpeta_(persona, String(d.carpeta));
    const blob = Utilities.newBlob(Utilities.base64Decode(d.archivo), d.mime || 'image/jpeg', d.nombreArchivo || 'comprobante.jpg');
    const f = aporte.createFile(blob);
    return respuesta_({ ok: true, id: f.getId() });
  } catch (err) {
    return respuesta_({ ok: false, error: String(err) });
  }
}

function subcarpeta_(padre, nombre) {
  const it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

function respuesta_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
