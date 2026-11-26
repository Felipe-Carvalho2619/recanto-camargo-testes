'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const caminhoDb = path.resolve(__dirname, '../../config/db');
const caminhoCrypto = path.resolve(__dirname, '../../utils/crypto');
const caminhoPreload = path.resolve(__dirname, './unit-test-preload.js');

async function executar() {
    // O processo filho começa com valores opostos; só o --require pode fixá-los antes deste arquivo.
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.RC_TEST_ISOLATION, '1');
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'RC_QA_MYSQL_HARNESS'), false);
    assert.ok(require.cache[caminhoPreload], 'O preload precisa estar em cache antes da fixture.');
    assert.equal(require.cache[caminhoDb], undefined, 'config/db não pode anteceder o preload.');
    assert.equal(require.cache[caminhoCrypto], undefined, 'utils/crypto não pode anteceder o preload.');

    const carregamentosDotenv = [];
    const carregamentosMysql = [];
    const loadOriginal = Module._load;

    Module._load = function loadObservado(request, parent, isMain) {
        if (request === 'dotenv') {
            carregamentosDotenv.push(request);
            // Se houver regressão, somente o .env sintético do cwd temporário poderá ser lido.
            return loadOriginal.call(this, request, parent, isMain);
        }
        if (request === 'mysql2' || request === 'mysql2/promise') {
            carregamentosMysql.push(request);
            const erro = new Error(`Import real bloqueado pela fixture estrutural: ${request}`);
            erro.code = 'RC_FIXTURE_MYSQL_REAL_BLOQUEADO';
            throw erro;
        }
        return loadOriginal.call(this, request, parent, isMain);
    };

    try {
        const db = require(caminhoDb);
        require(caminhoCrypto);

        assert.equal(process.env.RC_FIXTURE_DOTENV_MARKER, undefined, '.env temporário não pode injetar marcador.');
        assert.equal(process.env.JWT_SECRET, undefined, '.env temporário não pode injetar JWT_SECRET sintético.');
        assert.deepEqual(carregamentosDotenv, []);
        assert.deepEqual(carregamentosMysql, []);

        await assert.rejects(
            () => db.query('SELECT 1'),
            /MySQL real bloqueado em testes sem harness explícito/
        );
        await assert.rejects(
            () => db.getConnection(),
            /MySQL real bloqueado em testes sem harness explícito/
        );
        await db.end();

        assert.deepEqual(carregamentosDotenv, []);
        assert.deepEqual(carregamentosMysql, [], 'query/getConnection precisam rejeitar antes de importar mysql2.');
        assert.equal(process.env.RC_FIXTURE_DOTENV_MARKER, undefined);
        assert.equal(process.env.JWT_SECRET, undefined);

        process.stdout.write(`RC_ISOLAMENTO_RESULTADO=${JSON.stringify({
            preloadAnterior: true,
            dotenvCarregamentos: carregamentosDotenv.length,
            mysqlCarregamentos: carregamentosMysql.length,
            envNaoInjetado: true,
            queryBloqueada: true,
            conexaoBloqueada: true,
            endResolveu: true
        })}`);
    } finally {
        Module._load = loadOriginal;
    }
}

executar().catch(erro => {
    console.error(erro.stack);
    process.exitCode = 1;
});
