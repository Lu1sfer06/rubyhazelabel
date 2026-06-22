require('dotenv').config();
const express = require('express');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

const PAYPHONE_TOKEN = (process.env.PAYPHONE_TOKEN || '').trim();
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').trim();

// EDITAR: datos del evento mostrados en el correo del ticket.
const EVENT = {
  name: 'THE TRIBE PT.II',
  date: 'Sábado 01 de Agosto · 9:00 PM',
  place: 'Kuno Seafood Rooftop, Portoviejo'
};

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 8000
});

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

async function sendTicketEmail({ email, cardholderName, transactionId }) {
  const ticketCode = `RH-${transactionId}`;
  const qrBuffer = await QRCode.toBuffer(ticketCode, { width: 320, margin: 2 });

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; border: 1px solid #eee;">
      <h1 style="color:#a2031a; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 4px;">Ruby Haze</h1>
      <p style="color:#a2031a; font-weight: bold; font-size: 18px; margin: 0 0 4px;">${EVENT.name}</p>
      <p style="color:#888; margin: 0 0 24px;">${EVENT.date} · ${EVENT.place}</p>
      <p style="margin: 0 0 4px;">Hola <strong>${cardholderName || ''}</strong>,</p>
      <p style="margin: 0 0 24px;">Gracias por tu compra. Este es tu ticket — preséntalo (impreso o en tu celular) en la entrada del evento.</p>
      <div style="text-align:center; margin-bottom: 24px;">
        <img src="cid:qrcode" alt="Código QR del ticket" width="240" height="240">
        <p style="color:#888; font-size: 12px; margin-top: 8px;">${ticketCode}</p>
      </div>
      <p style="color:#888; font-size: 12px;">Si tienes dudas, contáctanos por WhatsApp respondiendo a este correo.</p>
    </div>
  `;

  await mailer.sendMail({
    from: `"Ruby Haze" <${GMAIL_USER}>`,
    to: email,
    subject: `Tu ticket — ${EVENT.name}`,
    html,
    attachments: [{ filename: 'ticket-qr.png', content: qrBuffer, cid: 'qrcode' }]
  });
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

      const ticket = {
        transactionId: data.transactionId,
        email: data.email,
        phoneNumber: data.phoneNumber,
        document: data.document,
        cardholderName: data.optionalParameter4
      };

      // No debe bloquear la respuesta al comprador: se dispara en segundo
      // plano y está limitado por un timeout duro. El aviso al admin
      // (Web3Forms) se hace desde el navegador, ver confirm.html — su plan
      // gratuito rechaza envíos hechos directamente desde un servidor.
      withTimeout(sendTicketEmail(ticket), 8000, 'sendTicketEmail')
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ruby Haze running on port ${PORT}`);
});
