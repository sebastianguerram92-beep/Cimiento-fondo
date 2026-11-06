import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

/*
  API de Cimiento. Los datos viven en Netlify Blobs (store "cimiento"), un blob JSON por colección.
  Ningún dato real vive en el repositorio: se cargan con /api/importar usando SETUP_KEY.

  Variables de entorno:
    INVITE_CODE      código del grupo para crear la primera contraseña (obligatoria)
    SESSION_SECRET   opcional: si falta, se genera una y se guarda en Blobs
    SETUP_KEY        opcional: sin ella, /api/importar solo funciona con el fondo vacío
    AUTOMATION_KEY   clave para /api/usura-auto (tarea mensual de la tasa de usura)
    GMAIL_USER       opcional: cuenta de Gmail que envía los avisos de pagos por validar
    GMAIL_APP_PASSWORD  opcional: contraseña de aplicación de esa cuenta de Gmail
    DRIVE_WEBHOOK_URL  opcional: URL de la app web de Apps Script que guarda los comprobantes en Drive (ver drive/README.md)
    SITE_URL         opcional: link del sitio para los correos (por defecto URL de Netlify)
*/

const COLS = ["config", "miembros", "obligaciones", "pagos", "usura"] as const;
type Col = (typeof COLS)[number];
type Doc = Record<string, any>;
type Data = Record<string, Doc>;

const store = () => getStore({ name: "cimiento", consistency: "strong" });
const comprobantes = () => getStore({ name: "cimiento-comprobantes", consistency: "strong" });
const MAX_COMPROBANTE = 3 * 1024 * 1024;
const env = (k: string) => Netlify.env.get(k) || "";

async function leer(col: Col): Promise<Data> {
  return ((await store().get(col, { type: "json" })) as Data) || {};
}
async function escribir(col: Col, data: Data) {
  await store().setJSON(col, data);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const error = (msg: string, status = 400) => json({ error: msg }, status);

/* ---------- Criptografía ---------- */
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

async function hashPass(pass: string, saltB64?: string) {
  const salt = saltB64 ? Buffer.from(saltB64, "base64url") : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 }, key, 256);
  return `pbkdf2$${b64u(salt)}$${b64u(bits)}`;
}
async function verificarPass(pass: string, guardado: string) {
  const [, salt] = String(guardado || "").split("$");
  if (!salt) return false;
  const nuevo = await hashPass(pass, salt);
  return igual(nuevo, guardado);
}
function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
let secretoCache = "";
async function secretoSesion() {
  if (env("SESSION_SECRET")) return env("SESSION_SECRET");
  if (secretoCache) return secretoCache;
  // Sin variable de entorno: se genera una vez y se guarda en Blobs (nunca sale del servidor).
  const st = getStore({ name: "cimiento-sistema", consistency: "strong" });
  let s = (await st.get("session-secret")) as string | null;
  if (!s) {
    s = b64u(crypto.getRandomValues(new Uint8Array(48)));
    await st.set("session-secret", s, { onlyIfNew: true });
    s = ((await st.get("session-secret")) as string) || s;
  }
  return (secretoCache = s);
}
async function hmac(data: string) {
  const secret = await secretoSesion();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
const DIAS_SESION = 30;
async function crearToken(id: string, v: number) {
  const payload = b64u(enc.encode(JSON.stringify({ id, v, exp: Date.now() + DIAS_SESION * 86400000 })));
  return `${payload}.${await hmac(payload)}`;
}
async function leerToken(req: Request): Promise<{ id: string; v: number } | null> {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, firma] = t.split(".");
  if (!payload || !firma || !igual(await hmac(payload), firma)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return d.exp > Date.now() ? { id: d.id, v: d.v || 0 } : null;
  } catch {
    return null;
  }
}

/* ---------- Utilidades ---------- */
const publicoMiembro = (m: Doc) => {
  const { passHash, sesionV, ...resto } = m;
  return { ...resto, tienePass: !!passHash };
};
const tieneRol = (m: Doc | undefined, r: string) => !!m && ((m.roles || []).includes("admin") || (m.roles || []).includes(r));
const idValido = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const esClave = (req: Request, nombre: string, valor: string) => !!valor && igual(req.headers.get(nombre) || "", valor);

async function usuarioActual(req: Request) {
  const tok = await leerToken(req);
  if (!tok) return null;
  const miembros = await leer("miembros");
  const m = miembros[tok.id];
  if (!m || !m.passHash || (m.sesionV || 0) !== tok.v) return null;
  return { id: tok.id, m, miembros };
}

async function estadoCompleto() {
  const out: Record<string, Data> = {};
  for (const c of COLS) out[c] = await leer(c);
  out.miembros = Object.fromEntries(Object.entries(out.miembros).map(([id, m]) => [id, publicoMiembro(m)]));
  return out;
}

/* ---------- Reglas de escritura ---------- */
const CAMPOS_SALDO = ["saldo", "saldoFecha", "invertidoAlternativas", "posiciones"];

const avisos: Array<() => Promise<boolean>> = [];
const cop = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const mesNombre = (p: string) => { const [y, m] = p.split("-").map(Number); return `${MESES[m - 1] || p} ${y}`; };

// Correo a quienes validan pagos (gestor o administrador con email registrado).
async function avisarPago(miembros: Data, id: string, pago: Doc, comprobante: { bytes: Uint8Array; tipo: string } | null) {
  const user = env("GMAIL_USER"), pass = env("GMAIL_APP_PASSWORD").replace(/\s+/g, "");
  if (!user || !pass) return false;
  const destinos = Object.values(miembros).filter((m) => m.email && ((m.roles || []).includes("validador") || (m.roles || []).includes("gestor"))).map((m) => m.email);
  if (!destinos.length) return false;
  const quien = miembros[pago.miembro]?.nombre || pago.miembro;
  const sitio = env("SITE_URL") || env("URL") || "https://cimiento-fondo.netlify.app";
  const tipo = pago.tipo === "interes" ? "intereses de mora" : "aporte";
  const t = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await t.sendMail({
    from: `Cimiento <${user}>`,
    to: destinos.join(", "),
    subject: `Pago por validar: ${quien}, ${cop(pago.monto)} (${mesNombre(pago.periodo)})`,
    text: `${quien} registró un pago de ${tipo} de ${mesNombre(pago.periodo)} por ${cop(pago.monto)}, transferido el ${pago.fecha}${pago.referencia ? " (ref. " + pago.referencia + ")" : ""}.\n\nRevisa que el dinero haya entrado a la cuenta y valídalo o recházalo en ${sitio}/#gestion\n\n${comprobante ? "El pantallazo de la consignación va adjunto." : "No adjuntó pantallazo."}`,
    attachments: comprobante ? [{ filename: `comprobante-${id}.${comprobante.tipo.split("/")[1]}`, content: Buffer.from(comprobante.bytes), contentType: comprobante.tipo }] : [],
  });
  return true;
}

// Copia del comprobante en Drive: <carpeta raíz>/<Integrante>/Aporte N/archivo
async function guardarEnDrive(miembros: Data, id: string, pago: Doc, comprobante: { bytes: Uint8Array; tipo: string }) {
  const url = env("DRIVE_WEBHOOK_URL");
  if (!url) return;
  const periodos = Object.keys(await leer("obligaciones")).sort();
  const n = periodos.indexOf(pago.periodo) + 1;
  const integrante = miembros[pago.miembro]?.nombre || pago.miembro;
  const ext = comprobante.tipo.split("/")[1] === "jpeg" ? "jpg" : comprobante.tipo.split("/")[1];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      integrante,
      carpeta: n > 0 ? `Aporte ${n}` : `Aporte ${pago.periodo}`,
      nombreArchivo: `${pago.tipo === "interes" ? "Intereses" : "Aporte"} ${n > 0 ? n : ""} ${mesNombre(pago.periodo)} - ${pago.fecha} - ${id}.${ext}`.replace(/\s+/g, " "),
      mime: comprobante.tipo,
      archivo: Buffer.from(comprobante.bytes).toString("base64"),
    }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error("Drive respondió " + res.status);
}

async function guardarDoc(yo: { id: string; m: Doc; miembros: Data }, col: Col, id: string, body: Doc) {
  const admin = tieneRol(yo.m, "admin");
  const gestor = tieneRol(yo.m, "gestor");
  const data = await leer(col);
  const previo = data[id];

  if (col === "pagos") {
    if (!previo) {
      if (body.miembro !== yo.id && !gestor) return "Solo puedes registrar tus propios pagos";
      const monto = Number(body.monto);
      if (!(monto > 0)) return "Monto inválido";
      let comprobante: { bytes: Uint8Array; tipo: string } | null = null;
      if (body.comprobante) {
        const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.comprobante));
        if (!m) return "El comprobante debe ser una imagen";
        const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
        if (bytes.length > MAX_COMPROBANTE) return "La imagen del comprobante es muy grande";
        comprobante = { bytes, tipo: m[1] };
      }
      if (comprobante) await comprobantes().set(id, comprobante.bytes, { metadata: { tipo: comprobante.tipo, miembro: body.miembro } });
      data[id] = {
        miembro: body.miembro,
        tipo: body.tipo === "interes" ? "interes" : "aporte",
        periodo: String(body.periodo || "").slice(0, 7),
        monto,
        fecha: String(body.fecha || "").slice(0, 10),
        referencia: String(body.referencia || "").slice(0, 120),
        estado: gestor && body.estado === "validado" ? "validado" : "pendiente",
        creado: new Date().toISOString(),
        creadoPor: yo.id,
        comprobante: !!comprobante,
      };
      if (data[id].estado === "pendiente") avisos.push(() => avisarPago(yo.miembros, id, data[id], comprobante));
      if (comprobante) avisos.push(() => guardarEnDrive(yo.miembros, id, data[id], comprobante).then(() => false));
    } else {
      if (!gestor && !tieneRol(yo.m, "validador")) return "Solo quien valida pagos puede hacerlo";
      if (!["pendiente", "validado", "rechazado"].includes(body.estado)) return "Estado inválido";
      data[id] = { ...previo, estado: body.estado, validadoPor: yo.id, validadoEn: new Date().toISOString() };
    }
  } else if (col === "miembros") {
    if (!admin) return "Solo el administrador cambia integrantes";
    if (id === yo.id && !(body.roles || []).includes("admin")) return "No puedes quitarte el rol de administrador";
    const { passHash, sesionV, tienePass, ...limpio } = body;
    data[id] = { ...limpio, ...(previo?.passHash ? { passHash: previo.passHash } : {}), sesionV: previo?.sesionV || 0 };
  } else if (col === "config") {
    if (!gestor) return "Sin permiso";
    if (admin) data[id] = body;
    else {
      const nuevo = { ...(previo || {}) };
      for (const k of CAMPOS_SALDO) if (k in body) nuevo[k] = body[k];
      data[id] = nuevo;
    }
  } else {
    // obligaciones, usura
    if (!gestor) return "Sin permiso";
    data[id] = body;
  }
  await escribir(col, data);
  return null;
}

/* ---------- Rutas ---------- */
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const partes = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const ruta = partes[0] || "";
  const leerBody = async () => {
    try {
      return await req.json();
    } catch {
      return {};
    }
  };

  try {
    // Directorio para la pantalla de entrada: solo nombres y si ya tiene contraseña.
    if (ruta === "directorio" && req.method === "GET") {
      const miembros = await leer("miembros");
      return json(
        Object.entries(miembros)
          .map(([id, m]) => ({ id, nombre: m.nombre, tienePass: !!m.passHash }))
          .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))
      );
    }

    // Tablero público: lo que ve cualquiera con el link, sin referencias ni pagos sin validar.
    if (ruta === "publico" && req.method === "GET") {
      const e = await estadoCompleto();
      e.miembros = Object.fromEntries(Object.entries(e.miembros).map(([id, m]) => [id, { nombre: m.nombre, roles: m.roles || [], tienePass: m.tienePass }]));
      e.pagos = Object.fromEntries(
        Object.entries(e.pagos)
          .filter(([, p]) => p.estado === "validado")
          .map(([id, p]) => [id, { miembro: p.miembro, tipo: p.tipo, periodo: p.periodo, monto: p.monto, fecha: p.fecha, estado: p.estado }])
      );
      return json(e);
    }

    if (ruta === "entrar" && req.method === "POST") {
      const { id, pass } = await leerBody();
      const miembros = await leer("miembros");
      const m = miembros[id];
      if (!m || !m.passHash || !(await verificarPass(String(pass || ""), m.passHash)))
        return error("La contraseña no coincide. Si la olvidaste, pide al administrador que la reinicie.", 401);
      return json({ token: await crearToken(id, m.sesionV || 0), id });
    }

    if (ruta === "crear-clave" && req.method === "POST") {
      const { id, pass, codigo } = await leerBody();
      if (!env("INVITE_CODE") || !igual(String(codigo || "").trim(), env("INVITE_CODE")))
        return error("El código del grupo no es correcto. Pídeselo al administrador.", 401);
      if (String(pass || "").length < 8) return error("La contraseña debe tener al menos 8 caracteres.");
      const miembros = await leer("miembros");
      const m = miembros[id];
      if (!m) return error("Integrante no encontrado", 404);
      if (m.passHash) return error("Ya tienes contraseña. Si la olvidaste, pide al administrador que la reinicie.", 409);
      m.passHash = await hashPass(String(pass));
      m.sesionV = (m.sesionV || 0) + 1;
      await escribir("miembros", miembros);
      return json({ token: await crearToken(id, m.sesionV), id });
    }

    // Carga inicial y respaldo, protegidos con SETUP_KEY.
    if (ruta === "importar" && req.method === "POST") {
      // Sin SETUP_KEY, solo se permite la carga inicial (cuando aún no hay integrantes).
      const permitido = env("SETUP_KEY") ? esClave(req, "x-setup-key", env("SETUP_KEY")) : Object.keys(await leer("miembros")).length === 0;
      if (!permitido) return error("No autorizado", 401);
      const body = await leerBody();
      const hechos: Record<string, number> = {};
      for (const c of COLS) {
        if (body[c] && typeof body[c] === "object") {
          let data: Data = body[c];
          if (c === "miembros") {
            const previos = await leer("miembros");
            data = Object.fromEntries(
              Object.entries(data).map(([id, m]) => {
                const { passHash, sesionV, tienePass, ...limpio } = m as Doc;
                const p = previos[id];
                return [id, { ...limpio, ...(p?.passHash ? { passHash: p.passHash } : {}), sesionV: p?.sesionV || 0 }];
              })
            );
          }
          await escribir(c, data);
          hechos[c] = Object.keys(data).length;
        }
      }
      return json({ ok: true, hechos });
    }

    // Tasa de usura desde la tarea mensual automática.
    if (ruta === "usura-auto" && req.method === "POST") {
      if (!esClave(req, "x-automation-key", env("AUTOMATION_KEY"))) return error("No autorizado", 401);
      const { mes, tasaEA, fuente, url: fuenteUrl } = await leerBody();
      const t = Number(tasaEA);
      if (!/^\d{4}-\d{2}$/.test(String(mes)) || !(t > 0 && t < 100)) return error("Datos inválidos");
      const data = await leer("usura");
      data[mes] = { tasaEA: t, fuente: String(fuente || "").slice(0, 120), url: String(fuenteUrl || "").slice(0, 300), cargada: new Date().toISOString(), por: "automatico" };
      await escribir("usura", data);
      return json({ ok: true });
    }

    // Desde aquí, todo requiere sesión.
    const yo = await usuarioActual(req);
    if (!yo) return error("Sesión vencida", 401);

    if (ruta === "exportar" && req.method === "GET") {
      if (!tieneRol(yo.m, "admin")) return error("Solo el administrador", 403);
      return json(await estadoCompleto());
    }

    if (ruta === "estado" && req.method === "GET") {
      const e = await estadoCompleto();
      if (!tieneRol(yo.m, "admin"))
        e.miembros = Object.fromEntries(Object.entries(e.miembros).map(([id, m]) => { const { email, ...resto } = m; return [id, id === yo.id ? m : resto]; }));
      return json({ yo: yo.id, ...e });
    }

    if (ruta === "comprobante" && partes[1] && req.method === "GET") {
      const id = partes[1];
      const pago = (await leer("pagos"))[id];
      if (!pago || !idValido(id)) return error("No existe", 404);
      if (pago.miembro !== yo.id && !["gestor", "supervisor", "validador"].some((r) => tieneRol(yo.m, r))) return error("Sin permiso", 403);
      const r = await comprobantes().getWithMetadata(id, { type: "arrayBuffer" });
      if (!r) return error("Sin comprobante", 404);
      return new Response(r.data as ArrayBuffer, { headers: { "content-type": String(r.metadata?.tipo || "image/jpeg"), "cache-control": "private, no-store" } });
    }

    if (ruta === "clave" && req.method === "POST") {
      const { actual, nueva } = await leerBody();
      if (!(await verificarPass(String(actual || ""), yo.m.passHash))) return error("La contraseña actual no coincide", 401);
      if (String(nueva || "").length < 8) return error("La contraseña debe tener al menos 8 caracteres.");
      const miembros = await leer("miembros");
      miembros[yo.id].passHash = await hashPass(String(nueva));
      miembros[yo.id].sesionV = (miembros[yo.id].sesionV || 0) + 1;
      await escribir("miembros", miembros);
      return json({ token: await crearToken(yo.id, miembros[yo.id].sesionV) });
    }

    if (ruta === "reiniciar-clave" && req.method === "POST") {
      if (!tieneRol(yo.m, "admin")) return error("Solo el administrador", 403);
      const { id } = await leerBody();
      const miembros = await leer("miembros");
      if (!miembros[id]) return error("No existe", 404);
      delete miembros[id].passHash;
      miembros[id].sesionV = (miembros[id].sesionV || 0) + 1;
      await escribir("miembros", miembros);
      return json({ ok: true });
    }

    if (ruta === "doc" && partes.length === 3) {
      const col = partes[1] as Col, id = partes[2];
      if (!COLS.includes(col) || !idValido(id)) return error("Ruta inválida", 404);
      if (req.method === "PUT") {
        avisos.length = 0;
        const msg = await guardarDoc(yo, col, id, await leerBody());
        if (msg) return error(msg, 403);
        let aviso = "";
        for (const a of avisos.splice(0)) {
          try { if (await a()) aviso = "enviado"; else if (!aviso) aviso = "sin-correo"; } catch (e: any) { console.error("Aviso de pago", e); if (aviso !== "enviado") aviso = "fallo"; }
        }
        return json({ ok: true, aviso });
      }
      if (req.method === "DELETE") {
        if (!["obligaciones", "usura"].includes(col) || !tieneRol(yo.m, "gestor")) return error("Sin permiso", 403);
        const data = await leer(col);
        delete data[id];
        await escribir(col, data);
        return json({ ok: true });
      }
    }

    return error("No encontrado", 404);
  } catch (e: any) {
    console.error(e);
    return error("Error del servidor: " + (e?.message || e), 500);
  }
};

export const config: Config = { path: "/api/*" };
