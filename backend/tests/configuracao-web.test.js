const test = require('node:test');
const assert = require('node:assert/strict');
const { listarOrigensPermitidas, criarVerificadorOrigem, opcoesCookieSessao } = require('../utils/configuracaoWeb');

test('CORS: sem configuração, libera somente o front local de desenvolvimento', () => {
    assert.deepEqual(listarOrigensPermitidas({}), ['http://localhost:5173']);
});

test('CORS: usa CORS_ORIGINS, aceita várias origens e ignora caminho e hash da URL', () => {
    const origens = listarOrigensPermitidas({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://rafaelrizzoo.github.io/recanto-camargo/#, https://recanto.exemplo.com.br'
    });
    assert.deepEqual(origens, ['https://rafaelrizzoo.github.io', 'https://recanto.exemplo.com.br']);
});

test('CORS: em produção não libera localhost por padrão', () => {
    const verificar = criarVerificadorOrigem({ NODE_ENV: 'production', CORS_ORIGINS: 'https://recanto.exemplo.com.br' });
    let liberado;
    verificar('http://localhost:5173', (_erro, ok) => { liberado = ok; });
    assert.equal(liberado, false);
    verificar('https://recanto.exemplo.com.br', (_erro, ok) => { liberado = ok; });
    assert.equal(liberado, true);
    verificar(undefined, (_erro, ok) => { liberado = ok; });
    assert.equal(liberado, true);
});

test('Cookie: em desenvolvimento usa sameSite=lax sem exigir HTTPS', () => {
    assert.deepEqual(opcoesCookieSessao({}), { httpOnly: true, secure: false, sameSite: 'lax' });
});

test('Cookie: em produção é secure e sameSite=none por padrão (site e API em domínios diferentes)', () => {
    assert.deepEqual(opcoesCookieSessao({ NODE_ENV: 'production' }), { httpOnly: true, secure: true, sameSite: 'none' });
});

test('Cookie: COOKIE_SAMESITE=lax em produção mantém secure e troca o sameSite', () => {
    assert.deepEqual(opcoesCookieSessao({ NODE_ENV: 'production', COOKIE_SAMESITE: 'lax' }), { httpOnly: true, secure: true, sameSite: 'lax' });
});

test('Cookie: sameSite=none nunca fica sem secure (o navegador recusaria o cookie)', () => {
    const opcoes = opcoesCookieSessao({ COOKIE_SAMESITE: 'none' });
    assert.equal(opcoes.secure, true);
});

test('REV-02: app real de server.js aplica CORS estrito sem tocar rotas de banco', async t => {
    const anteriores = new Map();
    for (const chave of ['NODE_ENV', 'CORS_ORIGINS']) {
        anteriores.set(chave, {
            existe: Object.prototype.hasOwnProperty.call(process.env, chave),
            valor: process.env[chave]
        });
    }
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://recanto.exemplo.com.br';

    let servidor;
    t.after(async () => {
        if (servidor) {
            await new Promise(resolve => {
                servidor.close(resolve);
                if (typeof servidor.closeAllConnections === 'function') servidor.closeAllConnections();
            });
        }
        for (const [chave, anterior] of anteriores) {
            if (anterior.existe) process.env[chave] = anterior.valor;
            else delete process.env[chave];
        }
    });

    // RC_TEST_ISOLATION=1 do preload mantém a fachada de db bloqueada durante este import real.
    const app = require('../server');
    servidor = await new Promise(resolve => {
        const instancia = app.listen(0, '127.0.0.1', () => resolve(instancia));
    });
    const base = `http://127.0.0.1:${servidor.address().port}`;

    async function semRota(origem) {
        const resposta = await fetch(`${base}/__rev_02_sem_rota_de_db__`, {
            headers: origem === undefined ? {} : { Origin: origem }
        });
        assert.equal(resposta.status, 404);
        await resposta.text();
        return resposta;
    }

    for (const origem of [
        'https://recanto-camargo-arbitrario.vercel.app',
        'https://localhost.exemplo.invalid',
        'http://localhost:5173.evil.invalid',
        'https://recanto.exemplo.com.br.evil.invalid'
    ]) {
        const resposta = await semRota(origem);
        assert.equal(resposta.headers.get('access-control-allow-origin'), null, origem);
    }

    const exata = await semRota('https://recanto.exemplo.com.br');
    assert.equal(exata.headers.get('access-control-allow-origin'), 'https://recanto.exemplo.com.br');
    assert.equal(exata.headers.get('access-control-allow-credentials'), 'true');

    const semOrigem = await semRota(undefined);
    assert.equal(semOrigem.headers.get('access-control-allow-origin'), null);
});
