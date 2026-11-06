# Cimiento

Plataforma del fondo: tablero público del estado del fondo y perfil privado de cada integrante (aportes, mora a la tasa de usura, inversiones).

- `public/index.html`: la aplicación (sin build).
- `netlify/functions/api.mts`: API sobre Netlify Blobs (store `cimiento`).

## Datos

Ningún dato del fondo vive en este repositorio (es público). Los datos están en Netlify Blobs. La carga inicial se hace con `POST /api/importar` mientras el fondo está vacío; después solo con la clave `SETUP_KEY`. Un administrador con sesión puede descargar un respaldo en `GET /api/exportar`.

## Variables de entorno (Netlify)

| Variable | Uso |
| --- | --- |
| `INVITE_CODE` | Código del grupo para crear la primera contraseña (obligatoria) |
| `SESSION_SECRET` | Opcional. Si falta, se genera una y se guarda en Blobs |
| `SETUP_KEY` | Opcional. Permite reimportar datos cuando el fondo ya tiene integrantes |
| `AUTOMATION_KEY` | Carga mensual automática de la tasa de usura (`POST /api/usura-auto`) |
