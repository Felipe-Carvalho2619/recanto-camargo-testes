'use strict';

// Integração opt-in: somente os CREATE TABLE extraídos do release validado são
// executados no clone. A rotina/guarda já foi validada pelo Gate E; esta fixture
// não aplica a migration completa nem altera grants. Nenhum DDL ocorre na origem.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { criarAmbienteMySQL } = require('./support/mysql-harness');
const { prepararSchemaRF02Temporario } = require('./support/rf02-schema-temporario');
const { criarRecuperacaoSenhaService, dataMysql } = require('../services/recuperacaoSenhaService');
const { criarRecuperacaoSenhaOutboxService } = require('../services/recuperacaoSenhaOutboxService');
const { criarRecuperacaoSenhaRateLimitService } = require('../services/recuperacaoSenhaRateLimitService');
const { criarSessionService } = require('../services/sessionService');

const SEGREDO = Buffer.alloc(32, 0x42).toString('base64url');
const FRONTEND_URL = 'https://frontend.example.invalid';
const ENV = Object.freeze({ NODE_ENV: 'test', RF02_RESET_SECRET: SEGREDO, FRONTEND_URL });
const SENHA_A = 'Qa#2026FluxoA';
const SENHA_B = 'Qa#2026FluxoB';
const logger = { info() {}, warn() {}, error() {}, log() {} };

function criarClock(inicial = '2026-11-23T12:00:00.000Z') {
    let atual = new Date(inicial).getTime();
    return {
        clock: { now: () => new Date(atual) },
        agora: () => new Date(atual),
        avancar(ms) { atual += ms; }
    };
}

function criarEmailFake(aoEnviar) {
    const envios = [];
    return {
        envios,
        criarEmailRecuperacaoSenha({ urlRecuperacao }) {
            return `<p>${urlRecuperacao}</p>`;
        },
        async enviarEmail(...args) {
            envios.push(args);
            if (aoEnviar) await aoEnviar(args, envios.length);
            return { enviado: true };
        }
    };
}

async function esperarCodigo(promessa, codigo) {
    await assert.rejects(promessa, erro => {
        assert.equal(erro.codigo, codigo);
        return true;
    });
}

test('RF02 MySQL opt-in: privacidade, veto RF02-SEC-01, locks, CAS e leases reais', {
    skip: process.env.RUN_MYSQL_INTEGRATION !== '1',
    timeout: 120000
}, async t => {
    let qa;
    const enviosHttp = [];
    try {
        qa = await criarAmbienteMySQL({
            prepararSchemaTemporario: prepararSchemaRF02Temporario,
            // Servidor mínimo: não inicializa server.js nem o worker RF02 em background.
            carregarServer: () => {
                process.env.RF02_RESET_SECRET = SEGREDO;
                process.env.FRONTEND_URL = FRONTEND_URL;
                process.env.NODE_ENV = 'test';
                process.env.RESEND_API_KEY = '';
                process.env.RESEND_FROM_EMAIL = '';

                const express = require('express');
                const cookieParser = require('cookie-parser');
                const db = require('../config/db');
                const app = express();
                app.use(express.json());
                app.use(cookieParser());
                app.set('recuperacaoSenhaService', criarRecuperacaoSenhaService({ db, env: process.env, logger }));
                app.set('recuperacaoSenhaRateLimitService', criarRecuperacaoSenhaRateLimitService({ db, env: process.env, logger }));
                app.set('sessionService', criarSessionService({ db, env: process.env, logger }));
                app.set('emailService', {
                    criarEmailRecuperacaoSenha: ({ urlRecuperacao }) => `<p>${urlRecuperacao}</p>`,
                    enviarEmail: async (...args) => {
                        enviosHttp.push(args);
                        return { enviado: true };
                    }
                });
                app.use('/api/usuarios', require('../routes/authRoutes'));
                return app;
            }
        });

        const api = async (caminho, { cookie, method = 'GET', body } = {}) => {
            const resposta = await fetch(`${qa.url}${caminho}`, {
                method,
                headers: {
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {})
            });
            const dados = await resposta.json().catch(() => null);
            return {
                status: resposta.status,
                dados,
                cacheControl: resposta.headers.get('cache-control'),
                retryAfter: resposta.headers.get('retry-after'),
                setCookie: resposta.headers.get('set-cookie')
            };
        };

        const [usuarios] = await qa.admin.query(
            'SELECT Usu_Id, Usu_SenhaHash FROM usu_usuario WHERE Usu_Id IN (2, 3) ORDER BY Usu_Id'
        );
        const hashesIniciais = new Map(usuarios.map(usuario => [usuario.Usu_Id, usuario.Usu_SenhaHash]));

        async function resetar() {
            await qa.admin.query('DELETE FROM rf02_rate_limit');
            await qa.admin.query('DELETE FROM rf02_recuperacao_senha');
            for (const [id, hash] of hashesIniciais) {
                await qa.admin.query(
                    'UPDATE usu_usuario SET Usu_Status = ?, Usu_SenhaHash = ? WHERE Usu_Id = ?',
                    ['ATIVO', hash, id]
                );
            }
            enviosHttp.length = 0;
        }

        function servicos({ db = qa.pool, clock, emailService = criarEmailFake() } = {}) {
            const recuperacao = criarRecuperacaoSenhaService({
                db, env: ENV, secret: SEGREDO, logger, clock: clock?.clock
            });
            const outbox = criarRecuperacaoSenhaOutboxService({
                db, env: ENV, secret: SEGREDO, logger, clock: clock?.clock,
                recuperacaoSenhaService: recuperacao, emailService
            });
            return { recuperacao, outbox, emailService };
        }

        async function inserirToken(recuperacao, {
            usuarioId = 2,
            clock,
            expiraEm,
            emailEstado = 'PENDENTE',
            processandoAte = null
        } = {}) {
            const agora = clock ? clock.agora() : new Date();
            const nonce = randomBytes(32);
            const token = recuperacao.reconstruirToken(nonce);
            const expira = expiraEm || new Date(agora.getTime() + 10 * 60 * 1000);
            const [resultado] = await qa.admin.query(
                `INSERT INTO rf02_recuperacao_senha
                 (usuario_id, nonce, token_hash, criado_em, expira_em, email_estado,
                  tentativas, proxima_tentativa_em, processando_ate, atualizado_em)
                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
                [usuarioId, nonce, recuperacao.hashToken(token), dataMysql(new Date(agora.getTime() - 1000)),
                    dataMysql(expira), emailEstado, dataMysql(new Date(agora.getTime() - 1000)),
                    processandoAte ? dataMysql(processandoAte) : null, dataMysql(agora)]
            );
            return { id: resultado.insertId, usuarioId, nonce, token, expiraEm: expira };
        }

        async function estadoToken(id) {
            const [linhas] = await qa.admin.query(
                `SELECT usuario_id, consumido_em, invalidado_em, email_estado, tentativas,
                        processando_ate, ultima_falha
                 FROM rf02_recuperacao_senha WHERE id = ?`,
                [id]
            );
            assert.equal(linhas.length, 1);
            return linhas[0];
        }

        await t.test('precondição: release RF02 foi provisionado somente no clone descartável', async () => {
            const [tabelas] = await qa.admin.query(
                `SELECT TABLE_NAME AS nome FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('rf02_recuperacao_senha', 'rf02_rate_limit')`,
                [qa.nome]
            );
            assert.deepEqual(tabelas.map(item => item.nome).sort(), ['rf02_rate_limit', 'rf02_recuperacao_senha'],
                'Tabelas do release RF02 ausentes no clone descartável');
        });

        await t.test('HTTP: elegível, desconhecido e inativo retornam 202 idêntico após persistência, sem provider', async () => {
            await resetar();
            await qa.admin.query('UPDATE usu_usuario SET Usu_Status = ? WHERE Usu_Id = 3', ['INATIVO']);
            const respostas = [];
            for (const email of ['qa2@example.invalid', 'ausente@example.invalid', 'qa3@example.invalid']) {
                const resposta = await api('/api/usuarios/recuperacao-senha', {
                    method: 'POST', body: { email }
                });
                assert.equal(resposta.status, 202);
                assert.match(resposta.cacheControl, /no-store/);
                respostas.push(resposta.dados);
            }
            assert.deepEqual(respostas[1], respostas[0]);
            assert.deepEqual(respostas[2], respostas[0]);
            const [linhas] = await qa.admin.query(
                'SELECT usuario_id FROM rf02_recuperacao_senha ORDER BY id'
            );
            assert.deepEqual(linhas.map(linha => linha.usuario_id), [2, null, null]);
            assert.equal(enviosHttp.length, 0);
        });

        await t.test('review-4 HTTP real: POLITICA_SENHA e TOKEN_INVALIDO são 400 distintos', async () => {
            await resetar();
            const politica = await api('/api/usuarios/recuperacao-senha/confirmar', {
                method: 'POST', body: { token: 'nao-importa', novaSenha: 'fraca' }
            });
            assert.equal(politica.status, 400);
            assert.equal(politica.dados.code, 'POLITICA_SENHA');
            const token = await api('/api/usuarios/recuperacao-senha/confirmar', {
                method: 'POST', body: { token: randomBytes(32).toString('base64url'), novaSenha: SENHA_A }
            });
            assert.equal(token.status, 400);
            assert.equal(token.dados.code, 'TOKEN_INVALIDO');
        });

        await t.test('RF02-SEC-01 MySQL: usuario NULL descarta/invalida sem consumir nem enviar', async () => {
            await resetar();
            const fixture = servicos();
            const registro = await inserirToken(fixture.recuperacao, { usuarioId: null });
            await fixture.outbox.processarLote();
            const estado = await estadoToken(registro.id);
            assert.equal(estado.email_estado, 'DESCARTADA');
            assert.ok(estado.invalidado_em);
            assert.equal(estado.consumido_em, null);
            assert.equal(fixture.emailService.envios.length, 0);
            await esperarCodigo(fixture.recuperacao.confirmar({ token: registro.token, novaSenha: SENHA_A }), 'TOKEN_INVALIDO');
        });

        await t.test('RF02-SEC-01 MySQL: reativação antes do expira_em não reabilita token descartado por inatividade', async () => {
            await resetar();
            const fixture = servicos();
            const registro = await inserirToken(fixture.recuperacao);
            await qa.admin.query('UPDATE usu_usuario SET Usu_Status = ? WHERE Usu_Id = 2', ['INATIVO']);
            await fixture.outbox.processarLote();
            await qa.admin.query('UPDATE usu_usuario SET Usu_Status = ? WHERE Usu_Id = 2', ['ATIVO']);
            const estado = await estadoToken(registro.id);
            assert.equal(estado.email_estado, 'DESCARTADA');
            assert.ok(estado.invalidado_em);
            assert.equal(estado.consumido_em, null);
            assert.ok(new Date(registro.expiraEm).getTime() > Date.now());
            await esperarCodigo(fixture.recuperacao.confirmar({ token: registro.token, novaSenha: SENHA_A }), 'TOKEN_INVALIDO');
        });

        await t.test('RF02-SEC-01 MySQL: expiração grava invalidado_em e impede reset com conta ATIVA', async () => {
            await resetar();
            const fixture = servicos();
            const registro = await inserirToken(fixture.recuperacao, {
                expiraEm: new Date(Date.now() - 1000)
            });
            await fixture.outbox.processarLote();
            const estado = await estadoToken(registro.id);
            assert.equal(estado.email_estado, 'DESCARTADA');
            assert.ok(estado.invalidado_em);
            assert.equal(estado.consumido_em, null);
            assert.equal(fixture.emailService.envios.length, 0);
            await esperarCodigo(fixture.recuperacao.confirmar({ token: registro.token, novaSenha: SENHA_A }), 'TOKEN_INVALIDO');
        });

        await t.test('RF02-SEC-01 MySQL: reset consome somente o token usado e invalida os demais', async () => {
            await resetar();
            const fixture = servicos();
            const usado = await inserirToken(fixture.recuperacao);
            const outro = await inserirToken(fixture.recuperacao);
            await fixture.recuperacao.confirmar({ token: usado.token, novaSenha: SENHA_A });
            const estadoUsado = await estadoToken(usado.id);
            const estadoOutro = await estadoToken(outro.id);
            assert.ok(estadoUsado.consumido_em);
            assert.equal(estadoOutro.consumido_em, null);
            assert.ok(estadoOutro.invalidado_em);
            await esperarCodigo(fixture.recuperacao.confirmar({ token: usado.token, novaSenha: SENHA_B }), 'TOKEN_INVALIDO');
            await esperarCodigo(fixture.recuperacao.confirmar({ token: outro.token, novaSenha: SENHA_B }), 'TOKEN_INVALIDO');
        });

        await t.test('MySQL FOR UPDATE: corrida do mesmo token produz exatamente um reset', async () => {
            await resetar();
            const fixture = servicos();
            const registro = await inserirToken(fixture.recuperacao);
            const resultados = await Promise.allSettled([
                fixture.recuperacao.confirmar({ token: registro.token, novaSenha: SENHA_A }),
                fixture.recuperacao.confirmar({ token: registro.token, novaSenha: SENHA_B })
            ]);
            assert.deepEqual(resultados.map(resultado => resultado.status).sort(), ['fulfilled', 'rejected']);
            assert.equal(resultados.find(resultado => resultado.status === 'rejected').reason.codigo, 'TOKEN_INVALIDO');
            assert.ok((await estadoToken(registro.id)).consumido_em);
        });

        await t.test('review-2 MySQL: alterarSenha concorrente usa affectedRows; só o vencedor reemite cookie', async () => {
            await resetar();
            const cookieAntigo = await qa.login(2);
            const chamada = novaSenha => api('/api/usuarios/senha', {
                cookie: cookieAntigo,
                method: 'PUT',
                body: { senhaAtual: qa.senha, novaSenha }
            });
            const respostas = await Promise.all([chamada(SENHA_A), chamada(SENHA_B)]);
            const vencedor = respostas.find(resposta => resposta.status === 200);
            const perdedor = respostas.find(resposta => resposta.status === 409);
            assert.ok(vencedor, JSON.stringify(respostas.map(resposta => resposta.dados)));
            assert.ok(perdedor, JSON.stringify(respostas.map(resposta => resposta.dados)));
            assert.match(vencedor.setCookie || '', /^token=/);
            assert.doesNotMatch(perdedor.setCookie || '', /^token=/);

            const antiga = await api('/api/usuarios/sessao', { cookie: cookieAntigo });
            assert.equal(antiga.status, 200);
            assert.equal(antiga.dados.usuario, null);
            const nova = await api('/api/usuarios/sessao', { cookie: vencedor.setCookie.split(';')[0] });
            assert.equal(nova.status, 200);
            assert.equal(nova.dados.usuario.id, 2);
            const senhaVencedora = respostas.indexOf(vencedor) === 0 ? SENHA_A : SENHA_B;
            const loginAntigo = await api('/api/usuarios/login', {
                method: 'POST', body: { email: 'qa2@example.invalid', senha: qa.senha }
            });
            assert.equal(loginAntigo.status, 401);
            const loginNovo = await api('/api/usuarios/login', {
                method: 'POST', body: { email: 'qa2@example.invalid', senha: senhaVencedora }
            });
            assert.equal(loginNovo.status, 200);
        });

        await t.test('review-3 MySQL: dois registros sequenciais renovam lease mesmo após 31 s no primeiro provider', async () => {
            await resetar();
            const clock = criarClock();
            const emailService = criarEmailFake(async (_args, quantidade) => {
                if (quantidade === 1) clock.avancar(31000);
            });
            const fixture = servicos({ clock, emailService });
            await inserirToken(fixture.recuperacao, { clock });
            await inserirToken(fixture.recuperacao, { clock });
            await fixture.outbox.processarLote();
            assert.equal(emailService.envios.length, 2);
            const [estados] = await qa.admin.query(
                'SELECT email_estado FROM rf02_recuperacao_senha ORDER BY id'
            );
            assert.deepEqual(estados.map(item => item.email_estado), ['ACEITA', 'ACEITA']);
        });

        await t.test('review-3 MySQL: SKIP LOCKED impede claim/provider duplicado entre dois workers', async () => {
            await resetar();
            const clock = criarClock();
            const emailService = criarEmailFake();
            const primeiro = servicos({ clock, emailService });
            const segundo = servicos({ clock, emailService });
            await inserirToken(primeiro.recuperacao, { clock });
            await inserirToken(primeiro.recuperacao, { clock });
            const resultados = await Promise.all([primeiro.outbox.processarLote(), segundo.outbox.processarLote()]);
            assert.equal(resultados.reduce((total, item) => total + item.processados, 0), 2);
            assert.equal(emailService.envios.length, 2);
            assert.equal(new Set(emailService.envios.map(args => args[3])).size, 2);
        });

        await t.test('RF02-SEC-01 MySQL: reset entre leitura e renovação impede provider na corrida real', async () => {
            await resetar();
            const base = servicos();
            const registro = await inserirToken(base.recuperacao);
            const emailService = criarEmailFake();
            let resetExecutado = false;
            const db = {
                getConnection: () => qa.pool.getConnection(),
                async query(sql, parametros) {
                    const resultado = await qa.pool.query(sql, parametros);
                    if (!resetExecutado && /SELECT u\.Usu_Nome, u\.Usu_Email, u\.Usu_Status/.test(sql)) {
                        resetExecutado = true;
                        await base.recuperacao.confirmar({ token: registro.token, novaSenha: SENHA_A });
                    }
                    return resultado;
                }
            };
            const fixture = servicos({ db, emailService });
            await fixture.outbox.processarLote();
            assert.equal(resetExecutado, true);
            assert.equal(emailService.envios.length, 0);
            assert.ok((await estadoToken(registro.id)).consumido_em);
        });

        await t.test('MySQL rate-limit: dois workers compartilham fixed-window sem IP/e-mail em claro', async () => {
            await resetar();
            const opcoes = { db: qa.pool, env: ENV, secret: SEGREDO, logger };
            const primeiro = criarRecuperacaoSenhaRateLimitService(opcoes);
            const segundo = criarRecuperacaoSenhaRateLimitService(opcoes);
            const entrada = { ip: '198.51.100.77', email: 'qa2@example.invalid' };
            const resultados = await Promise.all([
                primeiro.limitarSolicitacao(entrada), segundo.limitarSolicitacao(entrada)
            ]);
            assert.deepEqual(resultados.map(resultado => resultado.permitido).sort(), [false, true]);
            const [buckets] = await qa.admin.query('SELECT escopo, chave_hmac FROM rf02_rate_limit');
            assert.equal(buckets.length, 3);
            for (const bucket of buckets) {
                assert.equal(bucket.chave_hmac.length, 32);
                assert.equal(bucket.chave_hmac.includes(Buffer.from(entrada.ip)), false);
                assert.equal(bucket.chave_hmac.includes(Buffer.from(entrada.email)), false);
            }
        });
    } finally {
        if (qa) await qa.fechar();
    }
});
