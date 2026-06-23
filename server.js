require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Resend } = require('resend');
const QRCode = require('qrcode');
const sharp = require('sharp');

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

// Debe coincidir exactamente con CONFIG/MAX_QTY en ticketsTHETRIBEPTII.html
// — se usa para deducir la cantidad de tickets a partir del monto realmente
// cobrado, ya que los optionalParameter que le pasamos a la Cajita de
// Payphone no siempre llegan de vuelta en el Confirm.
const MAX_QTY = 5;
const PRICE_USD = 15.92;
// TEMPORAL: precio de prueba con Payphone en modo real, solo para 1 entrada
// individual. Quitar y volver a usar PRICE_USD una vez hecha la prueba.
const TEST_SINGLE_PRICE_USD = 1.00;

function pricePerTicket(qty) {
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

// Aproxima el ancho de cada carácter para partir un texto en líneas que
// quepan en maxWidthPx — SVG no hace word-wrap solo, hay que calcularlo.
function wrapTextLines(text, maxWidthPx, fontSizePx) {
  const avgCharWidth = fontSizePx * 0.52;
  const maxChars = Math.max(10, Math.floor(maxWidthPx / avgCharWidth));
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const TICKET_HEADER_IMAGE_B64 = fs.readFileSync(path.join(__dirname, 'eventos', 'ticket-header.png')).toString('base64');

// El servidor (Railway) no tiene por qué tener ninguna fuente de letra
// instalada, y tampoco se puede confiar en que el librsvg que trae `sharp`
// ahí soporte cargar fuentes (@font-face) — se probaron ambas cosas y
// ninguna funcionó en producción aunque sí localmente. La forma que SÍ
// funciona en cualquier entorno es convertir cada letra directamente en su
// contorno vectorial con la fuente (vía opentype.js) y dibujar eso como
// <path>: ya no es "texto" para el renderizador, es pura forma geométrica.
const opentype = require('opentype.js');
function loadFont(filename) {
  const buf = fs.readFileSync(path.join(__dirname, 'assets', 'fonts', filename));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const TICKET_FONT_REGULAR = loadFont('DejaVuSans.ttf');
const TICKET_FONT_BOLD = loadFont('DejaVuSans-Bold.ttf');

// Se evita font.getPath(string) porque dispara el pipeline de sustitución
// de glyphs (ligaduras/GSUB) y algunas fuentes traen tablas que opentype.js
// no soporta del todo. Yendo letra por letra se evita ese pipeline.
function measureText(font, text, fontSize) {
  const scale = fontSize / font.unitsPerEm;
  let width = 0;
  for (const ch of text) width += (font.charToGlyph(ch).advanceWidth || 0) * scale;
  return width;
}
function textPathD(font, text, x, y, fontSize) {
  const scale = fontSize / font.unitsPerEm;
  let cx = x;
  const combined = new opentype.Path();
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    combined.extend(glyph.getPath(cx, y, fontSize));
    cx += (glyph.advanceWidth || 0) * scale;
  }
  return { d: combined.toPathData(2), endX: cx };
}
// `runs`: [{ text, font, fontSize, fill }] — varios tramos (ej. regular +
// bold + regular) centrados juntos como una sola línea.
function centeredTextRuns(runs, centerX, y) {
  const totalWidth = runs.reduce((sum, r) => sum + measureText(r.font, r.text, r.fontSize), 0);
  let x = centerX - totalWidth / 2;
  return runs.map((r) => {
    const { d, endX } = textPathD(r.font, r.text, x, y, r.fontSize);
    x = endX;
    return `<path d="${d}" fill="${r.fill}"/>`;
  }).join('');
}
function centeredText(text, centerX, y, fontSize, fill, bold) {
  return centeredTextRuns([{ text, font: bold ? TICKET_FONT_BOLD : TICKET_FONT_REGULAR, fontSize, fill }], centerX, y);
}

// Compone el ticket completo (foto + texto + QR + pie) como una sola imagen
// PNG, para que la persona pueda descargarlo de un solo toque en vez de
// guardar fragmentos sueltos (la foto de fondo o el QR por separado).
async function composeTicketImage({ ticketCode, cardholderName, quantity }) {
  const isGuest = ticketCode.startsWith('RH-MANUAL');
  const WIDTH = 640;
  const PAD = 36;
  const contentWidth = WIDTH - PAD * 2;
  const headerH = Math.round(WIDTH * 480 / 840);
  const CX = WIDTH / 2;

  const qrSize = 300;
  const qrBuffer = await QRCode.toBuffer(ticketCode, { width: qrSize * 2, margin: 1 });
  const qrB64 = qrBuffer.toString('base64');

  const name = cardholderName || '';
  const groupLabel = (isGuest ? 'Acceso de cortesía' : ticketGroupLabel(quantity)).toUpperCase();
  const introText = isGuest
    ? `Esta es tu entrada de cortesía para ${EVENT.name}, cortesía de Ruby Haze. Preséntala (impresa o en tu celular) en la entrada.`
    : (quantity > 1
        ? `Tu ticket para ${EVENT.name} es válido para ${quantity} personas. Cotéjalo con la lista en la puerta.`
        : `Tu ticket para ${EVENT.name}. Preséntalo (impreso o en tu celular) en la entrada.`);
  const introLines = wrapTextLines(introText, contentWidth, 15);

  const parts = [];
  let y = headerH;

  if (isGuest) {
    const bannerH = 92;
    parts.push(`<rect x="0" y="${y}" width="${WIDTH}" height="${bannerH}" fill="${TICKET_ACCENT}"/>`);
    parts.push(centeredText('RUBY HAZE GUEST TICKET', CX, y + 34, 12, '#0a0a0a', true));
    parts.push(centeredText('INVITADO / A', CX, y + 68, 30, '#0a0a0a', true));
    y += bannerH;
  }

  y += 34;
  parts.push(name
    ? centeredTextRuns([
        { text: 'Hola ', font: TICKET_FONT_REGULAR, fontSize: 17, fill: '#111111' },
        { text: name, font: TICKET_FONT_BOLD, fontSize: 17, fill: '#111111' },
        { text: ',', font: TICKET_FONT_REGULAR, fontSize: 17, fill: '#111111' }
      ], CX, y)
    : centeredText('Hola,', CX, y, 17, '#111111', false));
  y += 28;

  for (const line of introLines) {
    parts.push(centeredText(line, CX, y, 14, '#555555', false));
    y += 21;
  }
  y += 12;
  parts.push(centeredText('RUBY HAZE TEAM', CX, y, 11, '#999999', false));
  y += 30;

  parts.push(`<line x1="${PAD}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}" stroke="${isGuest ? TICKET_ACCENT : '#dddddd'}" stroke-width="2" stroke-dasharray="6,6"/>`);
  y += 36;

  const qrBoxPad = isGuest ? 14 : 0;
  const qrBoxSize = qrSize + qrBoxPad * 2;
  const qrX = (WIDTH - qrBoxSize) / 2;
  if (isGuest) {
    parts.push(`<rect x="${qrX}" y="${y}" width="${qrBoxSize}" height="${qrBoxSize}" rx="18" fill="none" stroke="${TICKET_ACCENT}" stroke-width="3"/>`);
  }
  parts.push(`<image x="${qrX + qrBoxPad}" y="${y + qrBoxPad}" width="${qrSize}" height="${qrSize}" href="data:image/png;base64,${qrB64}"/>`);
  y += qrBoxSize + 16;

  parts.push(centeredText(ticketCode, CX, y, 12, '#bbbbbb', false));
  y += 26;

  const pillW = Math.max(190, groupLabel.length * 9 + 60);
  parts.push(`<rect x="${(WIDTH - pillW) / 2}" y="${y}" width="${pillW}" height="36" rx="14" fill="#0a0a0a"/>`);
  parts.push(centeredText(groupLabel, CX, y + 24, 13, TICKET_ACCENT, true));
  y += 36 + 34;

  const footerH = 96;
  parts.push(`<rect x="0" y="${y}" width="${WIDTH}" height="${footerH}" fill="#0a0a0a"/>`);
  parts.push(centeredText('¿Tienes dudas? Escríbenos:', CX, y + 30, 12, '#cccccc', false));
  parts.push(centeredText(TICKET_CONTACT_EMAIL, CX, y + 54, 12, TICKET_ACCENT, false));
  parts.push(centeredText(TICKET_WHATSAPP_NUMBERS.map((w) => w.display).join('   ·   '), CX, y + 76, 11, TICKET_ACCENT, false));
  y += footerH;

  const totalH = Math.ceil(y);
  const svg = `<svg width="${WIDTH}" height="${totalH}" viewBox="0 0 ${WIDTH} ${totalH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${WIDTH}" height="${totalH}" fill="#ffffff"/>
    <image x="0" y="0" width="${WIDTH}" height="${headerH}" href="data:image/png;base64,${TICKET_HEADER_IMAGE_B64}"/>
    ${parts.join('\n')}
    <rect x="1" y="1" width="${WIDTH - 2}" height="${totalH - 2}" rx="18" fill="none" stroke="${isGuest ? TICKET_ACCENT : '#eeeeee'}" stroke-width="${isGuest ? 3 : 1}"/>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function sendTicketEmail({ email, cardholderName, quantity, ticketCode }) {
  // Se sirve como imagen normal desde /api/tickets/qr en vez de adjunto con
  // cid: así carga igual de bien que los logos/foto de fondo en cualquier
  // cliente de correo, sin depender de si el proveedor soporta imágenes
  // incrustadas en el envío.
  const qrUrl = `https://rubyhazemusic.com/api/tickets/qr/${encodeURIComponent(ticketCode)}`;
  // Los tickets creados con /api/tickets/create-manual (cortesía, sin pago
  // real) usan el prefijo RH-MANUAL — con eso basta para darle el diseño
  // dorado especial sin necesitar un parámetro aparte en cada llamada.
  const isGuest = ticketCode.startsWith('RH-MANUAL');
  const groupLabel = isGuest ? 'Acceso de cortesía' : ticketGroupLabel(quantity);
  const waText = encodeURIComponent(`Hola, tengo una consulta sobre mi ticket/QR ya adquirido para ${EVENT.name}.`);

  const greetingName = cardholderName ? ` <strong>${cardholderName}</strong>` : '';
  const intro = isGuest
    ? `Esta es tu entrada de cortesía para <strong>${EVENT.name}</strong>, cortesía de Ruby Haze. ¡Preséntala (impresa o en tu celular) en la entrada! Nos vemos en la pista de baile.`
    : quantity > 1
      ? `Gracias por asegurar tu ticket para <strong>${EVENT.name}</strong> — es válido para ${quantity} personas, cotéjalo con la lista en la puerta. Estamos felices de que formen parte. Nos vemos en la pista de baile.`
      : `Gracias por asegurar tu ticket para <strong>${EVENT.name}</strong>. Estamos felices de que formes parte, ¡preséntalo (impreso o en tu celular) en la entrada! Nos vemos en la pista de baile.`;

  const guestBanner = isGuest ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td bgcolor="${TICKET_ACCENT}" style="background:linear-gradient(135deg, #f0e58a, ${TICKET_ACCENT} 45%, #b8972a); padding:14px 24px; text-align:center;">
            <p style="margin:0; color:#0a0a0a; font-size:10px; letter-spacing:0.18em; font-weight:700; text-transform:uppercase; font-family:Arial, sans-serif;">Ruby Haze Guest Ticket</p>
            <p style="margin:2px 0 0; color:#0a0a0a; font-size:24px; letter-spacing:0.04em; font-weight:900; text-transform:uppercase; font-family:Arial, sans-serif;">Invitado / A</p>
          </td>
        </tr>
      </table>
  ` : '';

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
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; background:#ffffff; border-radius:18px; overflow:hidden; border:${isGuest ? `2px solid ${TICKET_ACCENT}` : '1px solid #eee'};">

      <img src="https://rubyhazemusic.com/eventos/ticket-header.png" alt="${EVENT.name}" width="420" style="display:block; width:100%; max-width:420px; height:auto;">
      ${guestBanner}

      <div style="padding:26px 24px 4px;">
        <p style="margin:0 0 4px; color:#111111; font-size:14px; text-align:center;">Hola${greetingName},</p>
        <p style="margin:0; color:#555555; font-size:13px; line-height:1.6; text-align:center;">${intro}</p>
        <p style="margin:14px 0 0; color:#999999; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; text-align:center;">Ruby Haze Team</p>
      </div>

      <div style="border-top:2px dashed ${isGuest ? TICKET_ACCENT : '#dddddd'}; margin:22px 24px 0;"></div>

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
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto 0;">
          <tr>
            <td bgcolor="${TICKET_ACCENT}" style="background-color:${TICKET_ACCENT}; border-radius:10px;">
              <a href="https://rubyhazemusic.com/api/tickets/image/${encodeURIComponent(ticketCode)}" style="display:block; padding:11px 22px; color:#0a0a0a; font-weight:800; font-size:12px; letter-spacing:0.04em; text-transform:uppercase; text-decoration:none; font-family:Arial, sans-serif;">Descargar tu ticket</a>
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
    subject: isGuest
      ? `Tu entrada de invitado — ${EVENT.name} · ${ticketCode}`
      : quantity > 1
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
      // TEMPORAL: para diagnosticar por qué a veces no llega correo/teléfono
      // al Sheet — confirma qué campos manda Payphone realmente. Quitar una
      // vez resuelto.
      console.log('Payphone Confirm data (Approved):', JSON.stringify({
        email: data.email,
        phoneNumber: data.phoneNumber,
        document: data.document,
        optionalParameter1: data.optionalParameter1,
        optionalParameter2: data.optionalParameter2,
        optionalParameter3: data.optionalParameter3,
        optionalParameter4: data.optionalParameter4
      }));
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
// Borra todo el registro de tickets emitidos (uso manual: limpiar datos de
// prueba antes de la venta real). Como ahora vive en un volumen persistente,
// ya no se borra solo con un redeploy, así que esta ruta es la forma de
// reiniciarlo cuando se pida explícitamente. No toca el Sheet ni el
// contador del escáner (localStorage) — esos se limpian por separado.
app.post('/api/tickets/wipe', requireScanKey, (req, res) => {
  const removed = Object.keys(issuedTickets).length;
  for (const code of Object.keys(issuedTickets)) {
    delete issuedTickets[code];
  }
  usedTransactions.clear();
  pendingPurchases.clear();
  saveIssuedTickets();
  res.json({ wiped: true, removed });
});

// Recupera manualmente un ticket real que se perdió del registro en vivo
// (ej. por un redeploy antes de tener el volumen persistente). No usa
// usedTransactions porque es solo para reponer el registro de validez, no
// para volver a confirmar un cobro.
app.post('/api/tickets/restore', requireScanKey, (req, res) => {
  const { transactionId, cardholderName, document, quantity, email, phoneNumber } = req.body || {};
  if (!transactionId || !quantity) {
    return res.status(400).json({ error: 'Faltan transactionId o quantity.' });
  }
  const ticketCode = `RH-${transactionId}`;
  if (issuedTickets[ticketCode]) {
    return res.json({ restored: false, reason: 'ya existe', ticketCode });
  }
  const listNumber = registerIssuedTicket(ticketCode, {
    transactionId: Number(transactionId),
    cardholderName,
    document,
    quantity: Number(quantity),
    email,
    phoneNumber
  });
  res.json({ restored: true, ticketCode, listNumber });
});

// Contrario de /restore: desactiva un ticket puntual (ej. compra revertida,
// reembolso, duplicado, ticket de prueba) sin afectar a los demás. Se le
// puede pasar `code` (ej. "RH-87718296") o directamente `transactionId`.
app.post('/api/tickets/deactivate', requireScanKey, (req, res) => {
  const { code, transactionId } = req.body || {};
  const ticketCode = (code || (transactionId ? `RH-${transactionId}` : '')).trim();
  if (!ticketCode) {
    return res.status(400).json({ error: 'Falta code o transactionId.' });
  }
  if (!issuedTickets[ticketCode]) {
    return res.json({ deactivated: false, reason: 'no existe', ticketCode });
  }
  // No se borra: solo se marca como desactivado, para poder reactivarlo
  // después con /api/tickets/activate pasando únicamente el código.
  issuedTickets[ticketCode].disabled = true;
  saveIssuedTickets();
  res.json({ deactivated: true, ticketCode });
});

// Simétrico a /deactivate: con solo el código vuelve a dejar válido un
// ticket que se había desactivado (no recupera uno borrado del todo — para
// eso está /restore).
app.post('/api/tickets/activate', requireScanKey, (req, res) => {
  const { code, transactionId } = req.body || {};
  const ticketCode = (code || (transactionId ? `RH-${transactionId}` : '')).trim();
  if (!ticketCode) {
    return res.status(400).json({ error: 'Falta code o transactionId.' });
  }
  if (!issuedTickets[ticketCode]) {
    return res.json({ activated: false, reason: 'no existe', ticketCode });
  }
  delete issuedTickets[ticketCode].disabled;
  saveIssuedTickets();
  res.json({ activated: true, ticketCode });
});

// Ticket de cortesía/invitado, sin pago real de por medio: genera su propio
// código (prefijo MANUAL en vez de un Transaction ID de Payphone) y lo deja
// igual de válido para el escáner. Si se da un correo, se le envía el ticket
// con su QR igual que a una compra normal.
app.post('/api/tickets/create-manual', requireScanKey, async (req, res) => {
  const { cardholderName, document, quantity, email, phoneNumber, guestListNumber } = req.body || {};
  if (!cardholderName) {
    return res.status(400).json({ error: 'Falta cardholderName.' });
  }
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const ticketCode = `RH-MANUAL${Date.now()}`;
  const listNumber = registerIssuedTicket(ticketCode, {
    transactionId: `MANUAL-${Date.now()}`,
    cardholderName,
    document: document || '',
    quantity: qty,
    email: email || '',
    phoneNumber: phoneNumber || ''
  });
  // El número interno (listNumber) cuenta TODOS los tickets del servidor,
  // no tiene relación con la posición en la lista de invitados manual del
  // usuario. Si se da guestListNumber, el escáner muestra ese en su lugar.
  if (guestListNumber) {
    issuedTickets[ticketCode].guestListNumber = guestListNumber;
    saveIssuedTickets();
  }
  // A propósito NO se sincroniza al Sheet ("Individuales"/"Grupos"): esas
  // pestañas son solo para ventas reales, no para cortesías/invitados. El
  // control de invitados vive aparte, en la pestaña "Lista de invitados"
  // que se maneja a mano.

  if (email) {
    sendTicketEmail({ email, cardholderName, quantity: qty, ticketCode })
      .catch((err) => console.error('Error enviando ticket manual:', err));
  }

  res.json({
    created: true,
    ticketCode,
    listNumber,
    qrUrl: `https://rubyhazemusic.com/api/tickets/qr/${encodeURIComponent(ticketCode)}`
  });
});

// Para invitados que se crean sin correo todavía (solo nombre, ya válidos
// para escanear) y luego sí lo mandan: envía el ticket YA EXISTENTE a ese
// correo, en vez de crear uno nuevo con otro código/QR.
app.post('/api/tickets/send-email', requireScanKey, async (req, res) => {
  const { code, email } = req.body || {};
  const ticketCode = (code || '').trim();
  if (!ticketCode || !email) {
    return res.status(400).json({ error: 'Falta code o email.' });
  }
  const ticket = issuedTickets[ticketCode];
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket no encontrado.' });
  }
  ticket.email = email;
  saveIssuedTickets();
  try {
    await sendTicketEmail({ email, cardholderName: ticket.cardholderName, quantity: ticket.quantity, ticketCode });
    res.json({ sent: true });
  } catch (err) {
    console.error('Error enviando ticket existente:', err);
    res.status(500).json({ error: 'No se pudo enviar el correo.' });
  }
});

app.post('/api/tickets/lookup', requireScanKey, (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  const ticket = issuedTickets[code];

  if (!ticket || ticket.disabled) {
    return res.json({ found: false });
  }

  const entriesApproved = typeof ticket.entriesApproved === 'number'
    ? ticket.entriesApproved
    : (ticket.used ? ticket.quantity : 0);
  const remaining = ticketRemaining(ticket);

  res.json({
    found: true,
    code,
    isGuest: code.startsWith('RH-MANUAL'),
    listNumber: ticket.listNumber,
    guestListNumber: ticket.guestListNumber || null,
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

  if (!ticket || ticket.disabled) {
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

// Ticket completo (foto + texto + QR + pie) como una sola imagen para
// descargar de un solo toque desde el botón del correo.
app.get('/api/tickets/image/:code', async (req, res) => {
  const code = req.params.code;
  const ticket = issuedTickets[code];
  if (!ticket) {
    return res.status(404).send('Ticket no encontrado.');
  }
  try {
    const buffer = await composeTicketImage({
      ticketCode: code,
      cardholderName: ticket.cardholderName,
      quantity: ticket.quantity
    });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="ticket-ruby-haze-${code}.png"`);
    res.send(buffer);
  } catch (err) {
    console.error('Error generando imagen del ticket:', err);
    res.status(500).send('Error generando la imagen.');
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
