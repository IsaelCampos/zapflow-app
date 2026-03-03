// src/leitor_excel.js
const XLSX = require('xlsx');
const path = require('path');

/**
 * Lê os contatos da planilha Excel
 *
 * Estrutura esperada:
 *   A = Nome
 *   B = Telefone
 *   C = Empresa   (opcional)
 *   D = Cidade    (opcional)
 *   E = CPF       (opcional)
 *
 * Linha 1 = cabeçalho (ignorada)
 */
function lerPlanilha(arquivo, nomePagina) {
  const contatos = [];
  const erros    = [];

  try {
    const workbook = XLSX.readFile(path.resolve(arquivo));

    if (!workbook.SheetNames.includes(nomePagina)) {
      throw new Error(
        `Página "${nomePagina}" não encontrada. Páginas disponíveis: ${workbook.SheetNames.join(', ')}`
      );
    }

    const sheet = workbook.Sheets[nomePagina];
    const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    for (let i = 1; i < linhas.length; i++) {
      const row        = linhas[i];
      const numeroLinha = i + 1;

      const nome    = String(row[0] || '').trim();
      let   telefone = String(row[1] || '').trim();
      const empresa = String(row[2] || '').trim();   // Coluna C
      const cidade  = String(row[3] || '').trim();   // Coluna D
      const cpf     = String(row[4] || '').trim();   // Coluna E

      // Pula linhas vazias
      if (!nome && !telefone) continue;

      if (!nome) {
        erros.push({ linha: numeroLinha, motivo: 'Nome vazio' });
        continue;
      }

      if (!telefone) {
        erros.push({ linha: numeroLinha, nome, motivo: 'Telefone vazio' });
        continue;
      }

      // Limpa telefone
      telefone = telefone.replace(/\D/g, '');

      if (telefone.startsWith('55') && telefone.length > 11) {
        telefone = telefone.slice(2);
      }

      if (telefone.length < 10 || telefone.length > 11) {
        erros.push({
          linha: numeroLinha, nome,
          motivo: `Telefone inválido: "${row[1]}" (${telefone.length} dígitos, esperado 10 ou 11)`
        });
        continue;
      }

      // Normaliza para 11 dígitos
      if (telefone.length === 10) {
        telefone = telefone.slice(0, 2) + '9' + telefone.slice(2);
      }

      contatos.push({ nome, telefone, empresa, cidade, cpf, linha: numeroLinha });
    }

    return { contatos, erros };

  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Arquivo "${arquivo}" não encontrado.`);
    throw err;
  }
}

module.exports = { lerPlanilha };