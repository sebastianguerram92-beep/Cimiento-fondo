import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/*
  API de Cimiento. Los datos viven en Netlify Blobs (store "cimiento"), un blob JSON por colección.
  Ningún dato real vive en el repositorio: se cargan con /api/importar usando SETUP_KEY.

  Variables de entorno:
    SESSION_SECRET   firma de las sesiones (obligatoria)
    INVITE_CODE      código del grupo para crear la primera contraseña
    SETUP_KEY        clave para /api/importar y /api/exportar
    AUTOMATION_KEY   clave para /api/usura-auto (tarea mensual de la tasa de usura)
*/

const COLS = ["config", "miembros", "obligaciones", "pagos", "usura"] as const;
type Col = (typeof COLS)[number];
type Doc = Record<string, any>;
type Data = Record<string, Doc>;

const store = () => getStore({ name: "cimiento", consistency: "strong" });
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
async function hmac(data: string) {
  const secret = env("SESSION_SECRET");
  if (!secret) throw new Error("Falta SESSION_SECRET");
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
const CAMPOS_SALDO = ["saldo", "saldoFecha", "invertidoAlternativas"];

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
      };
    } else {
      if (!gestor) return "Solo el gestor valida pagos";
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
      if (!esClave(req, "x-setup-key", env("SETUP_KEY"))) return error("No autorizado", 401);
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
    if (ruta === "exportar" && req.method === "GET") {
      if (!esClave(req, "x-setup-key", env("SETUP_KEY"))) return error("No autorizado", 401);
      return json(await estadoCompleto());
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

    if (ruta === "estado" && req.method === "GET") return json({ yo: yo.id, ...(await estadoCompleto()) });

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
        const msg = await guardarDoc(yo, col, id, await leerBody());
        return msg ? error(msg, 403) : json({ ok: true });
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
