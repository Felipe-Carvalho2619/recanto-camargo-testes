'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const COMANDO_TESTE_UNITARIO = 'node --require ./tests/support/unit-test-preload.js --test tests/*.test.js';

test('isolamento: npm test carrega o preload antes dos arquivos de teste', () => {
    const packageJson = require('../package.json');
    assert.equal(packageJson.scripts.test, COMANDO_TESTE_UNITARIO);
});

test('isolamento: preload antecede db/crypto e impede dotenv e MySQL reais com cwd temporário', t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recanto-isolamento-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

    // Todos os valores são sintéticos e pertencem somente a este diretório descartável.
    fs.writeFileSync(path.join(cwd, '.env'), [
        'NODE_ENV=development',
        'RC_TEST_ISOLATION=0',
        'RC_QA_MYSQL_HARNESS=1',
        'RC_FIXTURE_DOTENV_MARKER=marcador-sintetico-do-arquivo',
        'JWT_SECRET=segredo-sintetico-do-arquivo-temporario',
        'DB_HOST=127.0.0.1'
    ].join('\n'), 'utf8');

    const backendDir = path.resolve(__dirname, '..');
    const preload = path.join(backendDir, 'tests/support/unit-test-preload.js');
    const fixture = path.join(backendDir, 'tests/support/isolamento-fixture.js');
    const env = {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        NODE_ENV: 'production',
        RC_TEST_ISOLATION: '0',
        RC_QA_MYSQL_HARNESS: '1'
    };

    const filho = spawnSync(process.execPath, ['--require', preload, fixture], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true
    });

    assert.equal(filho.error, undefined);
    assert.equal(filho.status, 0, filho.stderr || 'Processo filho estrutural falhou.');
    const marcador = filho.stdout.match(/RC_ISOLAMENTO_RESULTADO=(\{.*\})/);
    assert.ok(marcador, 'A fixture precisa devolver marcadores sintéticos de isolamento.');
    assert.deepEqual(JSON.parse(marcador[1]), {
        preloadAnterior: true,
        dotenvCarregamentos: 0,
        mysqlCarregamentos: 0,
        envNaoInjetado: true,
        queryBloqueada: true,
        conexaoBloqueada: true,
        endResolveu: true
    });
});
