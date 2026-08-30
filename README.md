# Panel del Asistente de Ventas por WhatsApp

Mini app web local (se ve en tu navegador) para controlar tu asistente de
ventas por WhatsApp con IA, con soporte para varios productos.

## Instalación (en VS Code)

1. Abre esta carpeta en VS Code (Archivo > Abrir Carpeta).
2. Abre una terminal (Ctrl + Ñ) y corre:
   ```
   npm install
   ```
3. Corre el servidor:
   ```
   npm start
   ```
4. Abre tu navegador en: **http://localhost:3000**

## Cómo usarlo

1. **Pestaña Inicio**: dale clic a "▶ Iniciar asistente". Va a aparecer un
   código QR — escanéalo desde WhatsApp Business > Dispositivos vinculados >
   Vincular un dispositivo. Cuando diga "Conectado ✅", ya está funcionando.

2. **Pestaña Configuración**: pon el nombre de tu asistente, tu empresa, el
   mensaje de bienvenida, y tu clave de API (Groq u OpenAI). Dale
   "Guardar configuración".

3. **Pestaña Productos**: agrega cada producto que vendas con:
   - Nombre
   - Precio
   - Palabras clave (ej: "magnesio, calambres, dormir") — cuando un cliente
     escriba alguna de esas palabras, el bot va a identificar que pregunta
     por ESE producto y responder con su info específica.
   - Detalle completo (toda la info que quieres que la IA use para vender:
     beneficios, modo de uso, precauciones, etc.)
   - Imagen del producto (se envía automáticamente cuando el bot detecta
     interés en ese producto).

   Puedes agregar tantos productos como quieras. El bot detecta
   automáticamente de cuál está hablando el cliente según las palabras clave.

## Notas importantes

- No cierres la terminal mientras uses el asistente.
- La sesión de WhatsApp queda guardada en la carpeta `session/`, así que no
  tienes que volver a escanear el QR cada vez (solo si cierras sesión desde
  el celular).
- Los cambios en Configuración y Productos se aplican al instante en la
  siguiente respuesta del bot — no necesitas reiniciar el servidor.
- **No oficial**: usa `whatsapp-web.js`, que simula WhatsApp Web. Evita
  enviar mensajes masivos no solicitados para no arriesgar tu número.
- Revisa los límites del plan gratuito de tu proveedor de IA (Groq u OpenAI)
  si tu volumen de mensajes crece mucho.
