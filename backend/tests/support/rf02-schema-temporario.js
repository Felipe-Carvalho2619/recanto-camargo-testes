'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { nomeTemporarioValido } = require('./qa-config');

const CAMINHO_RELEASE = path.resolve(
    __dirname,
    '../../migrations/release/20261124_001_rf02_recuperacao_senha.sql'
);
const SHA256_RELEASE = '308385efe1c76a76753bf6e8a17c8ccc375b056026d951b566f7419fdbe7a52f';
const QUANTIDADE_STATEMENTS = 5;
const TABELAS_RF02 = Object.freeze(['rf02_recuperacao_senha', 'rf02_rate_limit']);

// Separa somente delimitadores fora de strings, identificadores e comentários.
// O corpo integral da procedure permanece em um único statement.
function separarDeclaracoes(texto, delimitador) {
    const declaracoes = [];
    let inicio = 0;
    let indice = 0;
    let estado = 'sql';
    let aspas = '';

    while (indice < texto.length) {
        const caractere = texto[indice];
        const proximo = texto[indice + 1];

        if (estado === 'comentario-linha') {
            if (caractere === '\n' || caractere === '\r') estado = 'sql';
            indice += 1;
            continue;
        }

        if (estado === 'comentario-bloco') {
            if (caractere === '*' && proximo === '/') {
                estado = 'sql';
                indice += 2;
            } else {
                indice += 1;
            }
            continue;
        }

        if (estado === 'aspas') {
            if (caractere === '\\') {
                indice += 2;
                continue;
            }
            if (caractere === aspas) {
                if (proximo === aspas) {
                    indice += 2;
                    continue;
                }
                estado = 'sql';
            }
            indice += 1;
            continue;
        }

        if (texto.startsWith(delimitador, indice)) {
            const declaracao = texto.slice(inicio, indice).trim();
            if (declaracao) declaracoes.push(declaracao);
            indice += delimitador.length;
            inicio = indice;
            continue;
        }

        if (caractere === "'" || caractere === '"' || caractere === '`') {
            estado = 'aspas';
            aspas = caractere;
            indice += 1;
            continue;
        }
        if (caractere === '/' && proximo === '*') {
            estado = 'comentario-bloco';
            indice += 2;
            continue;
        }
        if (caractere === '#') {
            estado = 'comentario-linha';
            indice += 1;
            continue;
        }
        if (caractere === '-' && proximo === '-' && /\s/.test(texto[indice + 2] || '')) {
            estado = 'comentario-linha';
            indice += 2;
            continue;
        }
        indice += 1;
    }

    return { declaracoes, resto: texto.slice(inicio) };
}

function apenasComentariosEEspacos(texto) {
    let indice = 0;
    while (indice < texto.length) {
        if (/\s/.test(texto[indice])) {
            indice += 1;
            continue;
        }
        if (texto[indice] === '#') {
            const fim = texto.slice(indice).search(/[\r\n]/);
            indice = fim === -1 ? texto.length : indice + fim + 1;
            continue;
        }
        if (texto.startsWith('--', indice) && /\s/.test(texto[indice + 2] || '')) {
            const fim = texto.slice(indice).search(/[\r\n]/);
            indice = fim === -1 ? texto.length : indice + fim + 1;
            continue;
        }
        if (texto.startsWith('/*', indice)) {
            const fim = texto.indexOf('*/', indice + 2);
            if (fim === -1) throw new Error('Comentário de bloco não encerrado no release RF02.');
            indice = fim + 2;
            continue;
        }
        return false;
    }
    return true;
}

function analisarRelease(conteudo) {
    const declaracoes = [];
    let delimitador = ';';
    let resto = '';
    const linhas = conteudo.replace(/\r\n?/g, '\n').split('\n');

    for (const linha of linhas) {
        const diretiva = /^[ \t]*DELIMITER[ \t]+([^ \t]+)[ \t]*$/i.exec(linha);
        if (diretiva) {
            if (resto.trim()) throw new Error('Diretiva DELIMITER encontrada dentro de um statement RF02.');
            delimitador = diretiva[1];
            continue;
        }

        resto += `${linha}\n`;
        const resultado = separarDeclaracoes(resto, delimitador);
        declaracoes.push(...resultado.declaracoes);
        resto = resultado.resto;
    }

    if (!apenasComentariosEEspacos(resto)) {
        throw new Error('Release RF02 contém SQL sem delimitador final.');
    }
    if (declaracoes.length !== QUANTIDADE_STATEMENTS) {
        throw new Error(`Release RF02 deve produzir ${QUANTIDADE_STATEMENTS} statements; obtidos ${declaracoes.length}.`);
    }
    return declaracoes;
}

function selecionarCreateTables(declaracoes) {
    // Todo o pacote continua sendo validado antes de qualquer DDL. Os statements
    // não selecionados precisam ser exatamente os componentes conhecidos do release.
    const esperados = [
        {
            inicio: /\bSET\s+NAMES\b/i,
            completo: /^SET NAMES utf8mb4$/i
        },
        {
            inicio: /\bDROP\s+PROCEDURE\b/i,
            completo: /^DROP PROCEDURE IF EXISTS `_rf02_20261124_001_guard`$/i
        },
        {
            inicio: /\bCREATE\s+PROCEDURE\b/i,
            completo: /^CREATE PROCEDURE `_rf02_20261124_001_guard`\(\) BEGIN .+ END$/i
        },
        {
            inicio: /\bCALL\b/i,
            completo: /^CALL `_rf02_20261124_001_guard`\(\)$/i
        },
        {
            inicio: /\bDROP\s+PROCEDURE\b/i,
            completo: /^DROP PROCEDURE IF EXISTS `_rf02_20261124_001_guard`$/i
        }
    ];

    declaracoes.forEach((declaracao, indice) => {
        const esperado = esperados[indice];
        const inicio = esperado.inicio.exec(declaracao);
        if (!inicio || !apenasComentariosEEspacos(declaracao.slice(0, inicio.index))) {
            throw new Error(`Statement RF02 ${indice + 1} possui prefixo desconhecido.`);
        }
        const sqlNormalizado = declaracao.slice(inicio.index).replace(/\s+/g, ' ').trim();
        if (!esperado.completo.test(sqlNormalizado)) {
            throw new Error(`Statement RF02 ${indice + 1} fora do conjunto esperado; nenhum DDL foi autorizado.`);
        }
    });

    const guard = declaracoes[2];
    const totalCreates = guard.match(/\bCREATE\s+TABLE\b/gi) || [];
    if (totalCreates.length !== TABELAS_RF02.length) {
        throw new Error('O guard RF02 deve conter exatamente dois CREATE TABLE.');
    }

    return TABELAS_RF02.map(nomeTabela => {
        const marcador = `CREATE TABLE \`${nomeTabela}\``;
        const inicio = guard.indexOf(marcador);
        if (inicio < 0 || inicio !== guard.lastIndexOf(marcador)) {
            throw new Error(`CREATE TABLE nominal único ausente para ${nomeTabela}.`);
        }

        // O início nominal evita capturar IF/END IF da procedure; o parser preserva
        // o statement original até seu primeiro delimitador fora de strings/comentários.
        const extraidas = separarDeclaracoes(guard.slice(inicio), ';').declaracoes;
        if (!extraidas.length || !extraidas[0].startsWith(marcador)) {
            throw new Error(`Não foi possível extrair integralmente ${nomeTabela}.`);
        }
        return extraidas[0];
    });
}

async function confirmarSchema(admin, nome) {
    const [linhas] = await admin.query('SELECT DATABASE() AS nome');
    if (!Array.isArray(linhas) || linhas.length !== 1 || linhas[0].nome !== nome) {
        throw new Error('O clone descartável RF02 não permaneceu selecionado.');
    }
}

// Callback opt-in do harness. Recebe a conexão já validada, criada com
// multipleStatements:false, e não abre conexão nem recebe o schema de origem.
// O Gate E já validou a rotina/guarda do pacote completo. Para não alterar grants,
// esta integração consome somente as tabelas extraídas; não aplica a migration completa.
async function prepararSchemaRF02Temporario({ admin, nome } = {}) {
    if (!admin || typeof admin.query !== 'function') throw new Error('Conexão validada ausente para RF02.');
    if (!nomeTemporarioValido(nome)) throw new Error('RF02 recusado fora do clone descartável autorizado.');

    const bytes = readFileSync(CAMINHO_RELEASE);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== SHA256_RELEASE) throw new Error('SHA-256 do release RF02 não corresponde ao artefato aprovado para QA.');

    const declaracoes = analisarRelease(bytes.toString('utf8'));
    const createTables = selecionarCreateTables(declaracoes);
    for (const createTable of createTables) {
        // Além da primeira confirmação, cada repetição reconfirma o schema após
        // o CREATE anterior e antes do próximo. Nenhum statement é agrupado.
        await confirmarSchema(admin, nome);
        await admin.query(createTable);
    }
    await confirmarSchema(admin, nome);
}

module.exports = { prepararSchemaRF02Temporario };
