require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Resend } = require('resend');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

const PAYPHONE_TOKEN = (process.env.PAYPHONE_TOKEN || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const SCAN_PASSWORD = (process.env.SCAN_PASSWORD || '').trim();
const SHEETS_WEBHOOK_URL = (process.env.SHEETS_WEBHOOK_URL || '').trim();
const SHEETS_WEBHOOK_SECRET = (process.env.SHEETS_WEBHOOK_SECRET || '').trim();

// EDITAR: datos del evento mostrados en el correo del ticket.
const EVENT = {
  name: 'THE TRIBE PT.II',
  date: 'Sábado 01 de Agosto · 9:00 PM',
  place: 'Kuno Seafood Rooftop, Portoviejo'
};

// Debe coincidir exactamente con CONFIG/MAX_QTY/PROMO_* en
// ticketsTHETRIBEPTII.html — se usa para deducir la cantidad de tickets a
// partir del monto realmente cobrado, ya que los optionalParameter que le
// pasamos a la Cajita de Payphone no siempre llegan de vuelta en el Confirm.
const MAX_QTY = 5;
const PROMO_QTY = 5;
const PRICE_USD = 15.92;
// TEMPORAL: precio de prueba con Payphone en modo real, solo para 1 entrada
// individual. Quitar y volver a usar PRICE_USD una vez hecha la prueba.
const TEST_SINGLE_PRICE_USD = 1.00;
const PROMO_PRICE_USD = 11.68;

function pricePerTicket(qty) {
  if (qty === PROMO_QTY) return PROMO_PRICE_USD;
  if (qty === 1) return TEST_SINGLE_PRICE_USD;
  return PRICE_USD;
}

// Compara el monto cobrado (en centavos) contra cada cantidad posible y
// devuelve la que mejor coincide; si nada coincide razonablemente, recurre
// al optionalParameter1 como respaldo.
function quantityFromAmount(amountCents, fallbackParam) {
  for (let qty = 1; qty <= MAX_QTY; qty++) {
    const expected = Math.round(pricePerTicket(qty) * qty * 100);
    if (Math.abs(expected - amountCents) <= 1) return qty;
  }
  return Math.max(1, parseInt(fallbackParam, 10) || 1);
}

const resend = new Resend(RESEND_API_KEY);

// El comprador escribe su nombre completo en nuestra propia página antes de
// que aparezca el botón de pago. Lo guardamos aquí, indexado por el
// clientTransactionId que generamos en el navegador, porque Payphone no
// documenta (ni garantiza devolver en el Confirm) ningún campo libre como
// optionalParameter1/2 — solo optionalParameter3/4 vienen de vuelta, y ese
// mapeo tampoco está documentado. Así el nombre no depende de Payphone.
const pendingPurchases = new Map();

function cleanupPendingPurchases() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, value] of pendingPurchases) {
    if (value.createdAt < cutoff) pendingPurchases.delete(key);
  }
}

// Protege contra llamadas externas (correo, webhook) que se queden colgadas:
// nunca deben poder bloquear la respuesta al comprador más de `ms`.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms))
  ]);
}

// transactionId de pagos ya mostrados/confirmados. Cada enlace de
// confirmación es de un solo uso: si alguien recarga, navega con
// atrás/adelante, o reutiliza la URL (incluso el mismo comprador), no vuelve
// a mostrarse "¡Listo!" ni se reenvía el ticket/aviso.
const usedTransactions = new Set();

// Registro de tickets emitidos (uno por compra, sin importar la cantidad de
// personas) y si ya fueron aprobados en la puerta. `listNumber` es el número
// correlativo que aparece en la lista impresa para cotejar a mano. Se
// persiste a disco para sobrevivir un reinicio del proceso. Sin un volumen
// persistente en Railway, el disco del contenedor es efímero y un redeploy
// lo borra entero — incluyendo tickets reales ya vendidos. TICKETS_DB_DIR
// debe apuntar a la carpeta montada del volumen (ver Settings > Volumes en
// Railway) para que esto sobreviva a cada deploy.
const TICKETS_DB_DIR = (process.env.TICKETS_DB_DIR || __dirname).trim();
const TICKETS_DB_PATH = path.join(TICKETS_DB_DIR, 'tickets-db.json');

function loadIssuedTickets() {
  try {
    return JSON.parse(fs.readFileSync(TICKETS_DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveIssuedTickets() {
  fs.writeFile(TICKETS_DB_PATH, JSON.stringify(issuedTickets, null, 2), (err) => {
    if (err) console.error('Error guardando tickets-db.json:', err);
  });
}

const issuedTickets = loadIssuedTickets();

function registerIssuedTicket(code, { transactionId, cardholderName, document, quantity, email, phoneNumber }) {
  const listNumber = Object.keys(issuedTickets).length + 1;
  issuedTickets[code] = {
    listNumber,
    transactionId,
    cardholderName: cardholderName || '',
    document: document || '',
    quantity,
    email: email || '',
    phoneNumber: phoneNumber || '',
    entriesApproved: 0,
    usedAt: null
  };
  saveIssuedTickets();
  return listNumber;
}

// Tickets de grupo (quantity > 1) pueden entrar por partes: cada aprobación
// suma `count` al contador en vez de matar el QR de una sola vez. Solo queda
// muerto cuando entriesApproved llega a quantity. Soporta tickets-db.json
// viejos que todavía tengan el campo booleano `used` de antes de este cambio.
function ticketRemaining(ticket) {
  const approved = typeof ticket.entriesApproved === 'number'
    ? ticket.entriesApproved
    : (ticket.used ? ticket.quantity : 0);
  return Math.max(0, ticket.quantity - approved);
}

function ticketGroupLabel(quantity) {
  return quantity === 1 ? 'Entrada individual' : `Entrada de ${quantity} personas`;
}

// Empuja cada venta a una Google Sheet (vía un Apps Script Web App propio,
// ver sheets-apps-script.js) para tener la lista de ventas actualizada en
// vivo sin depender de abrir el servidor. Solo se llama una vez por compra
// (no en cada aprobación de entrada): el script del lado de Sheets es el que
// decide en qué pestaña (Grupos/Individuales) y con qué número va, y agrega
// las filas en blanco para los acompañantes cuando quantity > 1. Si no está
// configurado o falla, no debe afectar la compra en curso: va en segundo
// plano y solo se registra el error en consola.
function postToSheetWebhook(ticket) {
  return fetch(SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: SHEETS_WEBHOOK_SECRET,
      cardholderName: ticket.cardholderName,
      document: ticket.document,
      quantity: ticket.quantity,
      transactionId: ticket.transactionId,
      email: ticket.email,
      phoneNumber: ticket.phoneNumber
    })
  }).then(async (res) => {
    // Apps Script responde HTTP 200 incluso cuando falla (ej. timeout del
    // lock), así que revisar solo el status no detecta nada: hay que leer
    // el body y confirmar ok:true.
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || data.ok !== true) {
      throw new Error('respuesta sin éxito: ' + text);
    }
  });
}

// Dos compras casi simultáneas pueden hacer que la segunda espere el lock
// del script de Sheets y, si tarda demasiado, falle; un reintento cubre ese
// caso transitorio sin tener que volver a meter la fila a mano.
async function syncToSheet(ticket) {
  if (!SHEETS_WEBHOOK_URL) return;
  try {
    await postToSheetWebhook(ticket);
  } catch (err) {
    console.error('Sheets webhook falló en el primer intento para', ticket.transactionId, '-', err.message, '- reintentando...');
    try {
      await postToSheetWebhook(ticket);
    } catch (err2) {
      console.error('Sheets webhook falló también en el reintento para', ticket.transactionId, '-', err2.message);
    }
  }
}

const TICKET_ACCENT = '#dbce44';
const TICKET_WHATSAPP_NUMBERS = [
  { number: '593978820979', display: '+593 97 882 0979' },
  { number: '593986945986', display: '+593 98 694 5986' }
];
const TICKET_CONTACT_EMAIL = 'maison@rubyhazelabel.com';

async function sendTicketEmail({ email, cardholderName, quantity, ticketCode }) {
  // Se sirve como imagen normal desde /api/tickets/qr en vez de adjunto con
  // cid: así carga igual de bien que los logos/foto de fondo en cualquier
  // cliente de correo, sin depender de si el proveedor soporta imágenes
  // incrustadas en el envío.
  const qrUrl = `https://rubyhazemusic.com/api/tickets/qr/${encodeURIComponent(ticketCode)}`;
  const groupLabel = ticketGroupLabel(quantity);
  const waText = encodeURIComponent(`Hola, tengo una consulta sobre mi ticket/QR ya adquirido para ${EVENT.name}.`);

  const greetingName = cardholderName ? ` <strong>${cardholderName}</strong>` : '';
  const intro = quantity > 1
    ? `Gracias por asegurar tu ticket para <strong>${EVENT.name}</strong> — es válido para ${quantity} personas, cotéjalo con la lista en la puerta. Estamos felices de que formen parte. Nos vemos en la pista de baile.`
    : `Gracias por asegurar tu ticket para <strong>${EVENT.name}</strong>. Estamos felices de que formes parte, ¡preséntalo (impreso o en tu celular) en la entrada! Nos vemos en la pista de baile.`;

  // Meta de esquema de color forzado a "light": sin esto, varios clientes de
  // correo en celular (Gmail/Apple Mail en modo oscuro) invierten los fondos
  // oscuros a blanco y dejan el texto amarillo/blanco invisible.
  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="color-scheme" content="light">
      <meta name="supported-color-schemes" content="light">
    </head>
    <body style="margin:0; padding:0; background:#f4f4f4;">
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; background:#ffffff; border-radius:18px; overflow:hidden; border:1px solid #eee;">

      <img src="https://rubyhazemusic.com/eventos/ticket-header.png" alt="${EVENT.name}" width="420" style="display:block; width:100%; max-width:420px; height:auto;">

      <div style="padding:26px 24px 4px;">
        <p style="margin:0 0 4px; color:#111111; font-size:14px; text-align:center;">Hola${greetingName},</p>
        <p style="margin:0; color:#555555; font-size:13px; line-height:1.6; text-align:center;">${intro}</p>
        <p style="margin:14px 0 0; color:#999999; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; text-align:center;">Ruby Haze Team</p>
      </div>

      <div style="border-top:2px dashed #dddddd; margin:22px 24px 0;"></div>

      <div style="padding:22px 24px; text-align:center;">
        <img src="${qrUrl}" alt="Código QR del ticket" width="220" height="220">
        <p style="color:#bbbbbb; font-size:11px; letter-spacing:0.04em; margin:10px 0 4px;">${ticketCode}</p>
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:4px auto 0;">
          <tr>
            <td bgcolor="#0a0a0a" style="background-color:#0a0a0a; border-radius:14px; padding:6px 14px;">
              <span style="color:${TICKET_ACCENT}; font-weight:800; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; font-family:Arial, sans-serif;">${groupLabel}</span>
            </td>
          </tr>
        </table>
      </div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td bgcolor="#0a0a0a" style="background-color:#0a0a0a; padding:18px 24px; text-align:center;">
            <p style="color:#cccccc; font-size:11px; margin:0 0 8px; font-family:Arial, sans-serif;">¿Tienes dudas? Escríbenos por WhatsApp o correo:</p>
            <p style="margin:0 0 6px; font-size:12px; font-family:Arial, sans-serif;">
              <a href="mailto:${TICKET_CONTACT_EMAIL}" style="color:${TICKET_ACCENT}; text-decoration:none; font-weight:400;">${TICKET_CONTACT_EMAIL}</a>
            </p>
            <p style="margin:0; font-size:12px; font-family:Arial, sans-serif;">
              ${TICKET_WHATSAPP_NUMBERS.map((wa) => `<a href="https://wa.me/${wa.number}?text=${waText}" style="color:${TICKET_ACCENT}; text-decoration:none; font-weight:400; margin:0 8px;">${wa.display}</a>`).join('·')}
            </p>
          </td>
        </tr>
      </table>

    </div>
    </body>
    </html>
  `;

  const { error } = await resend.emails.send({
    from: `Ruby Haze <tickets@rubyhazemusic.com>`,
    replyTo: TICKET_CONTACT_EMAIL,
    to: email,
    // Asunto único por ticket (no solo por evento): si dos correos a la misma
    // bandeja comparten asunto idéntico, Gmail los agrupa en una sola
    // conversación y empieza a colapsar bajo "..." el texto que se repite
    // igual en cada uno (la firma y el pie de contacto).
    subject: quantity > 1
      ? `Tu ticket (grupo de ${quantity}) — ${EVENT.name} · ${ticketCode}`
      : `Tu ticket — ${EVENT.name} · ${ticketCode}`,
    html
  });
  if (error) throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
}

// Reintenta hasta 4 veces (con pausa de 1.5s entre cada una) tanto si
// Payphone responde sin transactionStatus todavía como si la llamada falla
// del todo (timeout, error de red): un solo hiccup puntual con Payphone no
// debe perder una venta cuya tarjeta ya fue cobrada.
async function payphoneConfirmWithRetries(payload, maxAttempts = 4) {
  let lastData = null;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { data } = await payphonePost('/api/button/V2/Confirm', payload);
      lastData = data;
      lastErr = null;
      if (data.transactionStatus) return data;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxAttempts - 1) await sleep(1500);
  }
  if (lastData) return lastData;
  throw lastErr;
}

app.use(express.static(__dirname));
app.use(express.json());

// El fetch nativo de Node (undici) recibe un 500 "Runtime Error" de la API
// de Payphone por alguna incompatibilidad de bajo nivel; el módulo https
// nativo funciona igual que curl, así que lo usamos para esta llamada.
function payphonePost(hostPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'pay.payphonetodoesposible.com',
        path: hostPath,
        method: 'POST',
        timeout: 10000,
        headers: {
          Authorization: `Bearer ${PAYPHONE_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (err) {
            reject(new Error('Respuesta no válida de Payphone: ' + data.slice(0, 200)));
          }
        });
      }
    );
    // Si Payphone no responde ni cierra la conexión, evita que la promesa
    // se quede colgada para siempre (esto bloqueaba toda la confirmación).
    req.on('timeout', () => req.destroy(new Error('Timeout esperando respuesta de Payphone')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Se llama justo antes de mostrar el botón de pago (ver renderPaymentButton
// en ticketsTHETRIBEPTII.html), para dejar el nombre ya guardado de nuestro
// lado antes de que el comprador llegue a pagar.
app.post('/api/tickets/intent', (req, res) => {
  const { clientTransactionId, cardholderName } = req.body || {};
  if (!clientTransactionId || !cardholderName) {
    return res.status(400).json({ ok: false });
  }
  cleanupPendingPurchases();
  pendingPurchases.set(clientTransactionId, {
    cardholderName: String(cardholderName).trim(),
    createdAt: Date.now()
  });
  res.json({ ok: true });
});

// La Cajita de Payphone hace el Prepare directo desde el navegador.
// Aquí solo confirmamos el pago de forma segura contra la API real de Payphone.
app.post('/api/payphone/confirm', async (req, res) => {
  const { id, clientTransactionId } = req.body || {};
  if (!id || !clientTransactionId) {
    return res.status(400).json({ error: 'Faltan datos de confirmación.' });
  }

  const transactionId = Number(id);

  if (usedTransactions.has(transactionId)) {
    return res.json({ success: false, status: 'AlreadyUsed' });
  }

  const payload = { id: transactionId, clientTxId: clientTransactionId };

  try {
    const data = await payphoneConfirmWithRetries(payload);

    if (data.transactionStatus === 'Approved') {
      // Se marca como usada ANTES de responder: si dos peticiones llegan casi
      // al mismo tiempo, solo una debe poder mostrar éxito y notificar.
      if (usedTransactions.has(transactionId)) {
        return res.json({ success: false, status: 'AlreadyUsed' });
      }
      usedTransactions.add(transactionId);

      const quantity = quantityFromAmount(Number(data.amount), data.optionalParameter1);
      // El nombre lo escribió el comprador en nuestra página y quedó
      // guardado por clientTransactionId vía /api/tickets/intent;
      // optionalParameter4 (autocompletado por Payphone) queda solo de respaldo.
      const pending = pendingPurchases.get(clientTransactionId);
      pendingPurchases.delete(clientTransactionId);
      const cardholderName = (pending && pending.cardholderName) || (data.optionalParameter4 || '').trim();
      const ticketCode = `RH-${data.transactionId}`;
      const listNumber = registerIssuedTicket(ticketCode, {
        transactionId: data.transactionId,
        cardholderName,
        document: data.document,
        quantity,
        email: data.email,
        phoneNumber: data.phoneNumber
      });
      syncToSheet(issuedTickets[ticketCode]);

      const ticket = {
        transactionId: data.transactionId,
        email: data.email,
        phoneNumber: data.phoneNumber,
        document: data.document,
        cardholderName,
        quantity,
        ticketCode,
        listNumber
      };

      // No debe bloquear la respuesta al comprador: se dispara en segundo
      // plano y está limitado por un timeout duro. El aviso al admin
      // (Web3Forms) se hace desde el navegador, ver confirm.html — su plan
      // gratuito rechaza envíos hechos directamente desde un servidor.
      sendTicketEmail(ticket)
        .then(() => console.log('Ticket enviado por correo a', ticket.email))
        .catch((mailErr) => console.error('Error enviando el ticket por correo:', mailErr));

      return res.json({ success: true, ...ticket });
    }
    res.json({ success: false, status: data.transactionStatus || 'Desconocido' });
  } catch (err) {
    console.error('Payphone Confirm exception:', err);
    res.status(500).json({ error: 'Error de conexión con Payphone.' });
  }
});

// Solo el personal de la puerta, con la clave de escaneo, puede usar estas rutas.
function requireScanKey(req, res, next) {
  const key = (req.headers['x-scan-key'] || '').trim();
  if (!SCAN_PASSWORD || key !== SCAN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Paso 1: al escanear, solo consulta los datos del ticket (no lo marca como
// usado todavía) para que el personal lo coteje contra la lista impresa.
app.post('/api/tickets/lookup', requireScanKey, (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  const ticket = issuedTickets[code];

  if (!ticket) {
    return res.json({ found: false });
  }

  const entriesApproved = typeof ticket.entriesApproved === 'number'
    ? ticket.entriesApproved
    : (ticket.used ? ticket.quantity : 0);
  const remaining = ticketRemaining(ticket);

  res.json({
    found: true,
    code,
    listNumber: ticket.listNumber,
    cardholderName: ticket.cardholderName,
    document: ticket.document,
    quantity: ticket.quantity,
    entriesApproved,
    remaining,
    used: remaining <= 0,
    usedAt: ticket.usedAt
  });
});

// Paso 2: el personal confirma manualmente contra la lista impresa y aprueba
// el ingreso. Tickets de grupo (quantity > 1) admiten ingresos parciales: se
// puede aprobar de a `count` personas por escaneo, y el QR solo queda muerto
// cuando ya entraron todas las que cubría el ticket.
app.post('/api/tickets/approve', requireScanKey, (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  const ticket = issuedTickets[code];

  if (!ticket) {
    return res.json({ approved: false, reason: 'not_found' });
  }

  const remaining = ticketRemaining(ticket);
  if (remaining <= 0) {
    return res.json({ approved: false, reason: 'already_used', usedAt: ticket.usedAt });
  }

  const requested = parseInt(req.body && req.body.count, 10);
  const count = Math.min(remaining, Math.max(1, Number.isFinite(requested) ? requested : remaining));

  ticket.entriesApproved = (typeof ticket.entriesApproved === 'number' ? ticket.entriesApproved : 0) + count;
  ticket.usedAt = new Date().toISOString();
  saveIssuedTickets();

  res.json({
    approved: true,
    code,
    cardholderName: ticket.cardholderName,
    listNumber: ticket.listNumber,
    quantity: ticket.quantity,
    approvedNow: count,
    entriesApproved: ticket.entriesApproved,
    remaining: ticketRemaining(ticket)
  });
});

// Imagen del QR usada dentro del correo del ticket (ver sendTicketEmail). El
// código del ticket ya va en texto plano dentro del mismo correo, así que
// esta ruta no expone nada que no esté ahí ya.
app.get('/api/tickets/qr/:code', async (req, res) => {
  try {
    const buffer = await QRCode.toBuffer(req.params.code, { width: 320, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    res.status(400).end();
  }
});

// Lista completa para imprimir antes del evento (respaldo en papel).
app.get('/api/tickets/list', requireScanKey, (req, res) => {
  const list = Object.entries(issuedTickets)
    .map(([code, t]) => ({ code, ...t }))
    .sort((a, b) => a.listNumber - b.listNumber);
  res.json({ list });
});

// Permite abrir cualquier página estática sin escribir ".html" en la URL
// (ej. /ticketsTHETRIBEPTII en vez de /ticketsTHETRIBEPTII.html). El archivo
// con extensión sigue funcionando igual, esto solo agrega la alternativa.
app.get(/^\/[\w-]+$/, (req, res, next) => {
  const htmlPath = path.join(__dirname, req.path + '.html');
  fs.access(htmlPath, fs.constants.F_OK, (err) => {
    if (err) return next();
    res.sendFile(htmlPath);
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ruby Haze running on port ${PORT}`);
});
