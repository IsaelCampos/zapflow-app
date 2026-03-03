// src/logger.js — Sistema de log em arquivo + exportação CSV
const fs   = require('fs');
const path = require('path');

let logPath    = null;
let userDataPath = null;

// ─── Inicialização ────────────────────────────────────────────────────────────
function inicializar(udPath) {
  userDataPath = udPath;
  const logsDir = path.join(userDataPath, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const hoje = new Date().toISOString().slice(0, 10); // ex: 2024-03-01
  logPath = path.join(logsDir, `zapflow-${hoje}.log`);

  escrever('INFO', 'APP', 'ZapFlow iniciado');
}

// ─── Escrita no arquivo ───────────────────────────────────────────────────────
function escrever(nivel, categoria, mensagem, detalhes = null) {
  if (!logPath) return;
  const timestamp = new Date().toLocaleString('pt-BR');
  const extra = detalhes ? ` | ${JSON.stringify(detalhes)}` : '';
  const linha = `[${timestamp}] [${nivel.padEnd(5)}] [${categoria}] ${mensagem}${extra}\n`;
  try { fs.appendFileSync(logPath, linha, 'utf-8'); } catch {}
}

// ─── Atalhos ──────────────────────────────────────────────────────────────────
const log = {
  info:  (cat, msg, det) => escrever('INFO',  cat, msg, det),
  warn:  (cat, msg, det) => escrever('WARN',  cat, msg, det),
  erro:  (cat, msg, det) => escrever('ERRO',  cat, msg, det),
  envio: (nome, tel, status, motivo) => escrever('ENVIO', 'WHATSAPP',
    `${status.toUpperCase()} → ${nome} (${tel})`, motivo ? { motivo } : null),
};

// ─── Listar arquivos de log ───────────────────────────────────────────────────
function listarLogs() {
  try {
    const logsDir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(logsDir)) return [];
    return fs.readdirSync(logsDir)
      .filter(f => f.endsWith('.log'))
      .sort().reverse()
      .map(f => ({ nome: f, caminho: path.join(logsDir, f) }));
  } catch { return []; }
}

// ─── Ler conteúdo de um log ───────────────────────────────────────────────────
function lerLog(caminho) {
  try { return fs.readFileSync(caminho, 'utf-8'); }
  catch { return 'Erro ao ler arquivo de log.'; }
}

// ─── Exportar envios como CSV ─────────────────────────────────────────────────
function exportarCSV(sessaoId = null) {
  try {
    const low      = require('lowdb');
    const FileSync = require('lowdb/adapters/FileSync');
    const dbPath   = path.join(userDataPath, 'relatorios.json');
    const db       = low(new FileSync(dbPath));

    const envios = sessaoId
      ? db.get('envios').filter({ sessao_id: sessaoId }).value()
      : db.get('envios').value();

    if (!envios || !envios.length) return { ok: false, motivo: 'Nenhum envio encontrado.' };

    const cabecalho = 'Nome,Telefone,Status,Motivo do Erro,Tentativas,Enviado Em\n';
    const linhas = envios.map(e =>
      `"${e.nome}","${e.telefone}","${e.status}","${e.motivo_erro || ''}","${e.tentativas}","${e.enviado_em}"`
    ).join('\n');

    const exportDir = path.join(userDataPath, 'exportacoes');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

    const ts   = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const nome = sessaoId ? `envios-sessao-${sessaoId}-${ts}.csv` : `todos-envios-${ts}.csv`;
    const dest = path.join(exportDir, nome);

    fs.writeFileSync(dest, '\uFEFF' + cabecalho + linhas, 'utf-8'); // BOM para Excel abrir certo
    escrever('INFO', 'EXPORT', `CSV exportado: ${nome}`);
    return { ok: true, caminho: dest, nome };
  } catch (err) {
    escrever('ERRO', 'EXPORT', 'Falha ao exportar CSV', { erro: err.message });
    return { ok: false, motivo: err.message };
  }
}

// ─── Caminho do log atual ─────────────────────────────────────────────────────
function getLogPath() { return logPath; }

module.exports = { inicializar, log, listarLogs, lerLog, exportarCSV, getLogPath };