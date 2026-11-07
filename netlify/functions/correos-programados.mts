import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { conUsuraPublica, enviarDelDia, hoyBogota, type Fondo } from "../lib/correos.mts";

// Corre todos los días a las 8:00 a. m. de Bogotá (13:00 UTC). Según el día envía:
//   último día del mes anterior al plazo → recordatorio con el valor de la cuota a todos los que no han pagado
//   día anterior al vencimiento → último aviso solo a quienes no han pagado
//   día siguiente al vencimiento → reporte mensual a todos y alerta a quien está a un mes de la exclusión
export default async () => {
  const st = getStore({ name: "cimiento", consistency: "strong" });
  const leer = async (k: string) => ((await st.get(k, { type: "json" })) as Record<string, any>) || {};
  const f: Fondo = { config: await leer("config"), miembros: await leer("miembros"), obligaciones: await leer("obligaciones"), pagos: await leer("pagos"), usura: await leer("usura") };
  const hoy = hoyBogota();
  const log = await enviarDelDia(await conUsuraPublica(f), hoy);
  console.log("Correos programados", hoy, log.join(" | ") || "nada que enviar hoy");
};

export const config: Config = { schedule: "0 13 * * *" };
