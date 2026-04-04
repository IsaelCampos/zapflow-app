// main.js — Processo principal do Electron
require('dotenv').config();

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { autoUpdater } = require('electron-updater');

// ─── URL do servidor de licenças ──────────────────────────────────────────────
// Em produção, defina ZAPFLOW_SERVER_URL no .env do app ou como variável de
// ambiente do sistema. Em desenvolvimento, cai para localhost automaticamente.
const SERVER_URL = process.env.ZAPFLOW_SERVER_URL || 'http://localhost:3000';

let mainWindow;
let licencaValida       = false;
let waClient            = null;
let sendingActive       = false;
let verificacaoInterval = null;
let logger              = null;

// Estado do trial (atualizado a cada verificação)
let trialInfo = { ativo: false, limite: 50, realizados: 0, restantes: 50, diasRestantes: 7 };

const { getMachineId, lerLicenca, salvarLicenca, verificarOnline, getLicencaPath, registrarEnviosTrial } = require('./src/licenca');

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
  }, 7 * 60 * 1000);
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

  mainWindow.once('ready-to-show', () => {
    autoUpdater.checkForUpdatesAndNotify();
  });
}

// ─── Eventos do autoUpdater ───────────────────────────────────────────────────
autoUpdater.on('update-available', (info) => {
  logger && logger.log.info('AUTOUPDATE', 'Nova versão disponível', info);
  safeSend('update_available', info);
});

autoUpdater.on('update-not-available', () => {
  logger && logger.log.info('AUTOUPDATE', 'Nenhuma atualização disponível');
});

autoUpdater.on('error', (err) => {
  logger && logger.log.erro('AUTOUPDATE', 'Erro no auto-updater', { erro: err.message });
});

autoUpdater.on('download-progress', (progressObj) => {
  logger && logger.log.info('AUTOUPDATE', `Download: ${progressObj.percent}%`);
  safeSend('update_progress', progressObj);
});

autoUpdater.on('update-downloaded', () => {
  logger && logger.log.info('AUTOUPDATE', 'Atualização baixada. Pronto para instalar.');
  dialog.showMessageBox({
    type: 'question',
    buttons: ['Instalar e Reiniciar', 'Mais tarde'],
    defaultId: 0,
    message: 'Uma nova versão do ZapFlow foi baixada. Deseja reiniciar para instalar?'
  }).then(returnValue => {
    if (returnValue.response === 0) autoUpdater.quitAndInstall();
  });
});

// ─── Inicialização do app ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
  logger = require('./src/logger');
  logger.inicializar(app.getPath('userData'));
  logger.log.info('APP', 'ZapFlow iniciado', { versao: app.getVersion(), servidor: SERVER_URL });

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

ipcMain.handle('choose-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar imagem para envio',
    filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  logger && logger.log.info('IMAGEM', 'Imagem selecionada', { arquivo: filePath });
  return filePath;
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

// Nova rota: retorna as abas disponíveis de um arquivo Excel
ipcMain.handle('get-excel-sheets', async (_, filePath) => {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(path.resolve(filePath));
    return { ok: true, sheets: wb.SheetNames };
  } catch (err) {
    return { ok: false, sheets: [], erro: err.message };
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
  if (waClient) {
    try { await waClient.logout(); } catch {}
    try { await waClient.destroy(); } catch {}
    waClient = null;
  }

  const sessionPath = path.join(app.getPath('userData'), 'wa-session');
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    logger && logger.log.info('WHATSAPP', 'Sessão apagada com sucesso');
  } catch (err) {
    logger && logger.log.warn('WHATSAPP', 'Falha ao apagar sessão', { erro: err.message });
  }

  logger && logger.log.info('WHATSAPP', 'Desconectado manualmente');
  return { ok: true };
});

// ─── Envio ────────────────────────────────────────────────────────────────────
ipcMain.handle('start-sending', async (_, { contatos, mensagemTemplate, delayMs, imagemPath }) => {
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

  // Trial: verifica limite antes de iniciar
  if (trialInfo.ativo) {
    if (trialInfo.restantes <= 0) {
      logger && logger.log.warn('ENVIO', 'Trial esgotado — envio bloqueado');
      safeSend('trial-esgotado', { motivo: 'Você atingiu o limite de ' + trialInfo.limite + ' envios do trial. Adquira um plano para continuar.' });
      return { ok: false, motivo: 'Trial esgotado. Adquira um plano para continuar.' };
    }
    // Aviso se <= 20% restante
    const pctRestante = (trialInfo.restantes / trialInfo.limite) * 100;
    if (pctRestante <= 20) {
      safeSend('trial-aviso', { restantes: trialInfo.restantes, limite: trialInfo.limite });
    }
    // Limita a sessão ao que resta no trial
    if (contatos.length > trialInfo.restantes) {
      logger && logger.log.warn('ENVIO', `Trial: limitando envio de ${contatos.length} para ${trialInfo.restantes} contatos`);
      contatos = contatos.slice(0, trialInfo.restantes);
      safeSend('trial-limitado', { original: contatos.length, permitido: trialInfo.restantes });
    }
  }

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

        if (imagemPath) {
          const { MessageMedia } = require('whatsapp-web.js');
          const media = MessageMedia.fromFilePath(imagemPath);
          const msg = await waClient.sendMessage(chatId, media, { caption: mensagem });
          await sleep(1000);
          if (!msg || !msg.id) throw new Error('Falha silenciosa no envio da imagem');
        } else {
          const msg = await waClient.sendMessage(chatId, mensagem);
          await sleep(1000);
          if (!msg || !msg.id) throw new Error('Falha silenciosa no envio');
        }

        enviados++;
        relatorio.registrarEnvio(sessaoId, c.nome, c.telefone, 'sucesso', null, 1);
        logger && logger.log.info('ENVIO', `Enviado para ${c.nome} (${c.telefone})`);
        safeSend('sending-progress', { index: i, total: contatos.length, nome: c.nome, telefone: c.telefone, status: 'ok' });

        // Trial: incrementa contador no servidor
        if (trialInfo.ativo) {
          trialInfo.realizados++;
          trialInfo.restantes = Math.max(0, trialInfo.restantes - 1);

          const salvaAtual = lerLicenca(app.getPath('userData'));
          if (salvaAtual && salvaAtual.chave) {
            try {
              await registrarEnviosTrial(SERVER_URL, salvaAtual.chave, getMachineId(), 1);
              logger && logger.log.info('TRIAL', `Contador atualizado: ${trialInfo.realizados}/${trialInfo.limite}`);
            } catch (errTrial) {
              logger && logger.log.warn('TRIAL', 'Falha ao registrar envio no servidor', { erro: errTrial.message });
            }
          }

          safeSend('trial-atualizado', { realizados: trialInfo.realizados, restantes: trialInfo.restantes, limite: trialInfo.limite });

          // Aviso com 20% de antecedência
          const pct = (trialInfo.restantes / trialInfo.limite) * 100;
          if (trialInfo.restantes > 0 && pct <= 20) {
            safeSend('trial-aviso', { restantes: trialInfo.restantes, limite: trialInfo.limite });
          }

          // Para o envio se trial esgotou durante a sessão
          if (trialInfo.restantes <= 0) {
            logger && logger.log.warn('TRIAL', 'Limite atingido durante envio — parando sessão');
            sendingActive = false;
          }
        }

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

ipcMain.on('cancel-sending', () => {
  sendingActive = false;
  logger && logger.log.info('ENVIO', 'Cancelado pelo usuário');
});

// ─── Histórico ────────────────────────────────────────────────────────────────
ipcMain.handle('get-history', () => {
  try {
    const { relatorio } = require('./src/relatorio');
    relatorio.inicializar();
    return relatorio.obterUltimasSessoes(20);
  } catch { return []; }
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
    safeSend('licenca-status', { ok: false, acao: 'ativar', machineId: getMachineId() });
    return;
  }

  try {
    const resultado = await verificarOnline(SERVER_URL, salva.chave, getMachineId());
    if (resultado && resultado.ok) {
      licencaValida = true;
      // Atualiza info de trial se aplicável
      if (resultado.trial) {
        trialInfo = { ativo: true, limite: resultado.trial_limite, realizados: resultado.trial_realizados, restantes: resultado.trial_restantes, diasRestantes: resultado.trial_dias_restantes };
      } else {
        trialInfo = { ativo: false, limite: 0, realizados: 0, restantes: 0, diasRestantes: 0 };
      }
      logger && logger.log.info('LICENCA', 'Licença válida', { plano: resultado.plano });
      safeSend('licenca-status', {
        ok: true,
        plano: resultado.plano,
        cliente: resultado.cliente,
        expira: resultado.expira_formatado,
        machineId: getMachineId(),
        chave: salva.chave,
        trial: resultado.trial || false,
        trialInfo: resultado.trial ? trialInfo : null
      });
      iniciarVerificacaoPeriodica();
    } else {
      licencaValida = false;
      logger && logger.log.warn('LICENCA', 'Licença inválida no servidor', { erro: resultado?.erro });
      try { fs.unlinkSync(getLicencaPath(app.getPath('userData'))); } catch {}
      safeSend('licenca-status', { ok: false, acao: 'expirada', motivo: resultado?.erro || 'Licença inválida.' });
    }
  } catch (err) {
    // Sem rede: usa cache local
    logger && logger.log.warn('LICENCA', 'Falha na verificação online, usando cache', { erro: err.message });
    licencaValida = true;
    safeSend('licenca-status', {
      ok: true,
      plano: salva.plano,
      cliente: salva.cliente,
      expira: salva.expira_formatado,
      machineId: getMachineId(),
      chave: salva.chave,
      offline: true
    });
    iniciarVerificacaoPeriodica();
  }
}

// Retorna apenas machine_id (não expõe serverUrl ao renderer)
ipcMain.handle('get-machine-info', () => ({ machineId: getMachineId() }));

// Ativação de licença — feita inteiramente no main process (seguro)
ipcMain.handle('ativar-licenca', async (_, { chave }) => {
  const chaveFormatada = chave.toUpperCase().trim();
  const machineId = getMachineId();

  try {
    const resultado = await require('./src/licenca').ativarChave(SERVER_URL, chaveFormatada, machineId);

    if (resultado && resultado.ok) {
      const dadosLicenca = {
        chave: chaveFormatada,
        plano: resultado.plano,
        cliente: resultado.cliente,
        expira_em: resultado.expira_em,
        expira_formatado: resultado.expira_formatado
      };

      salvarLicenca(app.getPath('userData'), dadosLicenca);
      licencaValida = true;

      // Atualiza trialInfo imediatamente — sem isso, o estado da licença anterior persiste
      if (resultado.trial) {
        trialInfo = {
          ativo: true,
          limite: resultado.trial_limite,
          realizados: resultado.trial_realizados,
          restantes: resultado.trial_restantes,
          diasRestantes: resultado.trial_dias_restantes
        };
        logger && logger.log.info('TRIAL', `Trial ativado: ${trialInfo.restantes}/${trialInfo.limite} envios restantes`);
      } else {
        trialInfo = { ativo: false, limite: 0, realizados: 0, restantes: 0, diasRestantes: 0 };
      }

      iniciarVerificacaoPeriodica();
      logger && logger.log.info('LICENCA', 'Licença ativada com sucesso', { plano: resultado.plano });

      return {
        ok: true,
        plano: resultado.plano,
        cliente: resultado.cliente,
        expira: resultado.expira_formatado,
        trial: resultado.trial || false,
        trialInfo: resultado.trial ? trialInfo : null
      };
    } else {
      logger && logger.log.warn('LICENCA', 'Falha na ativação', { erro: resultado?.erro });
      return { ok: false, erro: resultado?.erro || 'Chave inválida.' };
    }
  } catch (err) {
    logger && logger.log.erro('LICENCA', 'Erro de conexão ao ativar', { erro: err.message });
    return { ok: false, erro: 'Erro de conexão com o servidor. Verifique sua internet.' };
  }
});

ipcMain.handle('salvar-licenca', (_, dados) => {
  try {
    salvarLicenca(app.getPath('userData'), dados);
    licencaValida = true;
    logger && logger.log.info('LICENCA', 'Licença salva', { plano: dados.plano });
    iniciarVerificacaoPeriodica();
    return { ok: true };
  } catch (err) {
    logger && logger.log.erro('LICENCA', 'Erro ao salvar', { erro: err.message });
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle('licenca-confirmada', () => {
  licencaValida = true;
  iniciarVerificacaoPeriodica();
  return { ok: true };
});

// ─── Utilitário ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }