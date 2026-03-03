// src/relatorio.js
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const { app } = require('electron');
const fs = require('fs');

let db;

function inicializar() {
  const dbPath = path.join(app.getPath('userData'), 'relatorios.json');
  const adapter = new FileSync(dbPath);
  db = low(adapter);
  db.defaults({ sessoes: [], envios: [] }).write();
  return db;
}

function proximoId(colecao) {
  const itens = db.get(colecao).value();
  if (!itens.length) return 1;
  return Math.max(...itens.map(i => i.id)) + 1;
}

function criarSessao(arquivo, pagina, total) {
  const id = proximoId('sessoes');
  db.get('sessoes').push({ id, arquivo, pagina, total_contatos: total, enviados: 0, erros: 0, iniciado_em: new Date().toLocaleString('pt-BR'), finalizado_em: null, status: 'em_andamento' }).write();
  return id;
}

function registrarEnvio(sessaoId, nome, telefone, status, motivoErro = null, tentativas = 1) {
  const id = proximoId('envios');
  db.get('envios').push({ id, sessao_id: sessaoId, nome, telefone, status, motivo_erro: motivoErro, tentativas, enviado_em: new Date().toLocaleString('pt-BR') }).write();
}

function finalizarSessao(sessaoId, enviados, erros) {
  db.get('sessoes').find({ id: sessaoId }).assign({ enviados, erros, finalizado_em: new Date().toLocaleString('pt-BR'), status: 'concluido' }).write();
}

function obterUltimasSessoes(limite = 20) {
  return db.get('sessoes').value().slice(-limite).reverse();
}

function obterEnviosDaSessao(sessaoId) {
  return db.get('envios').filter({ sessao_id: sessaoId }).value();
}

module.exports = {
  relatorio: { inicializar, criarSessao, registrarEnvio, finalizarSessao, obterUltimasSessoes, obterEnviosDaSessao }
};