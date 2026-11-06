# Cimiento

Plataforma del fondo: tablero público del estado del fondo y perfil privado de cada integrante (aportes, mora a la tasa de usura, inversiones).

- `public/index.html`: la aplicación (sin build).
- `netlify/functions/api.mts`: API sobre Netlify Blobs (store `cimiento`).

## Datos

Ningún dato del fondo vive en este repositorio (es público). Los datos están en Netlify Blobs y se cargan con:

```
curl -X POST https://<sitio>/api/importar -H "x-setup-key: $SETUP_KEY" --data @datos.json
```

`GET /api/exportar` con la misma clave descarga un respaldo.

## Variables de entorno (Netlify)

| Variable | Uso |
| --- | --- |
| `SESSION_SECRET` | Firma de las sesiones |
| `INVITE_CODE` | Código del grupo para crear la primera contraseña |
| `SETUP_KEY` | Importar y exportar datos |
| `AUTOMATION_KEY` | Carga mensual automática de la tasa de usura (`POST /api/usura-auto`) |
