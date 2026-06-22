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

// La Cajita de Payphone hace el Prepare directo desde el navegador.
// Aquí solo confirmamos el pago de forma segura contra la API real de Payphone.
app.post('/api/payphone/confirm', async (req, res) => {
  const { id, clientTransactionId } = req.body || {};
  if (!id || !clientTransactionId) {
    return res.status(400).json({ error: 'Faltan datos de confirmación.' });
  }

  try {
    const { data } = await payphonePost('/api/button/V2/Confirm', {
      id: Number(id),
      clientTxId: clientTransactionId
    });

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
