// src/licenca.js
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

// Gera ID único da máquina
function getMachineId() {
  const dados = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || '',
    os.totalmem().toString()
  ].join('|');
  return crypto.createHash('sha256').update(dados).digest('hex').slice(0, 32);
}

function getLicencaPath(userDataPath) {
  return path.join(userDataPath, 'licenca.json');
}

function salvarLicenca(userDataPath, dados) {
  fs.writeFileSync(getLicencaPath(userDataPath), JSON.stringify(dados, null, 2));
}

function lerLicenca(userDataPath) {
  try {
    const raw = fs.readFileSync(getLicencaPath(userDataPath), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Faz requisição POST usando http/https nativo do Node (sem fetch)
function postRequest(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Resposta inválida do servidor')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

async function ativarChave(serverUrl, chave, machineId) {
  return postRequest(`${serverUrl}/api/ativar`, { chave, machine_id: machineId });
}

async function verificarOnline(serverUrl, chave, machineId) {
  return postRequest(`${serverUrl}/api/verificar`, { chave, machine_id: machineId });
}

module.exports = { getMachineId, salvarLicenca, lerLicenca, ativarChave, verificarOnline, getLicencaPath };