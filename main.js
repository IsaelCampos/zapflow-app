// main.js — Processo principal do Electron
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { autoUpdater } = require('electron-updater');

// ─── URL do servidor de licenças ──────────────────────────────────────────────
const SERVER_URL = 'https://astonishing-endurance-production-154b.up.railway.app';

let mainWindow;
let licencaValida       = false;
let waClient            = null;
let sendingActive       = false;
let verificacaoInterval = null;
let logger              = null;

const { getMachineId, lerLicenca, salvarLicenca, verificarOnline, getLicencaPath } = require('./src/licenca');

// ─── safeSend ─────────────────────────────────────────────────────────────────
function safeSend(channel, ...args) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send(channel, ...args);
    }
  } catch {}
}

// ─── Verificação periódica ────────────────────────────────────────────────────
function iniciarVerificacaoPeriodica() {
  if (verificacaoInterval) clearInterval(verificacaoInterval);
  verificacaoInterval = setInterval(() => {
    if (!licencaValida) return;
    verificarLicencaOnline();
  }, 1 * 60 * 1000);
}

async function verificarLicencaOnline() {
  const salva = lerLicenca(app.getPath('userData'));
  if (!salva || !salva.chave) return;
  try {
    const resultado = await verificarOnline(SERVER_URL, salva.chave, getMachineId());
    if (resultado && resultado.ok) {
      logger && logger.log.info('LICENCA', 'Verificação periódica OK');
    } else {
      licencaValida = false;
      clearInterval(verificacaoInterval);
      verificacaoInterval = null;
      logger && logger.log.warn('LICENCA', 'Licença inválida na verificação periódica', { erro: resultado?.erro });
      try { fs.unlinkSync(getLicencaPath(app.getPath('userData'))); } catch {}
      safeSend('licenca-status', { ok: false, acao: 'expirada', motivo: 'Licença suspensa ou expirada.' });
    }
  } catch (err) {
    logger && logger.log.warn('LICENCA', 'Falha na verificação periódica (rede?)', { erro: err.message });
  }
}

// ─── Janela ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720,
    minWidth: 900, minHeight: 600,
    frame: false, transparent: false,
    backgroundColor: '#0a0d0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Configuração do autoUpdater
  mainWindow.once('ready-to-show', () => {
    autoUpdater.checkForUpdatesAndNotify();
  });
}

// ─── Eventos do autoUpdater ───────────────────────────────────────────────────
autoUpdater.on('update-available', (info) => {
  logger && logger.log.info('AUTOUPDATE', 'Nova versão disponível', info);
  mainWindow.webContents.send('update_available', info);
});

autoUpdater.on('update-not-available', (info) => {
  logger && logger.log.info('AUTOUPDATE', 'Nenhuma atualização disponível');
});

autoUpdater.on('error', (err) => {
  logger && logger.log.erro('AUTOUPDATE', 'Erro no auto-updater', { erro: err.message });
});

autoUpdater.on('download-progress', (progressObj) => {
  logger && logger.log.info('AUTOUPDATE', `Download: ${progressObj.percent}%`);
  mainWindow.webContents.send('update_progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
  logger && logger.log.info('AUTOUPDATE', 'Atualização baixada. Pronto para instalar.');
  dialog.showMessageBox({
    type: 'question',
    buttons: ['Instalar e Reiniciar', 'Mais tarde'],
    defaultId: 0,
    message: 'Uma nova versão do ZapFlow foi baixada. Deseja reiniciar o aplicativo para instalar as atualizações?'
  }).then(returnValue => {
    if (returnValue.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

// ─── Inicialização do app ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
  logger = require('./src/logger');
  logger.inicializar(app.getPath('userData'));
  logger.log.info('APP', 'ZapFlow iniciado', { versao: app.getVersion() });

  createWindow();
  mainWindow.webContents.on('did-finish-load', async () => {
    await verificarLicenca();
  });
});

app.on('window-all-closed', () => {
  if (verificacaoInterval) clearInterval(verificacaoInterval);
  if (waClient) waClient.destroy().catch(() => {});
  logger && logger.log.info('APP', 'Aplicação encerrada');
  app.quit();
});

// ─── Controles de janela ──────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close', () => {
  if (verificacaoInterval) clearInterval(verificacaoInterval);
  if (waClient) waClient.destroy().catch(() => {});
  logger && logger.log.info('APP', 'Encerrado pelo usuário');
  app.quit();
});

// ─── Excel ────────────────────────────────────────────────────────────────────
ipcMain.handle('choose-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar planilha de contatos',
    filters: [{ name: 'Planilha Excel', extensions: ['xlsx', 'xls'] }],
    properties: ['openFile'],
  });
  if (!result.canceled) logger && logger.log.info('EXCEL', 'Arquivo selecionado', { arquivo: result.filePaths[0] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('read-excel', async (_, filePath, sheetName) => {
  try {
    const { lerPlanilha } = require('./src/leitor_excel');
    const res = lerPlanilha(filePath, sheetName);
    logger && logger.log.info('EXCEL', `${res.contatos.length} contatos lidos, ${res.erros.length} erros`, { aba: sheetName });
    return res;
  } catch (err) {
    logger && logger.log.erro('EXCEL', 'Erro ao ler planilha', { erro: err.message });
    return { contatos: [], erros: [{ linha: 0, motivo: err.message }] };
  }
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
ipcMain.handle('connect-whatsapp', async () => {
  if (waClient) { try { await waClient.destroy(); } catch {} waClient = null; }

  logger && logger.log.info('WHATSAPP', 'Iniciando conexão...');
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const qrcode = require('qrcode');

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(app.getPath('userData'), 'wa-session') }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
  });

  waClient.on('qr', async (qr) => {
    logger && logger.log.info('WHATSAPP', 'QR Code gerado');
    try {
      const qrDataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 2, color: { dark: '#0a0d0f', light: '#ffffff' } });
      safeSend('wa-qr', qrDataUrl);
    } catch {}
  });

  waClient.on('authenticated', () => { logger && logger.log.info('WHATSAPP', 'Autenticado'); safeSend('wa-authenticated'); });
  waClient.on('ready',         () => { logger && logger.log.info('WHATSAPP', 'Pronto'); safeSend('wa-ready'); });
  waClient.on('disconnected',  (r) => { logger && logger.log.warn('WHATSAPP', 'Desconectado', { motivo: r }); safeSend('wa-disconnected', r); });
  waClient.initialize().catch(err => { logger && logger.log.erro('WHATSAPP', 'Erro na inicialização', { erro: err.message }); safeSend('wa-error', err.message); });

  return { ok: true };
});

ipcMain.handle('disconnect-whatsapp', async () => {
  if (waClient) { try { await waClient.destroy(); } catch {} waClient = null; }
  logger && logger.log.info('WHATSAPP', 'Desconectado manualmente');
  return { ok: true };
});

// ─── Envio ────────────────────────────────────────────────────────────────────
ipcMain.handle('start-sending', async (_, { contatos, mensagemTemplate, delayMs }) => {
  if (!licencaValida) {
    logger && logger.log.warn('ENVIO', 'Envio bloqueado — licença inválida');
    return { ok: false, motivo: 'Licença inválida. Ative novamente.' };
  }

  const salva = lerLicenca(app.getPath('userData'));
  if (salva && salva.chave) {
    try {
      const res = await verificarOnline(SERVER_URL, salva.chave, getMachineId());
      if (!res || !res.ok) {
        licencaValida = false;
        logger && logger.log.warn('ENVIO', 'Envio bloqueado — licença inválida no servidor');
        safeSend('licenca-status', { ok: false, acao: 'expirada', motivo: 'Licença inválida no servidor.' });
        return { ok: false, motivo: 'Licença inválida no servidor.' };
      }
    } catch (err) {
      logger && logger.log.warn('ENVIO', 'Verificação pré-envio falhou (offline)', { erro: err.message });
    }
  }

  if (!waClient)     return { ok: false, motivo: 'WhatsApp não conectado' };
  if (sendingActive) return { ok: false, motivo: 'Envio já em andamento' };

  sendingActive = true;
  logger && logger.log.info('ENVIO', `Iniciando envio para ${contatos.length} contatos`);

  (async () => {
    const { relatorio } = require('./src/relatorio');
    relatorio.inicializar();
    const sessaoId = relatorio.criarSessao('planilha', 'envio', contatos.length);
    let enviados = 0, erros = 0;

    for (let i = 0; i < contatos.length; i++) {
      if (!sendingActive) { logger && logger.log.info('ENVIO', 'Cancelado', { enviados, erros }); break; }

      const c = contatos[i];
      const mensagem = mensagemTemplate
        .replace(/\{nome\}/g,     c.nome     || '')
        .replace(/\{telefone\}/g, c.telefone || '')
        .replace(/\{empresa\}/g,  c.empresa  || '')
        .replace(/\{cidade\}/g,   c.cidade   || '')
        .replace(/\{cpf\}/g,      c.cpf      || '');

      safeSend('sending-progress', { index: i, total: contatos.length, nome: c.nome, telefone: c.telefone, status: 'sending' });

      try {
        const numberId = await waClient.getNumberId(`55${c.telefone}`);
        if (!numberId) throw new Error('Número não encontrado no WhatsApp');
        const chatId = numberId._serialized;
        await sleep(500);
        const msg = await waClient.sendMessage(chatId, mensagem);
        await sleep(1000);
        if (!msg || !msg.id) throw new Error('Falha silenciosa no envio');

        enviados++;
        relatorio.registrarEnvio(sessaoId, c.nome, c.telefone, 'sucesso', null, 1);
        logger && logger.log.info('ENVIO', `Enviado para ${c.nome} (${c.telefone})`);
        safeSend('sending-progress', { index: i, total: contatos.length, nome: c.nome, telefone: c.telefone, status: 'ok' });

      } catch (err) {
        erros++;
        relatorio.registrarEnvio(sessaoId, c.nome, c.telefone, 'erro', err.message, 1);
        logger && logger.log.erro('ENVIO', `Erro para ${c.nome} (${c.telefone})`, { erro: err.message });
        safeSend('sending-progress', { index: i, total: contatos.length, nome: c.nome, telefone: c.telefone, status: 'erro', motivo: err.message });
      }

      if (i < contatos.length - 1 && sendingActive) {
        safeSend('sending-countdown', { segundos: delayMs / 1000 });
        await sleep(delayMs);
      }
    }

    relatorio.finalizarSessao(sessaoId, enviados, erros);
    sendingActive = false;
    logger && logger.log.info('ENVIO', `Concluído — ${enviados} ok / ${erros} erros`);
    safeSend('sending-done', { total: contatos.length, enviados, erros, sessaoId });

  })().catch(err => {
    sendingActive = false;
    logger && logger.log.erro('ENVIO', 'Erro inesperado', { erro: err.message });
    safeSend('wa-error', 'Erro no envio: ' + err.message);
  });

  return { ok: true };
});

ipcMain.on('cancel-sending', () => { sendingActive = false; logger && logger.log.info('ENVIO', 'Cancelado pelo usuário'); });

// ─── Histórico ────────────────────────────────────────────────────────────────
ipcMain.handle('get-history', () => {
  try { const { relatorio } = require('./src/relatorio'); relatorio.inicializar(); return relatorio.obterUltimasSessoes(20); }
  catch { return []; }
});

// ─── Logs e exportação ────────────────────────────────────────────────────────
ipcMain.handle('get-logs',    ()           => { try { return logger ? logger.listarLogs() : []; } catch { return []; } });
ipcMain.handle('read-log',    (_, caminho) => { try { return logger ? logger.lerLog(caminho) : ''; } catch { return ''; } });

ipcMain.handle('exportar-csv', (_, sessaoId) => {
  try {
    const res = logger ? logger.exportarCSV(sessaoId || null) : { ok: false, motivo: 'Logger não iniciado' };
    if (res.ok) shell.showItemInFolder(res.caminho);
    return res;
  } catch (err) { return { ok: false, motivo: err.message }; }
});

ipcMain.handle('abrir-pasta-logs', () => {
  try { shell.openPath(path.join(app.getPath('userData'), 'logs')); return { ok: true }; }
  catch { return { ok: false }; }
});

// ─── Licença ──────────────────────────────────────────────────────────────────
async function verificarLicenca() {
  const salva = lerLicenca(app.getPath('userData'));
  if (!salva || !salva.chave) {
    logger && logger.log.info('LICENCA', 'Nenhuma licença salva');
    safeSend('licenca-status', { ok: false, acao: 'ativar', serverUrl: SERVER_URL, machineId: getMachineId() });
    return;
  }

  try {
    const resultado = await verificarOnline(SERVER_URL, salva.chave, getMachineId());
    if (resultado && resultado.ok) {
      licencaValida = true;
      logger && logger.log.info('LICENCA', 'Licença válida', { plano: resultado.plano });
      safeSend('licenca-status', {
        ok: true,
        plano: resultado.plano,
        cliente: resultado.cliente,
        expira: resultado.expira_formatado,
        serverUrl: SERVER_URL,
        machineId: getMachineId(),
        chave: salva.chave
      });
      iniciarVerificacaoPeriodica();
    } else {
      licencaValida = false;
      logger && logger.log.warn('LICENCA', 'Licença inválida no servidor', { erro: resultado?.erro });
      try { fs.unlinkSync(getLicencaPath(app.getPath('userData'))); } catch {}
      safeSend('licenca-status', { ok: false, acao: 'expirada', motivo: resultado?.erro || 'Licença inválida.' });
    }
  } catch (err) {
    logger && logger.log.warn('LICENCA', 'Falha na verificação online, usando cache', { erro: err.message });
    licencaValida = true;
    safeSend('licenca-status', {
      ok: true,
      plano: salva.plano,
      cliente: salva.cliente,
      expira: salva.expira_formatado,
      serverUrl: SERVER_URL,
      machineId: getMachineId(),
      chave: salva.chave,
      offline: true
    });
    iniciarVerificacaoPeriodica();
  }
}

ipcMain.handle('get-machine-info', () => ({ machineId: getMachineId(), serverUrl: SERVER_URL }));

ipcMain.handle('salvar-licenca', (_, dados) => {
  try {
    salvarLicenca(app.getPath('userData'), dados);
    licencaValida = true;
    logger && logger.log.info('LICENCA', 'Licença ativada', { plano: dados.plano });
    iniciarVerificacaoPeriodica();
    return { ok: true };
  } catch (err) {
    logger && logger.log.erro('LICENCA', 'Erro ao salvar', { erro: err.message });
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle('licenca-confirmada', () => {
  licencaValida = true;
  logger && logger.log.info('LICENCA', 'Confirmada pelo servidor');
  iniciarVerificacaoPeriodica();
  return { ok: true };
});

// ─── Utilitário ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }