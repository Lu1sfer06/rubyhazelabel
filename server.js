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
const PROMO_PRICE_USD = 11.68;

function pricePerTicket(qty) {
  return qty === PROMO_QTY ? PROMO_PRICE_USD : PRICE_USD;
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
// persiste a disco para sobrevivir un reinicio del proceso durante el
// evento; un *redeploy* en Railway sí lo borra, así que no se debe hacer
// push de código mientras el evento está en curso.
const TICKETS_DB_PATH = path.join(__dirname, 'tickets-db.json');

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

function registerIssuedTicket(code, { transactionId, cardholderName, document, quantity }) {
  const listNumber = Object.keys(issuedTickets).length + 1;
  issuedTickets[code] = {
    listNumber,
    transactionId,
    cardholderName: cardholderName || '',
    document: document || '',
    quantity,
    used: false,
    usedAt: null
  };
  saveIssuedTickets();
  return listNumber;
}

function ticketGroupLabel(quantity) {
  return quantity === 1 ? 'Entrada individual' : `Entrada de ${quantity} personas`;
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
    ? `Gracias por asegurar tu entrada para <strong>${EVENT.name}</strong> — este ticket es para tu grupo de ${quantity} personas (tú + ${quantity - 1} acompañante${quantity - 1 > 1 ? 's' : ''}). Estamos felices de que formes parte, ¡deben ingresar todos juntos! Nos vemos en la pista de baile.`
    : `Gracias por asegurar tu entrada para <strong>${EVENT.name}</strong>. Estamos felices de que formes parte, ¡preséntalo (impreso o en tu celular) en la entrada! Nos vemos en la pista de baile.`;

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
      </div>

      <div style="border-top:2px dashed #dddddd; margin:22px 24px 0;"></div>

      <div style="padding:22px 24px; text-align:center;">
        <img src="${qrUrl}" alt="Código QR del ticket" width="220" height="220">
        <p style="color:#bbbbbb; font-size:11px; letter-spacing:0.04em; margin:10px 0 4px;">${ticketCode}</p>
        <p style="display:inline-block; background:#0a0a0a !important; color:${TICKET_ACCENT} !important; font-weight:800; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; padding:6px 14px; border-radius:14px; margin-top:4px;">${groupLabel}</p>
      </div>

      <div style="background:#0a0a0a !important; padding:18px 24px; text-align:center;">
        <p style="color:rgba(255,255,255,0.5) !important; font-size:11px; margin:0 0 8px;">¿Tienes dudas? Escríbenos por WhatsApp o correo:</p>
        <p style="margin:0 0 6px; font-size:12px;">
          <a href="mailto:${TICKET_CONTACT_EMAIL}" style="color:${TICKET_ACCENT} !important; text-decoration:none; font-weight:400;">${TICKET_CONTACT_EMAIL}</a>
        </p>
        <p style="margin:0; font-size:12px;">
          ${TICKET_WHATSAPP_NUMBERS.map((wa) => `<a href="https://wa.me/${wa.number}?text=${waText}" style="color:${TICKET_ACCENT} !important; text-decoration:none; font-weight:400; margin:0 8px;">${wa.display}</a>`).join('·')}
        </p>
      </div>

      <div style="padding:14px 24px; text-align:center;">
        <p style="margin:0; color:#999999; font-size:11px; letter-spacing:0.05em; text-transform:uppercase;">Ruby Haze Team</p>
      </div>

    </div>
    </body>
    </html>
  `;

  const { error } = await resend.emails.send({
    from: `Ruby Haze <tickets@rubyhazemusic.com>`,
    replyTo: TICKET_CONTACT_EMAIL,
    to: email,
    subject: quantity > 1 ? `Tu ticket (grupo de ${quantity}) — ${EVENT.name}` : `Tu ticket — ${EVENT.name}`,
    html
  });
  if (error) throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
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
    let { data } = await payphonePost('/api/button/V2/Confirm', payload);

    // Justo después del redirect, Payphone a veces todavía no terminó de
    // resolver el estado interno de la transacción. Reintentamos un par de
    // veces con una breve espera antes de darla por desconocida.
    let attempts = 0;
    while (!data.transactionStatus && attempts < 3) {
      await sleep(1500);
      ({ data } = await payphonePost('/api/button/V2/Confirm', payload));
      attempts++;
    }

    if (data.transactionStatus === 'Approved') {
      // Se marca como usada ANTES de responder: si dos peticiones llegan casi
      // al mismo tiempo, solo una debe poder mostrar éxito y notificar.
      if (usedTransactions.has(transactionId)) {
        return res.json({ success: false, status: 'AlreadyUsed' });
      }
      usedTransactions.add(transactionId);

      const quantity = quantityFromAmount(Number(data.amount), data.optionalParameter1);
      // optionalParameter2 es el nombre que el comprador escribió en nuestra
      // propia página; optionalParameter4 es el que Payphone autocompleta
      // desde el formulario de tarjeta, pero no siempre llega.
      const cardholderName = (data.optionalParameter2 || data.optionalParameter4 || '').trim();
      const ticketCode = `RH-${data.transactionId}`;
      const listNumber = registerIssuedTicket(ticketCode, {
        transactionId: data.transactionId,
        cardholderName,
        document: data.document,
        quantity
      });

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

  res.json({
    found: true,
    code,
    listNumber: ticket.listNumber,
    cardholderName: ticket.cardholderName,
    document: ticket.document,
    quantity: ticket.quantity,
    used: ticket.used,
    usedAt: ticket.usedAt
  });
});

// Paso 2: el personal confirma manualmente contra la lista impresa y aprueba
// la entrada — a partir de aquí ese código ya no es válido.
app.post('/api/tickets/approve', requireScanKey, (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  const ticket = issuedTickets[code];

  if (!ticket) {
    return res.json({ approved: false, reason: 'not_found' });
  }
  if (ticket.used) {
    return res.json({ approved: false, reason: 'already_used', usedAt: ticket.usedAt });
  }

  ticket.used = true;
  ticket.usedAt = new Date().toISOString();
  saveIssuedTickets();

  res.json({ approved: true, code, cardholderName: ticket.cardholderName, listNumber: ticket.listNumber });
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
