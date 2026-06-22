require('dotenv').config();
const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const PAYPHONE_TOKEN = process.env.PAYPHONE_TOKEN;

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

  const payload = { id: Number(id), clientTxId: clientTransactionId };

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
      return res.json({
        success: true,
        transactionId: data.transactionId,
        email: data.email,
        phoneNumber: data.phoneNumber,
        document: data.document,
        cardholderName: data.optionalParameter4
      });
    }
    res.json({ success: false, status: data.transactionStatus || 'Desconocido', debug: data });
  } catch (err) {
    console.error('Payphone Confirm exception:', err);
    res.status(500).json({ error: 'Error de conexión con Payphone.', debug: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ruby Haze running on port ${PORT}`);
});
