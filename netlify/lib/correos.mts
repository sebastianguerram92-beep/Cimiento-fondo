import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

/*
  Correos automáticos del fondo (recordatorios, reporte mensual, alerta de exclusión, confirmaciones).
  Las reglas replican estadoMiembro() de public/index.html: la cuota de cada mes se paga del diaInicio
  al diaFin del mes siguiente (o.vence), la mora corre desde el día siguiente y los intereses se causan
  a la tasa de usura vigente al vencimiento.
*/

type Doc = Record<string, any>;
type Data = Record<string, Doc>;
export type Fondo = { config: Data; miembros: Data; obligaciones: Data; pagos: Data; usura: Data; portafolio?: Doc[] };

const env = (k: string) => Netlify.env.get(k) || "";
export const sitio = () => env("SITE_URL") || env("URL") || "https://cimiento-fondo.netlify.app";
export const cop = (n: number) => "$" + Math.round(n || 0).toLocaleString("es-CO");
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
export const mesNombre = (p: string) => { const [y, m] = p.split("-").map(Number); return `${MESES[m - 1] || p} ${y}`; };
const fechaLarga = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${dd} de ${MESES[m - 1]} de ${y}`; };
const toUTC = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd); };
const dias = (a: string, b: string) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Fecha de hoy en Bogotá (UTC-5, sin horario de verano). */
export const hoyBogota = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);

export const cfgDe = (f: Fondo) => Object.assign(
  { valorNominal: 1000, diaInicio: 1, diaFin: 5, mesesExclusion: 3, penalidadExclusion: 10, interesesActivos: true, saldo: 0, correosActivos: true },
  f.config.fondo || {}
);

/** Agrega la tasa de usura publicada en /usura.json (lo cargado en Gestión tiene prioridad). */
export async function conUsuraPublica(f: Fondo): Promise<Fondo> {
  try {
    const r = await fetch(sitio() + "/usura.json", { signal: AbortSignal.timeout(5000) });
    if (r.ok) { const u = await r.json(); f.usura = { ...(u.meses || {}), ...f.usura }; }
  } catch { /* sin red: se usa lo cargado en Gestión */ }
  try {
    const r = await fetch(sitio() + "/portafolio.json", { signal: AbortSignal.timeout(5000) });
    if (r.ok) f.portafolio = (await r.json()).posiciones || [];
  } catch { /* sin portafolio publicado */ }
  return f;
}

/* ---------- Estado de cada integrante (igual que en la página) ---------- */
export function estado(f: Fondo, mid: string, hoy: string) {
  const c = cfgDe(f);
  const tasa = (fecha: string) => { const ks = Object.keys(f.usura).filter((k) => k <= fecha.slice(0, 7)).sort(); return ks.length ? Number(f.usura[ks[ks.length - 1]].tasaEA) : null; };
  const interes = (monto: number, d: number, t: number | null) => (d > 0 && t != null ? monto * (Math.pow(1 + t / 100, d / 365) - 1) : 0);
  const pagosM = Object.values(f.pagos).filter((p) => p.miembro === mid);
  const validados = pagosM.filter((p) => p.estado === "validado");
  const aporte = validados.filter((p) => (p.tipo || "aporte") === "aporte");
  const obls = Object.entries(f.obligaciones).map(([id, o]) => ({ id, ...o })).sort((a, b) => a.periodo.localeCompare(b.periodo));
  let pendiente = 0, interesCausado = 0;
  const vencidas: Doc[] = [];
  for (const o of obls) {
    const pagado = aporte.filter((p) => p.periodo === o.periodo).reduce((s, p) => s + Number(p.monto), 0);
    const falta = Math.max(0, Number(o.monto) - pagado);
    if (c.interesesActivos) for (const p of aporte.filter((p) => p.periodo === o.periodo && p.fecha > o.vence)) interesCausado += interes(Number(p.monto), dias(o.vence, p.fecha), tasa(o.vence));
    if (falta > 0 && hoy > o.vence) {
      const i = c.interesesActivos ? interes(falta, dias(o.vence, hoy), tasa(o.vence)) : 0;
      interesCausado += i; pendiente += falta;
      vencidas.push({ ...o, falta, interes: i });
    }
  }
  const interesPagado = validados.filter((p) => p.tipo === "interes").reduce((s, p) => s + Number(p.monto), 0);
  return {
    pendiente, vencidas, meses: vencidas.length,
    interesPendiente: Math.max(0, interesCausado - interesPagado),
    porValidar: pagosM.filter((p) => p.estado === "pendiente"),
    pagadoDe: (periodo: string) => aporte.filter((p) => p.periodo === periodo).reduce((s, p) => s + Number(p.monto), 0),
    porValidarDe: (periodo: string) => pagosM.filter((p) => p.estado === "pendiente" && (p.tipo || "aporte") === "aporte" && p.periodo === periodo).reduce((s, p) => s + Number(p.monto), 0),
  };
}

/* ---------- Envío ---------- */
export type Correo = { para: string[]; asunto: string; texto: string; html: string; tipo: string };

export function correoListo() {
  return !!(env("GMAIL_USER") && env("GMAIL_APP_PASSWORD"));
}
export async function enviar(c: Correo) {
  const user = env("GMAIL_USER"), pass = env("GMAIL_APP_PASSWORD").replace(/\s+/g, "");
  if (!user || !pass || !c.para.length) return false;
  const t = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await t.sendMail({ from: `Cimiento <${user}>`, to: c.para.join(", "), subject: c.asunto, text: c.texto, html: c.html });
  return true;
}

const marco = (titulo: string, cuerpo: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1b1f1d">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-weight:700;font-size:18px;color:#1F5F4A;margin-bottom:14px">cimiento</div>
<div style="background:#fff;border:1px solid #e3e3df;border-radius:14px;padding:20px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(titulo)}</h1>${cuerpo}
<p style="margin:20px 0 0"><a href="${sitio()}" style="background:#1F5F4A;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;display:inline-block;font-weight:600">Abrir Cimiento</a></p>
</div><p style="font-size:12px;color:#6b706d;margin-top:12px">Correo automático del fondo Cimiento.</p></div></body></html>`;
const p = (t: string) => `<p style="margin:0 0 10px;line-height:1.5">${t}</p>`;

/* ---------- Gráficas del estado del fondo (tablas HTML: funcionan en Gmail y en el celular) ---------- */
const VERDE = "#1F5F4A", VERDE_CLARO = "#cfe3da", AMBAR = "#E0A43A", GRIS = "#6b706d";
const barra = (pct: number, color: string, fondo = "#eeeeea", alto = 10) => {
  const v = Math.max(0, Math.min(100, pct));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:6px;overflow:hidden"><tr>${v > 0 ? `<td width="${v.toFixed(1)}%" bgcolor="${color}" style="background:${color};height:${alto}px;line-height:${alto}px;font-size:0">&nbsp;</td>` : ""}${v < 100 ? `<td bgcolor="${fondo}" style="background:${fondo};height:${alto}px;line-height:${alto}px;font-size:0">&nbsp;</td>` : ""}</tr></table>`;
};
const subt = (t: string) => `<div style="font-size:13px;font-weight:700;margin:18px 0 8px;color:#1b1f1d">${t}</div>`;

export function bloqueFondo(f: Fondo, hoy: string) {
  const c = cfgDe(f) as Doc, meta = Number(c.meta) || 50000000;
  const validados = Object.values(f.pagos).filter((p) => p.estado === "validado" && (p.tipo || "aporte") === "aporte");
  const aportado = validados.reduce((s, p) => s + Number(p.monto), 0);
  const saldo = Number(c.saldo) || aportado;
  const rend = c.saldo ? saldo - aportado : 0;
  const n = Object.keys(f.miembros).length;

  // KPIs
  const kpi = (t: string, v: string, col = "#1b1f1d") => `<td style="padding:10px;background:#f4f4f2;border-radius:10px" width="33%"><div style="font-size:11px;color:${GRIS}">${t}</div><div style="font-size:16px;font-weight:700;color:${col}">${v}</div></td>`;
  let h = `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 -6px"><tr>${kpi("Valor del fondo", cop(saldo), VERDE)}${kpi("Total aportado", cop(aportado))}${kpi("Rendimiento", (rend >= 0 ? "+" : "") + cop(rend), rend >= 0 ? VERDE : "#9b2c22")}</tr></table>`;

  // Camino a la meta
  const pm = saldo / meta * 100;
  h += subt(`Camino a ${cop(meta)}`) + barra(pm, VERDE, "#eeeeea", 14) + `<div style="font-size:12px;color:${GRIS};margin-top:4px">${pm.toLocaleString("es-CO", { maximumFractionDigits: 1 })}% de la meta</div>`;

  // Aportes por mes (últimos 6 meses vencidos o en curso): recibido vs esperado
  const obls = Object.values(f.obligaciones).filter((o) => o.vence.slice(0, 7) <= hoy.slice(0, 7)).sort((a, b) => a.periodo.localeCompare(b.periodo)).slice(-6);
  if (obls.length) {
    const max = Math.max(...obls.map((o) => n * Number(o.monto)));
    h += subt("Aportes recibidos por mes");
    h += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${obls.map((o) => {
      const esperado = n * Number(o.monto), rec = validados.filter((p) => p.periodo === o.periodo).reduce((s, p) => s + Number(p.monto), 0);
      return `<tr><td width="28%" style="font-size:12px;color:${GRIS};padding:4px 8px 4px 0;white-space:nowrap">${mesNombre(o.periodo).replace(/ (\d\d)(\d\d)$/, " $2")}</td><td style="padding:4px 0">${barra(rec / max * 100, VERDE, esperado > rec ? VERDE_CLARO : "#ffffff")}<div style="font-size:11px;color:${GRIS}">${cop(rec)} de ${cop(esperado)}</div></td></tr>`;
    }).join("")}</table>`;
  }

  // Dónde está el dinero
  const pos: Doc[] = Array.isArray(c.posiciones) && c.posiciones.length ? c.posiciones : f.portafolio || [];
  if (pos.length) {
    const colores = [VERDE, AMBAR, "#5b8c7a", "#b77b1f", "#93b8a9"];
    h += subt("Dónde está el dinero hoy");
    h += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden"><tr>${pos.map((x, i) => `<td width="${Number(x.pct)}%" bgcolor="${colores[i % colores.length]}" style="background:${colores[i % colores.length]};height:14px;font-size:0">&nbsp;</td>`).join("")}</tr></table>`;
    h += pos.map((x, i) => `<div style="font-size:12px;margin-top:6px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colores[i % colores.length]};vertical-align:middle"></span> <strong>${Number(x.pct)}%</strong> ${esc(x.nombre)}${x.titular ? ` <span style="color:${GRIS}">· ${esc(x.titular)} · ${esc(x.tipo || "")}</span>` : ""}</div>`).join("");
  }
  return `<div style="border-top:1px solid #eee;margin-top:18px;padding-top:4px"><div style="font-size:15px;font-weight:700;margin-top:12px">Estado del fondo</div>${h}</div>`;
}

const primerNombre = (m: Doc) => String(m.nombre || "").split(/\s+/)[0];

/** La cuota que se cobra en el mes de `hoy` (vence entre el 1 y el último día de ese mes). */
function cobroDelMes(f: Fondo, hoy: string) {
  return Object.entries(f.obligaciones).map(([id, o]) => ({ id, ...o })).filter((o) => String(o.vence).slice(0, 7) === hoy.slice(0, 7)).sort((a, b) => a.vence.localeCompare(b.vence))[0] || null;
}

export function recordatorio(f: Fondo, hoy: string, ultimoAviso: boolean): Correo[] {
  const c = cfgDe(f), o = cobroDelMes(f, hoy);
  if (!o) return [];
  const out: Correo[] = [];
  for (const [id, m] of Object.entries(f.miembros)) {
    if (!m.email) continue;
    const e = estado(f, id, hoy);
    const falta = Math.max(0, Number(o.monto) - e.pagadoDe(o.periodo) - e.porValidarDe(o.periodo));
    if (falta <= 0) continue;
    const extra = e.meses > 0 ? e.pendiente + e.interesPendiente : 0;
    const cuenta = c.cuentaAportes ? `Consigna a: ${c.cuentaAportes}.` : "";
    const asunto = ultimoAviso
      ? `Mañana vence tu aporte de ${mesNombre(o.periodo)}: ${cop(falta)}`
      : `Tu aporte de ${mesNombre(o.periodo)}: ${cop(falta)}, se paga del ${c.diaInicio} al ${Number(o.vence.slice(8))}`;
    const linea1 = ultimoAviso
      ? `Hola ${primerNombre(m)}, todavía no vemos tu aporte de ${mesNombre(o.periodo)}. El plazo vence mañana, ${fechaLarga(o.vence)}. Desde el día siguiente corren intereses de mora a la tasa de usura.`
      : `Hola ${primerNombre(m)}, del ${c.diaInicio} al ${fechaLarga(o.vence)} se paga el aporte de ${mesNombre(o.periodo)}.`;
    const linea2 = `Valor a pagar: ${cop(falta)}.${extra > 0 ? ` Además tienes ${cop(extra)} vencidos (incluye intereses).` : ""}`;
    const linea3 = `${cuenta} Después registra el pago en Cimiento → Aportes y sube el pantallazo de la consignación.`.trim();
    out.push({
      tipo: ultimoAviso ? "recordatorio-final" : "recordatorio",
      para: [m.email],
      asunto,
      texto: `${linea1}\n\n${linea2}\n\n${linea3}\n\n${sitio()}/#aportes`,
      html: marco(ultimoAviso ? "Mañana vence tu aporte" : "Se acerca tu aporte del mes", p(esc(linea1)) + p(`<strong>${esc(linea2)}</strong>`) + p(esc(linea3)) + (ultimoAviso ? "" : bloqueFondo(f, hoy))),
    });
  }
  return out;
}

/** Reporte del día siguiente al vencimiento: quién pagó, quién está en mora; y alerta a quien está a un mes de la exclusión. */
export function reporte(f: Fondo, hoy: string): Correo[] {
  const c = cfgDe(f);
  const o = Object.entries(f.obligaciones).map(([id, x]) => ({ id, ...x })).filter((x) => x.vence < hoy).sort((a, b) => b.vence.localeCompare(a.vence))[0];
  if (!o) return [];
  const filas = Object.entries(f.miembros).sort((a, b) => String(a[1].nombre).localeCompare(String(b[1].nombre))).map(([id, m]) => {
    const e = estado(f, id, hoy);
    const pagado = e.pagadoDe(o.periodo), revisar = e.porValidarDe(o.periodo);
    const situacion = pagado >= Number(o.monto) ? "Pagó" : revisar > 0 ? "Pago por validar" : pagado > 0 ? `Pagó ${cop(pagado)} de ${cop(o.monto)}` : "No pagó";
    return { id, m, e, situacion };
  });
  const pagaron = filas.filter((x) => x.situacion === "Pagó").length;
  const mora = filas.filter((x) => x.e.meses > 0 || x.e.interesPendiente > 0);
  const totalMora = mora.reduce((s, x) => s + x.e.pendiente + x.e.interesPendiente, 0);
  const asunto = `Reporte de ${mesNombre(o.periodo)}: pagaron ${pagaron} de ${filas.length}${mora.length ? `, ${mora.length} en mora` : ""}`;
  const estadoTxt = (x: (typeof filas)[number]) =>
    x.e.meses >= c.mesesExclusion ? `Causal de exclusión (${x.e.meses} meses en mora)` : x.e.meses > 0 ? `En mora: ${x.e.meses} ${x.e.meses === 1 ? "mes" : "meses"}, debe ${cop(x.e.pendiente + x.e.interesPendiente)}` : x.e.interesPendiente > 0 ? `Debe intereses: ${cop(x.e.interesPendiente)}` : "Al día";

  const texto = [
    `Aporte de ${mesNombre(o.periodo)} (vencía el ${fechaLarga(o.vence)}, cuota ${cop(o.monto)}).`,
    "",
    ...filas.map((x) => `• ${x.m.nombre}: ${x.situacion}. ${estadoTxt(x)}.`),
    "",
    mora.length ? `Total en mora: ${cop(totalMora)} (capital más intereses a la tasa de usura).` : "Nadie está en mora.",
    c.saldo ? `Valor del fondo: ${cop(c.saldo)}${c.saldoFecha ? ` (corte ${fechaLarga(c.saldoFecha)})` : ""}.` : "",
    "",
    `Detalle en ${sitio()}`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");

  const color = (x: (typeof filas)[number]) => (x.e.meses > 0 ? "#9b2c22" : x.situacion === "Pagó" ? "#1F5F4A" : "#8a5a00");
  const tabla = `<table style="width:100%;border-collapse:collapse;font-size:14px">${filas.map((x) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee"><strong>${esc(x.m.nombre)}</strong><br><span style="color:#6b706d">${esc(estadoTxt(x))}</span></td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:${color(x)};font-weight:600">${esc(x.situacion)}</td></tr>`).join("")}</table>`;
  const html = marco(`Reporte de ${mesNombre(o.periodo)}`,
    p(`Aporte de ${esc(mesNombre(o.periodo))}: cuota ${cop(o.monto)}, vencía el ${esc(fechaLarga(o.vence))}. <strong>${pagaron} de ${filas.length}</strong> pagaron.`) + tabla +
    p(`<br>${mora.length ? `Total en mora: <strong>${cop(totalMora)}</strong> (capital más intereses a la tasa de usura).` : "Nadie está en mora."}`) +
    (c.saldoFecha ? p(`<span style="color:${GRIS};font-size:12px">Saldo con corte al ${esc(fechaLarga(c.saldoFecha))}.</span>`) : "") + bloqueFondo(f, hoy));

  const para = Object.values(f.miembros).map((m) => m.email).filter(Boolean);
  const out: Correo[] = para.length ? [{ tipo: "reporte", para, asunto, texto, html }] : [];

  // Alerta individual: a un mes de la causal de exclusión.
  for (const x of filas) {
    if (!x.m.email || x.e.meses !== c.mesesExclusion - 1 || x.e.meses < 1) continue;
    const debe = x.e.pendiente + x.e.interesPendiente;
    const t1 = `Hola ${primerNombre(x.m)}, tienes ${x.e.meses} ${x.e.meses === 1 ? "mes" : "meses"} de aportes en mora por ${cop(debe)}, incluidos los intereses.`;
    const t2 = `Según lo acordado, al completar ${c.mesesExclusion} meses en mora se configura la causal de exclusión del fondo, con una penalidad del ${c.penalidadExclusion}% sobre el valor de tu parte.`;
    const t3 = "Ponte al día consignando lo pendiente y registrándolo en Cimiento → Aportes.";
    out.push({ tipo: "alerta-exclusion", para: [x.m.email], asunto: `Importante: estás a un mes de la exclusión del fondo`, texto: `${t1}\n\n${t2}\n\n${t3}\n\n${sitio()}/#aportes`, html: marco("Estás a un mes de la exclusión", p(esc(t1)) + p(`<strong>${esc(t2)}</strong>`) + p(esc(t3))) });
  }
  return out;
}

export function confirmacion(f: Fondo, pago: Doc): Correo | null {
  const m = f.miembros[pago.miembro];
  if (!m?.email || !["validado", "rechazado"].includes(pago.estado)) return null;
  const tipo = pago.tipo === "interes" ? "intereses de mora" : "aporte";
  const ok = pago.estado === "validado";
  const t = ok
    ? `Hola ${primerNombre(m)}, tu pago de ${tipo} de ${mesNombre(pago.periodo)} por ${cop(pago.monto)} fue validado. Ya quedó en tu historial.`
    : `Hola ${primerNombre(m)}, tu pago de ${tipo} de ${mesNombre(pago.periodo)} por ${cop(pago.monto)} fue rechazado porque no se encontró en la cuenta. Revisa la consignación y vuelve a registrarlo, o habla con quien valida los pagos.`;
  return { tipo: "confirmacion", para: [m.email], asunto: ok ? `Pago validado: ${cop(pago.monto)} (${mesNombre(pago.periodo)})` : `Pago rechazado: ${cop(pago.monto)} (${mesNombre(pago.periodo)})`, texto: `${t}\n\n${sitio()}/#mi`, html: marco(ok ? "Pago validado" : "Pago rechazado", p(esc(t))) };
}

/** Qué se envía hoy según el calendario: día de inicio, día antes del vencimiento y día siguiente al vencimiento. */
export function correosDelDia(f: Fondo, hoy: string): { clave: string; correos: Correo[] }[] {
  const c = cfgDe(f), dia = Number(hoy.slice(8)), mes = hoy.slice(0, 7);
  const out: { clave: string; correos: Correo[] }[] = [];
  // Primer recordatorio: el último día del mes anterior al plazo (30 o 31; 28/29 en febrero).
  const manana = new Date(toUTC(hoy) + 86400000).toISOString().slice(0, 10);
  if (manana.slice(8) === "01") out.push({ clave: `recordatorio-${manana.slice(0, 7)}`, correos: recordatorio(f, manana, false) });
  if (dia === Number(c.diaFin) - 1 && Number(c.diaFin) - 1 > Number(c.diaInicio)) out.push({ clave: `recordatorio-final-${mes}`, correos: recordatorio(f, hoy, true) });
  if (dia === Number(c.diaFin) + 1) out.push({ clave: `reporte-${mes}`, correos: reporte(f, hoy) });
  return out;
}

/** Ejecuta los envíos del día una sola vez (marca en Blobs lo ya enviado). */
export async function enviarDelDia(f: Fondo, hoy: string) {
  const reg = getStore({ name: "cimiento-sistema", consistency: "strong" });
  const hechos = ((await reg.get("correos-enviados", { type: "json" })) as Record<string, string>) || {};
  const log: string[] = [];
  if (cfgDe(f).correosActivos === false) return ["Correos automáticos desactivados en Reglas del fondo"];
  for (const { clave, correos } of correosDelDia(f, hoy)) {
    if (hechos[clave]) { log.push(`${clave}: ya enviado`); continue; }
    let n = 0;
    for (const c of correos) { try { if (await enviar(c)) n++; } catch (e: any) { log.push(`${clave}: fallo ${e?.message || e}`); } }
    hechos[clave] = new Date().toISOString();
    log.push(`${clave}: ${n} correos`);
  }
  await reg.setJSON("correos-enviados", hechos);
  return log;
}
