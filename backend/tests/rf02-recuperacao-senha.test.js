'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
    criarRecuperacaoSenhaService,
    TTL_RECUPERACAO_MS,
    decodificarBase64Url32
} = require('../services/recuperacaoSenhaService');
const {
    criarRecuperacaoSenhaOutboxService,
    ATRASOS_RETRY_MS
} = require('../services/recuperacaoSenhaOutboxService');
const { criarRecuperacaoSenhaRateLimitService } = require('../services/recuperacaoSenhaRateLimitService');
const { criarSessionService } = require('../services/sessionService');
const { criarServicoEmail } = require('../email');
const { validarComplexidadeSenha } = require('../utils/politicaSenha');
const { opcoesCookieSessao } = require('../utils/configuracaoWeb');
const {
    criarLoggerFake,
    criarClockFake,
    criarDbFake,
    criarRequestFake,
    chamarHandler,
    chamarMiddleware,
    capturarConsoleFake,
    carregarAuthIsolado,
    serializar
} = require('./support/rf02-fakes');

const SEGREDO_BYTES = Buffer.alloc(32, 0x42);
const SEGREDO = SEGREDO_BYTES.toString('base64url');
const SEGREDO_SESSAO = Buffer.alloc(32, 0x24).toString('base64url');
const FRONTEND = 'https://frontend.example.invalid';
const EMAIL = 'rf02-active@example.invalid';
const EMAIL_INEXISTENTE = 'rf02-missing@example.invalid';
const EMAIL_INATIVO = 'rf02-inactive@example.invalid';
const IP = '198.51.100.77';
const SENHA_ANTIGA = 'Qa#2026Antiga';
const SENHA_NOVA = 'Qa#2026Nova';
const SENHAS = [SENHA_ANTIGA, SENHA_NOVA];

function envBase(alteracoes = {}) {
    return {
        NODE_ENV: 'test',
        RF02_RESET_SECRET: SEGREDO,
        FRONTEND_URL: FRONTEND,
        ...alteracoes
    };
}

function servicoRecuperacao(db, clock, opcoes = {}) {
    return criarRecuperacaoSenhaService({
        db,
        env: envBase(opcoes.env),
        logger: opcoes.logger || criarLoggerFake(),
        clock: clock ? clock.clock : criarClockFake().clock,
        secret: SEGREDO,
        randomBytes: opcoes.randomBytes || (() => Buffer.alloc(32, 0x11)),
        bcryptLibrary: opcoes.bcryptLibrary
    });
}

function bcryptFake(registro = {}) {
    registro.custos = [];
    return {
        async genSalt(custo) {
            registro.custos.push(custo);
            return 'salt-sintetico';
        },
        async hash(senha, salt) {
            registro.hash = { senha, salt };
            return 'hash-bcrypt-sintetico';
        },
        async compare() { return false; }
    };
}

function esperarCodigo(promessa, codigo, contexto) {
    return assert.rejects(promessa, erro => {
        assert.equal(erro.codigo, codigo);
        return true;
    }, contexto);
}

function assertSemSensiveis(alvo, sensiveis, contexto = 'artefato') {
    const texto = typeof alvo === 'string' ? alvo : serializar(alvo);
    let indice = 0;
    for (const sensivel of sensiveis.flat(Infinity)) {
        indice += 1;
        if (sensivel === undefined || sensivel === null || sensivel === '') continue;
        const representacoes = [String(sensivel)];
        if (Buffer.isBuffer(sensivel)) {
            representacoes.push(sensivel.toString('hex'), sensivel.toString('base64'), sensivel.toString('base64url'));
        }
        for (const representacao of representacoes) {
            assert.ok(!texto.includes(representacao), `${contexto}: exposição sensível #${indice}`);
        }
    }
}

function montarSolicitacao({ usuarios = {}, falhaInsert = false } = {}) {
    const inseridos = [];
    const db = criarDbFake(({ sql, parametros }) => {
        if (sql.startsWith('SELECT Usu_Id FROM usu_usuario WHERE Usu_Email')) {
            const id = usuarios[parametros[0]];
            return [id ? [{ Usu_Id: id }] : []];
        }
        if (sql.startsWith('INSERT INTO rf02_recuperacao_senha')) {
            if (falhaInsert) throw new Error('falha insert sintética');
            inseridos.push(parametros);
            return [{ insertId: inseridos.length }];
        }
        throw new Error('Query de solicitação não configurada.');
    });
    let sequencia = 0;
    const clock = criarClockFake();
    const service = servicoRecuperacao(db, clock, {
        randomBytes: () => Buffer.alloc(32, ++sequencia)
    });
    return { db, inseridos, service, clock };
}

test('RF02 HTTP: existente, inexistente e inativa compartilham 202/corpo/headers após commit, sem provider', async t => {
    const fixture = montarSolicitacao({ usuarios: { [EMAIL]: 71 } });
    const { controller, cleanup } = carregarAuthIsolado(fixture.db);
    t.after(cleanup);
    let provedor = 0;
    const emailService = { enviarEmail: async () => { provedor += 1; } };
    const rateLimitService = { limitarSolicitacao: async () => ({ permitido: true, retryAfter: 0 }) };
    const respostas = [];

    for (const [indice, email] of [EMAIL, EMAIL_INEXISTENTE, EMAIL_INATIVO].entries()) {
        const req = criarRequestFake({
            body: { email },
            ip: `198.51.100.${80 + indice}`,
            services: {
                recuperacaoSenhaService: fixture.service,
                recuperacaoSenhaRateLimitService: rateLimitService,
                emailService
            }
        });
        const res = await chamarHandler(controller.solicitarRecuperacaoSenha, req);
        assert.equal(res.statusCode, 202);
        assert.equal(fixture.db.eventos.filter(evento => evento === 'commit').length, indice + 1);
        assert.equal(fixture.db.eventos.filter(evento => evento === 'release').length, indice + 1);
        respostas.push(res);
    }

    assert.deepEqual(respostas[1].body, respostas[0].body);
    assert.deepEqual(respostas[2].body, respostas[0].body);
    for (const res of respostas) assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(fixture.inseridos.map(item => item[0]), [71, null, null]);
    assert.equal(provedor, 0);
    assertSemSensiveis(respostas, [[EMAIL, EMAIL_INEXISTENTE, EMAIL_INATIVO, IP], SEGREDO], 'respostas de solicitação');
});

test('RF02 HTTP: validação de entrada antecede configuração, rate-limit, banco e provider', async t => {
    const db = criarDbFake(() => { throw new Error('Banco não deveria ser chamado.'); });
    const { controller, cleanup } = carregarAuthIsolado(db);
    t.after(cleanup);
    let chamadas = 0;
    const services = {
        recuperacaoSenhaService: {
            validarConfiguracaoGlobal() { chamadas += 1; },
            async solicitar() { chamadas += 1; }
        },
        recuperacaoSenhaRateLimitService: {
            async limitarSolicitacao() { chamadas += 1; }
        }
    };
    for (const email of [undefined, null, '', 'texto', 'a@b.c', {}, `${'a'.repeat(250)}@x.invalid`]) {
        const res = await chamarHandler(
            controller.solicitarRecuperacaoSenha,
            criarRequestFake({ body: { email }, services })
        );
        assert.equal(res.statusCode, 400);
        assert.equal(res.headers['cache-control'], 'no-store');
    }
    assert.equal(chamadas, 0);
    assert.equal(db.chamadas.length, 0);
});

test('RF02 HTTP: falha no insert produz rollback/release, 503 sanitizado e nenhum provider', async t => {
    const fixture = montarSolicitacao({ usuarios: { [EMAIL]: 71 }, falhaInsert: true });
    const { controller, cleanup } = carregarAuthIsolado(fixture.db);
    t.after(cleanup);
    const consoleFake = capturarConsoleFake();
    t.after(consoleFake.restaurar);
    let provedor = 0;
    const services = {
        recuperacaoSenhaService: fixture.service,
        recuperacaoSenhaRateLimitService: {
            limitarSolicitacao: async () => ({ permitido: true, retryAfter: 0 })
        },
        emailService: { enviarEmail: async () => { provedor += 1; } }
    };
    const res = await chamarHandler(
        controller.solicitarRecuperacaoSenha,
        criarRequestFake({ body: { email: EMAIL }, ip: IP, services })
    );
    assert.equal(res.statusCode, 503);
    assert.ok(fixture.db.eventos.includes('rollback'));
    assert.ok(fixture.db.eventos.includes('release'));
    assert.equal(provedor, 0);
    assertSemSensiveis([res, consoleFake.logger.texto()], [EMAIL, IP, SEGREDO], 'falha de insert');
});

test('RF02 solicitação: nova solicitação preserva anterior e persiste somente nonce/digest', async () => {
    const fixture = montarSolicitacao({ usuarios: { [EMAIL]: 71 } });
    await fixture.service.solicitar({ email: EMAIL });
    await fixture.service.solicitar({ email: EMAIL });
    assert.equal(fixture.inseridos.length, 2);
    assert.equal(fixture.db.chamadas.some(chamada => /^UPDATE rf02_recuperacao_senha/.test(chamada.sql)), false);
    assert.notDeepEqual(fixture.inseridos[0][1], fixture.inseridos[1][1]);
    const token0 = fixture.service.reconstruirToken(fixture.inseridos[0][1]);
    const token1 = fixture.service.reconstruirToken(fixture.inseridos[1][1]);
    assert.notEqual(token0, token1);
    assert.deepEqual(fixture.inseridos[0][2], fixture.service.hashToken(token0));
    assert.deepEqual(fixture.inseridos[1][2], fixture.service.hashToken(token1));
    assertSemSensiveis(fixture.inseridos.map(item => item.slice(2)), [[token0, token1], ...SENHAS], 'parâmetros após nonce');
});

test('RF02 token: Base64URL canônico de 32 bytes; padding, tamanho, caracteres e forma não canônica são inválidos', () => {
    const service = servicoRecuperacao({}, criarClockFake());
    const bruto = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const token = bruto.toString('base64url');
    assert.equal(token.length, 43);
    assert.deepEqual(decodificarBase64Url32(token), bruto);

    const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const ultimo = token.at(-1);
    const naoCanonico = `${token.slice(0, -1)}${alfabeto[alfabeto.indexOf(ultimo) ^ 1]}`;
    assert.deepEqual(Buffer.from(naoCanonico, 'base64url'), bruto, 'fixture deve diferir somente nos bits não canônicos');

    const invalidos = [
        undefined, null, {}, '', `${token}=`, `${token}==`, token.slice(1), `${token}A`,
        token.replace(/.$/, '+'), token.replace(/.$/, '/'), token.replace(/.$/, '!'),
        Buffer.alloc(31).toString('base64url'), Buffer.alloc(33).toString('base64url'), naoCanonico
    ];
    for (const invalido of invalidos) {
        assert.equal(decodificarBase64Url32(invalido), null);
        assert.throws(() => service.decodificarToken(invalido), erro => erro.codigo === 'TOKEN_INVALIDO');
    }
});

test('RF02 token: digest SHA-256 usa bytes brutos decodificados, não o texto Base64URL', () => {
    const service = servicoRecuperacao({}, criarClockFake());
    const nonce = Buffer.alloc(32, 0x63);
    const token = service.reconstruirToken(nonce);
    const bruto = service.decodificarToken(token);
    const esperado = crypto.createHash('sha256').update(bruto).digest();
    const doTexto = crypto.createHash('sha256').update(token, 'utf8').digest();
    assert.deepEqual(service.hashToken(token), esperado);
    assert.notDeepEqual(service.hashToken(token), doTexto);
    assert.deepEqual(service.hashTokenBruto(bruto), esperado);
});

test('RF02 token: reconstrução HMAC compara nonce com timingSafeEqual e rejeita divergência', async t => {
    const nonce = Buffer.alloc(32, 0x19);
    const serviceBase = servicoRecuperacao({}, criarClockFake());
    const token = serviceBase.reconstruirToken(nonce);
    const db = criarDbFake(({ sql }) => {
        if (sql.startsWith('SELECT id, usuario_id, nonce FROM rf02_recuperacao_senha')) {
            return [[{ id: 1, usuario_id: 71, nonce: Buffer.alloc(32, 0x20) }]];
        }
        throw new Error('Não deveria avançar após HMAC divergente.');
    });
    const service = servicoRecuperacao(db, criarClockFake(), { bcryptLibrary: bcryptFake() });
    const original = crypto.timingSafeEqual;
    let chamadas = 0;
    crypto.timingSafeEqual = (...args) => { chamadas += 1; return original(...args); };
    t.after(() => { crypto.timingSafeEqual = original; });
    await esperarCodigo(service.confirmar({ token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.ok(chamadas >= 1);
});

function montarConfirmacao(opcoes = {}) {
    const clock = opcoes.clock || criarClockFake();
    const nonce = opcoes.nonce || Buffer.alloc(32, 0x31);
    const base = servicoRecuperacao({}, clock);
    const token = base.reconstruirToken(nonce);
    const tokenHash = base.hashToken(token);
    const estado = {
        status: opcoes.status || 'ATIVO',
        senhaHash: opcoes.senhaHash || 'hash-antigo',
        consumido: opcoes.consumidoInicial || false,
        invalidado: opcoes.invalidadoInicial || false,
        invalidadosOutros: 0,
        atualizacoesSenha: 0,
        expiraEm: opcoes.expiraEm || new Date(clock.agora().getTime() + TTL_RECUPERACAO_MS)
    };
    let snapshot;
    const db = criarDbFake(({ sql, parametros }) => {
        if (sql.startsWith('SELECT id, usuario_id, nonce FROM rf02_recuperacao_senha')) {
            if (opcoes.semPreliminar) return [[]];
            return [[{
                id: 91,
                usuario_id: opcoes.preliminarNulo ? null : 71,
                nonce: opcoes.noncePreliminar || nonce
            }]];
        }
        if (sql.startsWith('SELECT Usu_Id FROM usu_usuario WHERE Usu_Id')) {
            return [estado.status === 'ATIVO' ? [{ Usu_Id: 71 }] : []];
        }
        if (sql.startsWith('SELECT id, nonce FROM rf02_recuperacao_senha')) {
            const agora = new Date(`${parametros[3]}Z`.replace(' ', 'T')).getTime();
            const elegivel = !estado.consumido && !estado.invalidado && estado.expiraEm.getTime() > agora;
            return [elegivel ? [{ id: 91, nonce }] : []];
        }
        if (sql.startsWith('UPDATE usu_usuario SET Usu_SenhaHash')) {
            if (opcoes.falha === 'senha') throw new Error('falha senha sintética');
            estado.atualizacoesSenha += 1;
            estado.senhaHash = parametros[0];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE rf02_recuperacao_senha SET consumido_em')) {
            if (opcoes.falha === 'consumo') throw new Error('falha consumo sintética');
            if (estado.consumido || estado.invalidado) return [{ affectedRows: 0 }];
            estado.consumido = true;
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE rf02_recuperacao_senha SET invalidado_em')) {
            if (opcoes.falha === 'invalidacao') throw new Error('falha invalidação sintética');
            estado.invalidadosOutros += 1;
            return [{ affectedRows: 2 }];
        }
        throw new Error('Query de confirmação não configurada.');
    }, {
        serializarTransacoes: true,
        aoEvento(evento) {
            if (evento === 'begin') snapshot = { ...estado };
            if (evento === 'rollback' && snapshot) Object.assign(estado, snapshot);
        }
    });
    const registroBcrypt = {};
    const biblioteca = opcoes.bcryptLibrary || bcryptFake(registroBcrypt);
    const service = servicoRecuperacao(db, clock, { bcryptLibrary: biblioteca });
    return { db, estado, service, token, nonce, tokenHash, registroBcrypt, clock };
}

test('RF02 reset: token válido consome, invalida todos os demais, bcrypt custo 10 e commit/release', async () => {
    const fixture = montarConfirmacao();
    await fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA });
    assert.deepEqual(fixture.registroBcrypt.custos, [10]);
    assert.equal(fixture.estado.senhaHash, 'hash-bcrypt-sintetico');
    assert.equal(fixture.estado.consumido, true);
    assert.equal(fixture.estado.invalidadosOutros, 1);
    const invalidacao = fixture.db.chamadas.find(chamada => chamada.sql.startsWith('UPDATE rf02_recuperacao_senha SET invalidado_em'));
    assert.match(invalidacao.sql, /usuario_id = \? AND id <> \? AND consumido_em IS NULL AND invalidado_em IS NULL/);
    assert.deepEqual(fixture.db.eventos.slice(-2), ['commit', 'release']);
});

test('RF02 reset: token desconhecido e adulterado não alteram estado', async () => {
    for (const adulterado of [false, true]) {
        const fixture = montarConfirmacao({ semPreliminar: adulterado });
        const token = adulterado
            ? `${fixture.token.slice(0, -2)}${fixture.token.at(-2) === 'A' ? 'B' : 'A'}${fixture.token.at(-1)}`
            : Buffer.alloc(32, 0x77).toString('base64url');
        await esperarCodigo(fixture.service.confirmar({ token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
        assert.equal(fixture.estado.atualizacoesSenha, 0);
        assert.equal(fixture.estado.consumido, false);
    }
});

test('RF02 reset: expiração antes/limite/depois usa expira_em > agora', async () => {
    for (const [rotulo, delta, sucesso] of [['antes', 1, true], ['limite', 0, false], ['depois', -1, false]]) {
        const clock = criarClockFake();
        const expiraEm = new Date(clock.agora().getTime() + TTL_RECUPERACAO_MS + delta);
        const fixture = montarConfirmacao({ clock, expiraEm });
        clock.avancar(TTL_RECUPERACAO_MS);
        const operacao = fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA });
        if (sucesso) await operacao;
        else {
            let erro;
            try { await operacao; } catch (capturado) { erro = capturado; }
            const consultaToken = fixture.db.chamadas.find(chamada => chamada.sql.startsWith('SELECT id, nonce FROM rf02_recuperacao_senha'));
            assert.equal(erro?.codigo, 'TOKEN_INVALIDO', [
                `${rotulo}: delta=${delta}`,
                `expira=${fixture.estado.expiraEm.toISOString()}`,
                `agora_sql=${consultaToken?.parametros[3]}`,
                `consumido=${fixture.estado.consumido}`
            ].join('; '));
        }
        assert.equal(fixture.estado.consumido, sucesso, rotulo);
        assert.equal(fixture.estado.atualizacoesSenha, sucesso ? 1 : 0, rotulo);
        if (!sucesso) {
            assert.ok(fixture.db.eventos.includes('rollback'), rotulo);
            assert.ok(fixture.db.eventos.includes('release'), rotulo);
        }
    }
});

test('RF02 reset: uso único rejeita segunda confirmação sem nova escrita de senha', async () => {
    const fixture = montarConfirmacao();
    await fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA });
    await esperarCodigo(fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.equal(fixture.estado.atualizacoesSenha, 1);
});

test('RF02 reset: corrida do mesmo token produz exatamente um sucesso', { timeout: 3000 }, async () => {
    const fixture = montarConfirmacao();
    const resultados = await Promise.allSettled([
        fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA }),
        fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA })
    ]);
    assert.deepEqual(resultados.map(resultado => resultado.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(resultados.find(resultado => resultado.status === 'rejected').reason.codigo, 'TOKEN_INVALIDO');
    assert.equal(fixture.estado.atualizacoesSenha, 1);
    assert.equal(fixture.db.eventos.filter(evento => evento === 'commit').length, 1);
});

test('RF02 reset: conta bloqueada após emissão do link não redefine nem consome', async () => {
    const fixture = montarConfirmacao({ status: 'BLOQUEADO' });
    await esperarCodigo(fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.equal(fixture.estado.senhaHash, 'hash-antigo');
    assert.equal(fixture.estado.consumido, false);
    assert.ok(fixture.db.eventos.includes('rollback'));
    assert.ok(fixture.db.eventos.includes('release'));
});

test('RF02 reset: falhas em senha/consumo/invalidação fazem rollback e release', async () => {
    for (const falha of ['senha', 'consumo', 'invalidacao']) {
        const fixture = montarConfirmacao({ falha });
        await assert.rejects(fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA }));
        assert.equal(fixture.estado.senhaHash, 'hash-antigo', falha);
        assert.equal(fixture.estado.consumido, false, falha);
        assert.equal(fixture.estado.invalidadosOutros, 0, falha);
        assert.ok(fixture.db.eventos.includes('rollback'), falha);
        assert.ok(fixture.db.eventos.includes('release'), falha);
    }
});

test('RF02 senha: todas as regras 8–100/maiúscula/minúscula/número/especial antes de banco/bcrypt', async () => {
    const invalidas = [
        undefined, null, {}, '', 'Aa1!xyz', `${'A'.repeat(98)}a1!`,
        'aa1!abcdef', 'AA1!ABCDEF', 'Aa!abcdef', 'Aa1abcdefg'
    ];
    for (const senha of invalidas) {
        const fixture = montarConfirmacao();
        await esperarCodigo(fixture.service.confirmar({ token: fixture.token, novaSenha: senha }), 'POLITICA_SENHA');
        assert.equal(fixture.db.chamadas.length, 0);
        assert.equal(fixture.registroBcrypt.custos.length, 0);
    }
    assert.equal(validarComplexidadeSenha('Aa1!wxyz'), null, 'mínimo 8');
    assert.equal(validarComplexidadeSenha(`Aa1!${'x'.repeat(96)}`), null, 'máximo 100');
});

test('RF02 reset + regressão login: bcrypt real custo 10, senha antiga falha, nova funciona e DTO não vaza época/JWT', async t => {
    const hashAntigo = await bcrypt.hash(SENHA_ANTIGA, 4);
    const fixture = montarConfirmacao({ senhaHash: hashAntigo, bcryptLibrary: bcrypt });
    await fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA });
    assert.equal(bcrypt.getRounds(fixture.estado.senhaHash), 10);
    assert.equal(await bcrypt.compare(SENHA_NOVA, fixture.estado.senhaHash), true);
    assert.equal(await bcrypt.compare(SENHA_ANTIGA, fixture.estado.senhaHash), false);
    assert.notEqual(fixture.estado.senhaHash, SENHA_NOVA);

    const loginDb = criarDbFake(({ sql }) => {
        if (sql.startsWith('SELECT * FROM usu_usuario WHERE Usu_Email')) {
            return [[{ Usu_Id: 71, Usu_Nome: 'Hóspede RF02', Usu_Email: EMAIL, Usu_Status: 'ATIVO', Usu_SenhaHash: fixture.estado.senhaHash }]];
        }
        if (sql.startsWith('SELECT * FROM pro_proprietario')) return [[]];
        if (sql.startsWith('SELECT usu.Usu_Id, usu.Usu_Nome, usu.Usu_Status, usu.Usu_SenhaHash')) {
            return [[{
                Usu_Id: 71,
                Usu_Nome: 'Hóspede RF02',
                Usu_Status: 'ATIVO',
                Usu_SenhaHash: fixture.estado.senhaHash,
                Usu_Tipo: 'hospede'
            }]];
        }
        throw new Error('Query de login/sessão não configurada.');
    });
    const sessionService = criarSessionService({ db: loginDb, secret: SEGREDO_SESSAO });
    const { controller, cleanup } = carregarAuthIsolado(loginDb);
    t.after(cleanup);
    const services = { sessionService, emailService: null };
    const antigo = await chamarHandler(controller.login, criarRequestFake({ body: { email: EMAIL, senha: SENHA_ANTIGA }, services }));
    assert.equal(antigo.statusCode, 401);
    const novo = await chamarHandler(controller.login, criarRequestFake({ body: { email: EMAIL, senha: SENHA_NOVA }, services }));
    assert.equal(novo.statusCode, 200);
    assert.deepEqual(Object.keys(novo.body.usuario).sort(), ['id', 'nome', 'tipo']);
    assertSemSensiveis(novo.body.usuario, ['se', 'iat', 'exp', fixture.estado.senhaHash, SENHA_NOVA], 'DTO de login');
    assert.equal(novo.cookies.length, 1);
    const sessao = await chamarHandler(controller.sessao, criarRequestFake({
        cookies: { token: novo.cookies[0].valor }, services
    }));
    assert.equal(sessao.statusCode, 200);
    assert.equal(sessao.body.usuario.id, 71);
    assertSemSensiveis(sessao.body.usuario, ['se', 'iat', 'exp', fixture.estado.senhaHash], 'DTO de sessão');
});

function montarOutbox(opcoes = {}) {
    const clock = opcoes.clock || criarClockFake();
    const logger = criarLoggerFake();
    const env = envBase(opcoes.env);
    const recuperacao = servicoRecuperacao({}, clock, { env, logger });
    const nonce = opcoes.nonce || Buffer.alloc(32, 0x51);
    const candidatos = opcoes.candidatos === undefined ? [{
        id: 1, usuario_id: 71, nonce, tentativas: 0
    }] : opcoes.candidatos;
    const leases = new Map();
    const tentativasAtuais = new Map(candidatos.map(candidato => [candidato.id, Number(candidato.tentativas)]));
    const estados = new Map(candidatos.map(candidato => [candidato.id, {
        ...candidato,
        tentativas: Number(candidato.tentativas),
        consumido_em: candidato.consumido_em ?? null,
        invalidado_em: candidato.invalidado_em ?? null,
        expira_em: candidato.expira_em ?? new Date(clock.agora().getTime() + TTL_RECUPERACAO_MS),
        email_estado: candidato.email_estado || 'PENDENTE',
        proxima_tentativa_em: candidato.proxima_tentativa_em ?? recuperacao.dataMysql(clock.agora()),
        processando_ate: candidato.processando_ate ?? null
    }]));
    const finalizacoes = [];
    const renovacoes = [];
    const descartes = [];
    const deletes = [];
    const envios = [];
    const urls = [];
    const eventosProvider = [];
    const paraMs = valor => {
        if (valor === null || valor === undefined) return Number.NaN;
        if (valor instanceof Date) return valor.getTime();
        const texto = String(valor);
        return new Date(texto.includes('T') ? texto : `${texto.replace(' ', 'T')}Z`).getTime();
    };
    const nonceConfere = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b)
        && a.length === b.length && crypto.timingSafeEqual(a, b);
    const elegivelParaClaim = (registro, atual) => {
        if (!registro) return false;
        const agoraMs = paraMs(atual);
        const pendente = registro.email_estado === 'PENDENTE'
            && paraMs(registro.proxima_tentativa_em) <= agoraMs;
        const processandoVencido = registro.email_estado === 'PROCESSANDO'
            && paraMs(registro.processando_ate) <= agoraMs;
        return registro.tentativas < 3
            && registro.consumido_em === null && registro.invalidado_em === null
            && paraMs(registro.expira_em) > agoraMs
            && (pendente || processandoVencido);
    };

    const db = criarDbFake(({ sql, parametros }) => {
        if (sql.includes("ultima_falha = 'lease_excedido'")
            || sql.includes("ultima_falha = 'tentativas_esgotadas'")
            || sql.includes("ultima_falha = 'expirado'")) {
            if (sql.includes("email_estado = 'DESCARTADA'")) descartes.push({ sql, parametros, origem: 'limpeza' });
            return [{ affectedRows: opcoes.limpezaAfetada || 0 }];
        }
        if (sql.startsWith('SELECT id, usuario_id, nonce, tentativas FROM rf02_recuperacao_senha')) {
            const atual = parametros[0];
            const selecionados = [...estados.values()]
                .filter(registro => elegivelParaClaim(registro, atual))
                .sort((a, b) => Number(a.id) - Number(b.id))
                .slice(0, 1)
                .map(registro => ({
                    id: registro.id,
                    usuario_id: registro.usuario_id,
                    nonce: registro.nonce,
                    tentativas: registro.tentativas
                }));
            return [selecionados];
        }
        if (sql.includes('tentativas = tentativas + 1')) {
            const [lease, atual, id, nonceReivindicado, tentativas] = parametros;
            const registro = estados.get(id);
            const afetadas = registro
                && tentativasAtuais.get(id) === Number(tentativas)
                && nonceConfere(registro.nonce, nonceReivindicado)
                && elegivelParaClaim(registro, atual) ? 1 : 0;
            if (afetadas === 1) {
                registro.email_estado = 'PROCESSANDO';
                registro.tentativas += 1;
                registro.processando_ate = lease;
                registro.atualizado_em = atual;
                tentativasAtuais.set(id, registro.tentativas);
                leases.set(id, lease);
            }
            return [{ affectedRows: afetadas }];
        }
        if (sql.startsWith('SELECT u.Usu_Nome, u.Usu_Email, u.Usu_Status')) {
            const [id, , tentativa, lease, atual] = parametros;
            if (leases.get(id) !== lease || tentativasAtuais.get(id) !== Number(tentativa)
                || paraMs(lease) <= paraMs(atual)) return [[]];
            if (opcoes.registros && Object.prototype.hasOwnProperty.call(opcoes.registros, parametros[0])) {
                const registro = opcoes.registros[parametros[0]];
                return [registro ? [registro] : []];
            }
            if (opcoes.semRegistro) return [[]];
            const candidato = candidatos.find(item => item.id === parametros[0]);
            if (candidato?.usuario_id === null) {
                return [[{ Usu_Nome: null, Usu_Email: null, Usu_Status: null }]];
            }
            return [[{ Usu_Nome: 'Hóspede RF02', Usu_Email: EMAIL, Usu_Status: 'ATIVO' }]];
        }
        if (sql.startsWith('UPDATE rf02_recuperacao_senha SET processando_ate = ?')) {
            const [novoLease, id, , tentativa, leaseAnterior, atual] = parametros;
            const leaseVigente = leases.get(id);
            const coincide = leaseAnterior === leaseVigente
                && tentativasAtuais.get(id) === Number(tentativa);
            const temporalOk = paraMs(leaseAnterior) > paraMs(atual);
            const afetadas = opcoes.renovacaoAfetada !== undefined
                ? opcoes.renovacaoAfetada
                : (coincide && temporalOk ? 1 : 0);
            if (afetadas === 1) leases.set(id, novoLease);
            renovacoes.push({ sql, parametros, id, tentativa, leaseAnterior, leaseVigente, novoLease, afetadas });
            return [{ affectedRows: afetadas }];
        }
        if (sql.startsWith('DELETE FROM rf02_recuperacao_senha')) {
            deletes.push({ sql, parametros });
            return [{ affectedRows: 0 }];
        }
        if (sql.startsWith('UPDATE rf02_recuperacao_senha SET email_estado')) {
            const estado = /SET email_estado = '([^']+)'/.exec(sql)?.[1];
            const predicado = estado === 'PENDENTE' ? parametros.slice(-5, -1) : parametros.slice(-4);
            const [id, noncePredicado, tentativaPredicado, leasePredicado] = predicado;
            const leaseVigente = leases.get(id);
            const coincide = leasePredicado === leaseVigente
                && tentativasAtuais.get(id) === Number(tentativaPredicado);
            const afetadas = opcoes.finalizacaoAfetada !== undefined
                ? opcoes.finalizacaoAfetada
                : (coincide ? 1 : 0);
            const finalizacao = {
                estado, sql, parametros, id, noncePredicado, tentativaPredicado,
                leasePredicado, leaseVigente, afetadas
            };
            finalizacoes.push(finalizacao);
            if (afetadas === 1) {
                const registro = estados.get(id);
                if (registro) {
                    registro.email_estado = estado;
                    registro.processando_ate = null;
                    registro.atualizado_em = parametros[estado === 'ACEITA' ? 1 : 2];
                    if (estado === 'PENDENTE') registro.proxima_tentativa_em = parametros[0];
                    if (estado === 'FALHA' || estado === 'DESCARTADA') {
                        registro.invalidado_em = registro.invalidado_em ?? parametros[0];
                    }
                }
            }
            if (estado === 'DESCARTADA') descartes.push({ ...finalizacao, origem: 'processamento' });
            return [{ affectedRows: afetadas }];
        }
        throw new Error('Query de outbox não configurada.');
    }, { serializarTransacoes: true });

    const resultadoPadrao = opcoes.resultadoEmail === undefined
        ? { enviado: true }
        : opcoes.resultadoEmail;
    const emailService = {
        criarEmailRecuperacaoSenha({ urlRecuperacao }) {
            urls.push(urlRecuperacao);
            if (opcoes.falhaTemplate) throw new Error('template sintético');
            return `<p>${urlRecuperacao}</p>`;
        },
        async enviarEmail(...args) {
            envios.push(args);
            eventosProvider.push([...db.eventos]);
            if (opcoes.aoEnviar) return opcoes.aoEnviar(args, { clock, envios, leases });
            if (typeof resultadoPadrao === 'function') return resultadoPadrao(args);
            if (resultadoPadrao instanceof Error) throw resultadoPadrao;
            return resultadoPadrao;
        }
    };
    const outbox = criarRecuperacaoSenhaOutboxService({
        db,
        emailService,
        logger,
        env,
        clock: clock.clock,
        secret: SEGREDO,
        recuperacaoSenhaService: recuperacao,
        rateLimitService: opcoes.rateLimitService,
        leaseMs: opcoes.leaseMs
    });
    return {
        db, outbox, logger, envios, urls, eventosProvider, finalizacoes, renovacoes,
        descartes, deletes, recuperacao, clock, nonce, candidatos, leases, tentativasAtuais
    };
}

test('RF02 outbox: usuario_id NULL é DESCARTADA sem consultar provider', async () => {
    const fixture = montarOutbox({ candidatos: [{ id: 1, usuario_id: null, nonce: Buffer.alloc(32, 1), tentativas: 0 }] });
    const resultado = await fixture.outbox.processarLote();
    assert.equal(resultado.processados, 1);
    assert.equal(fixture.envios.length, 0);
    assert.equal(fixture.finalizacoes.at(-1).estado, 'DESCARTADA');
    assert.ok(fixture.finalizacoes.at(-1).parametros.includes('conta_inelegivel'));
});

test('RF02 outbox: claim incrementa tentativa/lease e provider só ocorre após commit/release', async () => {
    const fixture = montarOutbox();
    await fixture.outbox.processarLote();
    assert.equal(fixture.envios.length, 1);
    const claim = fixture.db.chamadas.find(chamada => chamada.sql.includes('tentativas = tentativas + 1'));
    assert.equal(claim.parametros[4], 0);
    assert.equal(fixture.finalizacoes.at(-1).parametros.at(-2), 1);
    assert.equal(fixture.finalizacoes.at(-1).estado, 'ACEITA');
    assert.ok(fixture.eventosProvider[0].includes('commit'));
    assert.ok(fixture.eventosProvider[0].includes('release'));
    const lease = new Date(`${claim.parametros[0]}Z`.replace(' ', 'T')).getTime();
    assert.equal(lease - fixture.clock.agora().getTime(), 30000);
    assert.equal(fixture.envios[0][4].logs, false);
});

test('RF02 outbox: finalização otimista rejeita worker antigo e não registra ACEITA', async () => {
    const fixture = montarOutbox({ finalizacaoAfetada: 0 });
    await fixture.outbox.processarLote();
    assert.equal(fixture.finalizacoes.at(-1).afetadas, 0);
    assert.doesNotMatch(fixture.logger.texto(), /estado=ACEITA/);
    assert.equal(fixture.db.chamadas.filter(chamada => chamada.sql.includes("SET email_estado = 'PENDENTE'")).length, 0);
});

test('RF02 outbox: retries usam 30 s/2 min e terceira falha é definitiva', async () => {
    for (const [tentativaAnterior, atraso, estadoEsperado] of [
        [0, ATRASOS_RETRY_MS[0], 'PENDENTE'],
        [1, ATRASOS_RETRY_MS[1], 'PENDENTE'],
        [2, null, 'FALHA']
    ]) {
        const fixture = montarOutbox({
            candidatos: [{ id: 1, usuario_id: 71, nonce: Buffer.alloc(32, 0x52), tentativas: tentativaAnterior }],
            resultadoEmail: { enviado: false, motivo: 'falha_comunicacao' }
        });
        await fixture.outbox.processarLote();
        const final = fixture.finalizacoes.at(-1);
        assert.equal(final.estado, estadoEsperado);
        if (atraso !== null) {
            const proxima = new Date(`${final.parametros[0]}Z`.replace(' ', 'T')).getTime();
            assert.equal(proxima - fixture.clock.agora().getTime(), atraso);
            assert.equal(final.tentativaPredicado, tentativaAnterior + 1);
        } else {
            assert.equal(final.parametros[1], 'falha_comunicacao');
            assert.equal(fixture.finalizacoes.some(item => item.estado === 'PENDENTE'), false);
        }
    }
});

test('RF02 outbox: falhas definitivas não agendam retry', async () => {
    for (const motivo of ['sem_chave', 'sem_remetente', 'parametros_invalidos', 'override_nao_autorizado']) {
        const fixture = montarOutbox({ resultadoEmail: { enviado: false, motivo } });
        await fixture.outbox.processarLote();
        assert.equal(fixture.finalizacoes.at(-1).estado, 'FALHA', motivo);
        assert.equal(fixture.finalizacoes.at(-1).parametros[1], motivo);
        assert.equal(fixture.finalizacoes.some(item => item.estado === 'PENDENTE'), false);
    }
});

test('RF02 outbox: exceção/provider raw vira falha taxonômica sem dados sensíveis em logs', async () => {
    const bruto = `provider raw ${EMAIL} ${IP} ${SEGREDO}`;
    const fixture = montarOutbox({ resultadoEmail: new Error(bruto) });
    await fixture.outbox.processarLote();
    assert.equal(fixture.finalizacoes.at(-1).estado, 'PENDENTE');
    assert.equal(fixture.finalizacoes.at(-1).parametros[1], 'falha_comunicacao');
    assertSemSensiveis(fixture.logger.texto(), [EMAIL, IP, SEGREDO, bruto, fixture.urls[0]], 'logs de outbox');
});

test('RF02 outbox: registro que expira entre claim e processamento não envia', async () => {
    const fixture = montarOutbox({ semRegistro: true });
    await fixture.outbox.processarLote();
    assert.equal(fixture.envios.length, 0);
    assert.equal(fixture.finalizacoes.length, 0);
});

test('RF02 outbox: token e idempotency key sobrevivem a nova instância/reinício', async () => {
    const nonce = Buffer.alloc(32, 0x58);
    const primeiro = montarOutbox({ nonce });
    const segundo = montarOutbox({ nonce });
    await primeiro.outbox.processarLote();
    await segundo.outbox.processarLote();
    assert.equal(primeiro.urls[0], segundo.urls[0]);
    assert.equal(primeiro.envios[0][3], segundo.envios[0][3]);
    assert.ok(primeiro.envios[0][3].startsWith('rf02/'));
});

test('RF02 config: override em produção é fail-closed antes de banco/provider', async () => {
    const fixture = montarOutbox({ env: { NODE_ENV: 'production', RESEND_OVERRIDE_EMAIL: EMAIL } });
    const resultado = await fixture.outbox.processarLote();
    assert.deepEqual(resultado, { processados: 0 });
    assert.equal(fixture.db.chamadas.length, 0);
    assert.equal(fixture.envios.length, 0);
    assertSemSensiveis(fixture.logger.texto(), [EMAIL, SEGREDO], 'override de produção');
});

test('RF02 config: FRONTEND_URL inválida, com credenciais ou insegura em produção falha fechado', () => {
    const invalidas = [undefined, '', 'não é url', 'ftp://frontend.example.invalid', 'https://user@frontend.example.invalid'];
    for (const FRONTEND_URL of invalidas) {
        const service = servicoRecuperacao({}, criarClockFake(), { env: { FRONTEND_URL } });
        assert.throws(() => service.validarConfiguracaoGlobal(), erro => erro.codigo === 'RF02_CONFIG');
    }
    const httpProducao = servicoRecuperacao({}, criarClockFake(), {
        env: { NODE_ENV: 'production', FRONTEND_URL: 'http://frontend.example.invalid' }
    });
    assert.throws(() => httpProducao.validarConfiguracaoGlobal(), erro => erro.codigo === 'RF02_CONFIG');
    const httpsProducao = servicoRecuperacao({}, criarClockFake(), {
        env: { NODE_ENV: 'production', FRONTEND_URL: FRONTEND }
    });
    assert.equal(httpsProducao.validarConfiguracaoGlobal(), true);
});

test('RF02 cleanup: terminaliza órfãos, apaga somente terminal com 24 h e limpa buckets', async () => {
    let bucketsLimpos = 0;
    const fixture = montarOutbox({
        rateLimitService: { limparExpirados: async () => { bucketsLimpos += 1; } }
    });
    await fixture.outbox.limpar();
    assert.equal(fixture.deletes.length, 1);
    assert.match(fixture.deletes[0].sql, /email_estado IN \('ACEITA', 'DESCARTADA', 'FALHA'\) AND atualizado_em < \?/);
    const limite = new Date(`${fixture.deletes[0].parametros[0]}Z`.replace(' ', 'T')).getTime();
    assert.equal(fixture.clock.agora().getTime() - limite, 24 * 60 * 60 * 1000);
    assert.equal(bucketsLimpos, 1);
    const orfaos = fixture.db.chamadas.filter(chamada => chamada.sql.startsWith('UPDATE rf02_recuperacao_senha')).slice(0, 3);
    assert.equal(orfaos.length, 3);
    assert.match(orfaos[0].sql, /PROCESSANDO.*processando_ate <= \?.*tentativas >= 3/);
    assert.match(orfaos[1].sql, /PENDENTE.*tentativas >= 3/);
    assert.match(orfaos[2].sql, /PENDENTE', 'PROCESSANDO'.*expira_em <= \?/);
});

test('RF02 review-3: lease é renovado/revalidado para chamadas do lote e finalização usa lease vigente', async () => {
    const nonce1 = Buffer.alloc(32, 0x61);
    const nonce2 = Buffer.alloc(32, 0x62);
    const fixture = montarOutbox({
        candidatos: [
            { id: 1, usuario_id: 71, nonce: nonce1, tentativas: 0 },
            { id: 2, usuario_id: 71, nonce: nonce2, tentativas: 0 }
        ],
        exigirLeaseVigente: true,
        aoEnviar(args, { clock, leases }) {
            const id = args[3] === `rf02/${nonce1.toString('hex')}` ? 1 : 2;
            const lease = leases.get(id);
            const leaseMs = new Date(`${lease}Z`.replace(' ', 'T')).getTime();
            assert.ok(leaseMs > clock.agora().getTime(), 'provider chamado com lease expirado');
            if (id === 1) clock.avancar(31000);
            return { enviado: true };
        }
    });
    await fixture.outbox.processarLote();
    assert.equal(fixture.envios.length, 2);
    const aceitas = fixture.finalizacoes.filter(item => item.estado === 'ACEITA' && item.afetadas === 1);
    assert.equal(aceitas.length, 2, 'cada envio deve finalizar no lease vigente e não no lease expirado');
    for (const final of aceitas) assert.equal(final.leasePredicado, final.leaseVigente);
});

test('RF02 review-3 concorrência: dois workers não reivindicam nem enviam a mesma tentativa', async () => {
    const fixture = montarOutbox({
        candidatos: [
            { id: 1, usuario_id: 71, nonce: Buffer.alloc(32, 0x63), tentativas: 0 },
            { id: 2, usuario_id: 71, nonce: Buffer.alloc(32, 0x64), tentativas: 0 }
        ]
    });
    const resultados = await Promise.all([fixture.outbox.processarLote(), fixture.outbox.processarLote()]);
    assert.equal(resultados.reduce((total, item) => total + item.processados, 0), 2);
    assert.equal(fixture.envios.length, 2);
    assert.equal(new Set(fixture.envios.map(args => args[3])).size, 2);
    assert.equal(fixture.finalizacoes.filter(item => item.estado === 'ACEITA' && item.afetadas === 1).length, 2);
    assert.equal(fixture.renovacoes.length, 2);
    for (const renovacao of fixture.renovacoes) {
        assert.equal(renovacao.afetadas, 1);
        assert.match(renovacao.sql, /processando_ate = \?[\s\S]*processando_ate > \?/);
        assert.match(renovacao.sql, /consumido_em IS NULL AND invalidado_em IS NULL AND expira_em > \?/);
    }
});

function montarRateLimit(opcoes = {}) {
    const buckets = new Map();
    const db = criarDbFake(({ sql, parametros }) => {
        if (sql.startsWith('INSERT INTO rf02_rate_limit')) {
            const [escopo, hmac, inicio, expira] = parametros;
            const chave = `${escopo}|${hmac.toString('hex')}|${inicio}`;
            const atual = buckets.get(chave);
            if (atual) atual.contador += 1;
            else buckets.set(chave, { escopo, hmac, inicio, expira, contador: 1 });
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT contador FROM rf02_rate_limit')) {
            const [escopo, hmac, inicio] = parametros;
            const registro = buckets.get(`${escopo}|${hmac.toString('hex')}|${inicio}`);
            return [registro ? [{ contador: registro.contador }] : []];
        }
        if (sql.startsWith('DELETE FROM rf02_rate_limit')) {
            let removidos = 0;
            for (const [chave, registro] of buckets) {
                if (registro.expira <= parametros[0]) {
                    buckets.delete(chave);
                    removidos += 1;
                }
            }
            return [{ affectedRows: removidos }];
        }
        throw new Error('Query de rate-limit não configurada.');
    }, { serializarTransacoes: true });
    const clock = opcoes.clock || criarClockFake();
    const logger = criarLoggerFake();
    const service = criarRecuperacaoSenhaRateLimitService({ db, clock: clock.clock, secret: SEGREDO, logger });
    return { db, buckets, clock, logger, service };
}

test('RF02 rate-limit: IP 5/15 min, e-mail 3/1 h e confirmação 20/15 min', async () => {
    const ipFixture = montarRateLimit();
    for (let i = 1; i <= 5; i += 1) {
        const resultado = await ipFixture.service.limitarSolicitacao({ ip: IP, email: `user-${i}@example.invalid` });
        assert.equal(resultado.permitido, true, `IP ${i}`);
    }
    assert.equal((await ipFixture.service.limitarSolicitacao({ ip: IP, email: 'other@example.invalid' })).permitido, false);

    const emailFixture = montarRateLimit();
    for (let i = 0; i < 3; i += 1) {
        if (i) emailFixture.clock.avancar(60000);
        const resultado = await emailFixture.service.limitarSolicitacao({ ip: `198.51.100.${i + 1}`, email: EMAIL });
        assert.equal(resultado.permitido, true, `e-mail ${i + 1}`);
    }
    emailFixture.clock.avancar(60000);
    assert.equal((await emailFixture.service.limitarSolicitacao({ ip: '198.51.100.99', email: EMAIL })).permitido, false);

    const confirmacaoFixture = montarRateLimit();
    for (let i = 1; i <= 20; i += 1) {
        assert.equal((await confirmacaoFixture.service.limitarConfirmacao({ ip: IP })).permitido, true, `confirmação ${i}`);
    }
    assert.equal((await confirmacaoFixture.service.limitarConfirmacao({ ip: IP })).permitido, false);
});

test('RF02 rate-limit: fixed-window aceita fronteira e rejeita terceira chamada na nova janela', async () => {
    const fixture = montarRateLimit();
    assert.equal((await fixture.service.limitarSolicitacao({ ip: IP, email: EMAIL })).permitido, true);
    const segunda = await fixture.service.limitarSolicitacao({ ip: IP, email: EMAIL });
    assert.equal(segunda.permitido, false);
    assert.ok(segunda.retryAfter >= 1 && segunda.retryAfter <= 60);
    fixture.clock.avancar(60000);
    assert.equal((await fixture.service.limitarSolicitacao({ ip: IP, email: EMAIL })).permitido, true);
    assert.equal((await fixture.service.limitarSolicitacao({ ip: IP, email: EMAIL })).permitido, false);
});

test('RF02 rate-limit: dois workers compartilham contador e reinício não zera janela', { timeout: 3000 }, async () => {
    const fixture = montarRateLimit();
    const outroWorker = criarRecuperacaoSenhaRateLimitService({
        db: fixture.db, clock: fixture.clock.clock, secret: SEGREDO, logger: criarLoggerFake()
    });
    const resultados = await Promise.all([
        fixture.service.limitarSolicitacao({ ip: IP, email: EMAIL }),
        outroWorker.limitarSolicitacao({ ip: IP, email: EMAIL })
    ]);
    assert.deepEqual(resultados.map(resultado => resultado.permitido).sort(), [false, true]);
    const aposReinicio = criarRecuperacaoSenhaRateLimitService({
        db: fixture.db, clock: fixture.clock.clock, secret: SEGREDO, logger: criarLoggerFake()
    });
    assert.equal((await aposReinicio.limitarSolicitacao({ ip: IP, email: EMAIL })).permitido, false);
});

test('RF02 rate-limit: parâmetros contêm HMAC de 32 bytes, nunca IP/e-mail brutos; cleanup remove vencidos', async () => {
    const fixture = montarRateLimit();
    await fixture.service.limitarSolicitacao({ ip: IP, email: EMAIL.toUpperCase() });
    assert.equal(fixture.buckets.size, 3);
    for (const bucket of fixture.buckets.values()) {
        assert.equal(bucket.hmac.length, 32);
        assertSemSensiveis([bucket.escopo, bucket.hmac], [EMAIL, EMAIL.toUpperCase(), IP, SEGREDO], 'bucket');
    }
    assertSemSensiveis(fixture.db.chamadas.map(chamada => chamada.parametros), [EMAIL, EMAIL.toUpperCase(), IP, SEGREDO], 'queries rate-limit');
    fixture.clock.avancar(60 * 60 * 1000);
    await fixture.service.limparExpirados();
    assert.equal(fixture.buckets.size, 0);
});

test('RF02 rate-limit: falha do store vira 503; limite HTTP é 429 com Retry-After sanitizados', async t => {
    const logger = criarLoggerFake();
    const db = criarDbFake(() => { throw new Error(`store raw ${EMAIL} ${IP}`); });
    const service = criarRecuperacaoSenhaRateLimitService({ db, secret: SEGREDO, logger });
    await esperarCodigo(service.limitarSolicitacao({ ip: IP, email: EMAIL }), 'RF02_RATE_LIMIT_INFRA');
    assertSemSensiveis(logger.texto(), [EMAIL, IP], 'erro store');

    const { controller, cleanup } = carregarAuthIsolado(db);
    t.after(cleanup);
    const consoleFake = capturarConsoleFake();
    t.after(consoleFake.restaurar);
    const baseServices = { recuperacaoSenhaService: { validarConfiguracaoGlobal() {} } };
    const erro = await chamarHandler(controller.solicitarRecuperacaoSenha, criarRequestFake({
        body: { email: EMAIL }, ip: IP,
        services: { ...baseServices, recuperacaoSenhaRateLimitService: service }
    }));
    assert.equal(erro.statusCode, 503);
    const limitado = await chamarHandler(controller.solicitarRecuperacaoSenha, criarRequestFake({
        body: { email: EMAIL }, ip: IP,
        services: {
            ...baseServices,
            recuperacaoSenhaRateLimitService: { limitarSolicitacao: async () => ({ permitido: false, retryAfter: 37 }) }
        }
    }));
    assert.equal(limitado.statusCode, 429);
    assert.equal(limitado.headers['retry-after'], '37');
    assertSemSensiveis([erro, limitado, consoleFake.logger.texto()], [EMAIL, IP], 'resposta rate-limit');
});

function montarSessao({ senhaHash = 'hash-epoca-antiga', status = 'ATIVO', tipo = 'hospede' } = {}) {
    const estado = { senhaHash, status, tipo, nome: 'Hóspede RF02', telefone: '' };
    const db = criarDbFake(({ sql, parametros }) => {
        if (sql.startsWith('SELECT usu.Usu_Id, usu.Usu_Nome, usu.Usu_Status, usu.Usu_SenhaHash')) {
            assert.match(sql, /CASE WHEN EXISTS \(\s*SELECT 1 FROM pro_proprietario AS pro/);
            assert.deepEqual(parametros, [71]);
            return [[{
                Usu_Id: 71,
                Usu_Nome: estado.nome,
                Usu_Status: estado.status,
                Usu_SenhaHash: estado.senhaHash,
                Usu_Tipo: estado.tipo
            }]];
        }
        if (sql.startsWith('SELECT Usu_SenhaHash FROM usu_usuario WHERE Usu_Id = ? AND Usu_Status')) {
            return [estado.status === 'ATIVO' ? [{ Usu_SenhaHash: estado.senhaHash }] : []];
        }
        if (sql.startsWith('SELECT Usu_SenhaHash FROM usu_usuario WHERE Usu_Id')) {
            return [[{ Usu_SenhaHash: estado.senhaHash }]];
        }
        if (sql.startsWith('UPDATE usu_usuario SET Usu_Nome')) {
            estado.nome = parametros[0];
            estado.telefone = parametros[1];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE usu_usuario SET Usu_SenhaHash')) {
            const temCas = /WHERE Usu_Id = \?\s+AND Usu_SenhaHash = \?/.test(sql);
            if (temCas && parametros[2] !== estado.senhaHash) return [{ affectedRows: 0 }];
            estado.senhaHash = parametros[0];
            return [{ affectedRows: 1 }];
        }
        throw new Error('Query de sessão não configurada.');
    }, { serializarTransacoes: true });
    const logger = criarLoggerFake();
    const service = criarSessionService({ db, secret: SEGREDO_SESSAO, logger });
    const usuario = { id: 71, nome: estado.nome, tipo };
    return { db, estado, service, usuario, logger };
}

test('RF02 sessão: legado sem se é rejeitado; época divergente após reset e usuário inativo bloqueado', async () => {
    const fixture = montarSessao();
    const antigo = fixture.service.criarTokenSessao(fixture.usuario, 'hash-epoca-antiga').token;
    const legado = jwt.sign(fixture.usuario, SEGREDO_SESSAO, { expiresIn: '7d' });
    assert.equal((await fixture.service.validarTokenSessao(antigo)).ok, true);
    assert.equal((await fixture.service.validarTokenSessao(legado)).motivo, 'invalida');
    fixture.estado.senhaHash = 'hash-epoca-nova';
    assert.equal((await fixture.service.validarTokenSessao(antigo)).motivo, 'invalida');
    fixture.estado.senhaHash = 'hash-epoca-antiga';
    fixture.estado.status = 'BLOQUEADO';
    assert.equal((await fixture.service.validarTokenSessao(antigo)).motivo, 'usuario_inativo');
});

test('REV-03 sessão: vínculo de proprietário removido vira hospede e nome atual do banco prevalece', async t => {
    const fixture = montarSessao({ tipo: 'proprietario' });
    const { middleware, cleanup } = carregarAuthIsolado(fixture.db);
    t.after(cleanup);
    const token = fixture.service.criarTokenSessao({
        id: 71,
        nome: 'Nome obsoleto gravado no JWT',
        tipo: 'proprietario'
    }, fixture.estado.senhaHash).token;

    // Simula a remoção do vínculo e a atualização do nome depois da emissão do token.
    fixture.estado.tipo = 'hospede';
    fixture.estado.nome = 'Nome atual persistido';

    const req = criarRequestFake({
        cookies: { token },
        services: { sessionService: fixture.service }
    });
    const validado = await chamarMiddleware(middleware.verificarToken, req);
    assert.equal(validado.next, true);
    assert.deepEqual(req.usuario, {
        id: 71,
        nome: 'Nome atual persistido',
        tipo: 'hospede'
    });

    const negado = await chamarMiddleware(middleware.verificarProprietario, req);
    assert.equal(negado.res.statusCode, 403);
    assert.equal(negado.next, false);
});

test('RF02 sessão: /sessao e middleware compartilham válido/inválido/inativo/indisponível e DTO público', async t => {
    const db = criarDbFake(() => { throw new Error('DB inesperado.'); });
    const { controller, middleware, cleanup } = carregarAuthIsolado(db);
    t.after(cleanup);
    for (const [resultado, statusSessao, statusMiddleware] of [
        [{ ok: true, usuario: { id: 71, nome: 'QA', tipo: 'hospede' } }, 200, 200],
        [{ ok: false, motivo: 'invalida' }, 200, 401],
        [{ ok: false, motivo: 'usuario_inativo' }, 200, 403],
        [{ ok: false, motivo: 'indisponivel' }, 503, 503]
    ]) {
        let chamadas = 0;
        const sessionService = { validarTokenSessao: async () => { chamadas += 1; return resultado; } };
        const services = { sessionService };
        const sessao = await chamarHandler(controller.sessao, criarRequestFake({ cookies: { token: 'jwt-sintetico' }, services }));
        const protegido = await chamarMiddleware(middleware.verificarToken, criarRequestFake({ cookies: { token: 'jwt-sintetico' }, services }));
        assert.equal(sessao.statusCode, statusSessao);
        assert.equal(protegido.res.statusCode, statusMiddleware);
        assert.equal(protegido.next, resultado.ok);
        assert.equal(chamadas, 2);
        if (resultado.ok) assert.deepEqual(Object.keys(sessao.body.usuario).sort(), ['id', 'nome', 'tipo']);
        else if (resultado.motivo === 'invalida') assert.deepEqual(sessao.body, { usuario: null, expirado: true });
        else if (resultado.motivo === 'usuario_inativo') {
            assert.deepEqual(sessao.body, { usuario: null, expirado: true });
            assert.deepEqual(protegido.res.cookiesLimpos, [
                { nome: 'token', opcoes: opcoesCookieSessao() }
            ]);
        }
    }
});

test('RF02 sessão: erro de DB gera 503 em /sessao e middleware sem vazar token/hash', async t => {
    const emissor = montarSessao();
    const token = emissor.service.criarTokenSessao(emissor.usuario, emissor.estado.senhaHash).token;
    const logger = criarLoggerFake();
    const db = criarDbFake(() => { throw new Error('persistência indisponível'); });
    const sessionService = criarSessionService({ db, secret: SEGREDO_SESSAO, logger });
    assert.deepEqual(
        await sessionService.validarTokenSessao(token),
        { ok: false, motivo: 'indisponivel' }
    );
    const { controller, middleware, cleanup } = carregarAuthIsolado(db);
    t.after(cleanup);
    const req = () => criarRequestFake({ cookies: { token }, services: { sessionService } });
    const sessao = await chamarHandler(controller.sessao, req());
    const protegido = await chamarMiddleware(middleware.verificarToken, req());
    assert.equal(sessao.statusCode, 503);
    assert.equal(protegido.res.statusCode, 503);
    assert.equal(protegido.next, false);
    assertSemSensiveis([sessao, protegido.res, logger.texto()], [token, emissor.estado.senhaHash, SEGREDO_SESSAO], 'erro de sessão');
});

test('RF02 perfil: atualização não reemite JWT nem muda época; DTO permanece sem se/iat/exp', async t => {
    const fixture = montarSessao();
    const { controller, cleanup } = carregarAuthIsolado(fixture.db);
    t.after(cleanup);
    const tokenAnterior = fixture.service.criarTokenSessao(fixture.usuario, fixture.estado.senhaHash).token;
    const hashAnterior = fixture.estado.senhaHash;
    const req = criarRequestFake({
        body: { nome: 'Nome Atualizado', telefone: '(12) 99999-0000' },
        services: { sessionService: fixture.service }
    });
    req.usuario = fixture.usuario;
    const res = await chamarHandler(controller.atualizarPerfil, req);
    assert.equal(res.statusCode, 200);
    assert.equal(res.cookies.length, 0);
    assert.equal(fixture.estado.senhaHash, hashAnterior);
    assert.deepEqual(Object.keys(res.body.usuario).filter(chave => ['se', 'iat', 'exp'].includes(chave)), []);
    assert.equal(res.body.usuario.nome, 'Nome Atualizado');
    const validada = await fixture.service.validarTokenSessao(tokenAnterior);
    assert.equal(validada.ok, true);
});

test('RF02 alteração senha: fluxo estável emite cookie na época nova e invalida cookie antigo', async t => {
    const hashAntigo = await bcrypt.hash(SENHA_ANTIGA, 4);
    const fixture = montarSessao({ senhaHash: hashAntigo });
    const { controller, cleanup } = carregarAuthIsolado(fixture.db);
    t.after(cleanup);
    const antigo = fixture.service.criarTokenSessao(fixture.usuario, hashAntigo).token;
    const req = criarRequestFake({
        body: { senhaAtual: SENHA_ANTIGA, novaSenha: SENHA_NOVA },
        services: { sessionService: fixture.service }
    });
    req.usuario = fixture.usuario;
    const res = await chamarHandler(controller.alterarSenha, req);
    assert.equal(res.statusCode, 200);
    assert.equal(res.cookies.length, 1);
    assert.equal(bcrypt.getRounds(fixture.estado.senhaHash), 10);
    assert.equal((await fixture.service.validarTokenSessao(antigo)).ok, false);
    assert.equal((await fixture.service.validarTokenSessao(res.cookies[0].valor)).ok, true);
});

test('RF02 review-1: perfil validado antes do reset não ressuscita sessão com época nova', async t => {
    const fixture = montarSessao();
    const { controller, cleanup } = carregarAuthIsolado(fixture.db);
    t.after(cleanup);
    const antigo = fixture.service.criarTokenSessao(fixture.usuario, fixture.estado.senhaHash).token;
    const validado = await fixture.service.validarTokenSessao(antigo);
    assert.equal(validado.ok, true);

    // Interleaving: o middleware validou; o reset troca a época antes do handler concluir.
    fixture.estado.senhaHash = 'hash-epoca-pos-reset';
    const req = criarRequestFake({
        body: { nome: 'Nome Concorrente', telefone: '' },
        cookies: { token: antigo },
        services: { sessionService: fixture.service }
    });
    req.usuario = validado.usuario;
    const res = await chamarHandler(controller.atualizarPerfil, req);
    assert.equal(res.cookies.length, 0, 'cookie com época nova não pode ser reemitido após validação antiga');
    assert.equal((await fixture.service.validarTokenSessao(antigo)).ok, false);
});

test('RF02 review-2: alterarSenha concorrente usa CAS/affectedRows; somente um vence e reemite cookie', async t => {
    const hashAntigo = await bcrypt.hash(SENHA_ANTIGA, 4);
    const fixture = montarSessao({ senhaHash: hashAntigo });
    const { controller, cleanup } = carregarAuthIsolado(fixture.db);
    t.after(cleanup);
    const novaA = 'Qa#2026FluxoA';
    const novaB = 'Qa#2026FluxoB';
    const chamada = novaSenha => {
        const req = criarRequestFake({
            body: { senhaAtual: SENHA_ANTIGA, novaSenha },
            services: { sessionService: fixture.service }
        });
        req.usuario = fixture.usuario;
        return chamarHandler(controller.alterarSenha, req);
    };
    const respostas = await Promise.all([chamada(novaA), chamada(novaB)]);
    const vencedoras = respostas.filter(res => res.statusCode === 200);
    const perdedoras = respostas.filter(res => res.statusCode !== 200);
    assert.equal(vencedoras.length, 1);
    assert.equal(perdedoras.length, 1);
    assert.equal(perdedoras[0].cookies.length, 0);
    assert.equal(vencedoras[0].cookies.length, 1);
    const updates = fixture.db.chamadas.filter(chamada => chamada.sql.startsWith('UPDATE usu_usuario SET Usu_SenhaHash'));
    assert.ok(updates.every(chamada => /WHERE Usu_Id = \?\s+AND Usu_SenhaHash = \?/.test(chamada.sql)), 'UPDATE deve comparar o hash lido');
    const hashFinal = fixture.estado.senhaHash;
    const resultados = await Promise.all([bcrypt.compare(novaA, hashFinal), bcrypt.compare(novaB, hashFinal)]);
    assert.deepEqual(resultados.filter(Boolean).length, 1);
});

test('RF02 review-4 HTTP: POLITICA_SENHA e TOKEN_INVALIDO são 400 com códigos distintos e sanitizados', async t => {
    const db = criarDbFake(() => { throw new Error('DB não deveria ser chamado.'); });
    const { controller, cleanup } = carregarAuthIsolado(db);
    t.after(cleanup);
    for (const codigo of ['POLITICA_SENHA', 'TOKEN_INVALIDO']) {
        const erro = new Error(`detalhe interno ${EMAIL} ${SEGREDO}`);
        erro.codigo = codigo;
        erro.mensagemPublica = 'A senha deve conter pelo menos uma letra maiúscula.';
        const recuperacaoSenhaService = {
            validarConfiguracaoGlobal() {},
            async confirmar() { throw erro; }
        };
        const res = await chamarHandler(controller.confirmarRecuperacaoSenha, criarRequestFake({
            body: { token: 'token-sintetico', novaSenha: SENHA_NOVA },
            services: {
                recuperacaoSenhaService,
                recuperacaoSenhaRateLimitService: {
                    limitarConfirmacao: async () => ({ permitido: true, retryAfter: 0 })
                }
            }
        }));
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, codigo);
        assert.equal(res.headers['cache-control'], 'no-store');
        assertSemSensiveis(res, [EMAIL, SEGREDO, SENHA_NOVA, 'detalhe interno'], `HTTP ${codigo}`);
        if (codigo === 'POLITICA_SENHA') assert.match(res.body.error, /maiúscula/);
        else assert.equal(res.body.error, 'Link de recuperação inválido ou expirado.');
    }
});

test('RF02 review-4 frontend estático: política preserva senha/token; token inválido limpa; 401/403/404 são genéricos', () => {
    const caminho = path.resolve(__dirname, '../../src/pages/RecuperarSenha.jsx');
    const fonte = fs.readFileSync(caminho, 'utf8');
    const inicio = fonte.indexOf('const handleRedefinir = async event => {');
    const fim = fonte.indexOf('const solicitarNovoLink =', inicio);
    assert.ok(inicio >= 0 && fim > inicio, 'handler de redefinição localizado');
    const handler = fonte.slice(inicio, fim);
    const inicioPolitica = handler.indexOf("resultado.status === 400 && resultado.dados?.code === 'POLITICA_SENHA'");
    const inicioToken = handler.indexOf("resultado.status === 400 && resultado.dados?.code === 'TOKEN_INVALIDO'");
    const inicioLimite = handler.indexOf('resultado.status === 429', inicioToken);
    assert.ok(inicioPolitica >= 0 && inicioToken > inicioPolitica && inicioLimite > inicioToken);
    const politica = handler.slice(inicioPolitica, inicioToken);
    const tokenInvalido = handler.slice(inicioToken, inicioLimite);

    assert.match(politica, /setErro\(/);
    assert.doesNotMatch(politica, /setToken\(|setDados\(|setModo\('tokenInvalido'\)/);
    assert.match(tokenInvalido, /setToken\(''\)/);
    assert.match(tokenInvalido, /setDados\(anterior => \(\{ \.\.\.anterior, novaSenha: '', confirmar: '' \}\)\)/);
    assert.match(tokenInvalido, /setModo\('tokenInvalido'\)/);
    assert.doesNotMatch(fonte, /STATUS_TOKEN_INVALIDO/);
    assert.doesNotMatch(handler, /resultado\.status === (?:401|403|404)/);
    assert.doesNotMatch(handler, /\[(?:401|403|404)[^\]]*\].*includes/);
});

function afirmarDescarteOtimistaSeguro(descarte) {
    assert.match(descarte.sql, /invalidado_em = COALESCE\(invalidado_em, \?\)/);
    assert.doesNotMatch(descarte.sql, /SET consumido_em|consumido_em = \?/);
    assert.match(descarte.sql, /WHERE id = \? AND nonce = \? AND tentativas = \? AND processando_ate = \?/);
    assert.match(descarte.sql, /email_estado = 'PROCESSANDO'/);
    assert.equal(descarte.noncePredicado.length, 32);
    assert.equal(descarte.tentativaPredicado, 1);
    assert.equal(descarte.leasePredicado, descarte.leaseVigente);
}

test('RF02-SEC-01: toda transição DESCARTADA do outbox invalida via COALESCE sem consumir token', () => {
    const fonte = fs.readFileSync(require.resolve('../services/recuperacaoSenhaOutboxService'), 'utf8');
    const consultas = [...fonte.matchAll(/`([^`]+)`/g)]
        .map(item => item[1].replace(/\s+/g, ' ').trim())
        .filter(sql => sql.includes("SET email_estado = 'DESCARTADA'"));
    assert.ok(consultas.length >= 2, 'descarte de processamento e expiração localizados');
    for (const sql of consultas) {
        assert.match(sql, /invalidado_em = COALESCE\(invalidado_em, \?\)/, sql);
        assert.doesNotMatch(sql, /SET consumido_em|consumido_em = \?/);
    }
    const otimista = consultas.find(sql => sql.includes('WHERE id = ? AND nonce = ?'));
    assert.ok(otimista, 'descarte otimista localizado');
    assert.match(otimista, /WHERE id = \? AND nonce = \? AND tentativas = \? AND processando_ate = \?/);
    assert.match(otimista, /email_estado = 'PROCESSANDO'/);
});

test('RF02-SEC-01: usuario NULL e inativo descartam com invalidação otimista e sem provider', async () => {
    for (const cenario of ['usuario_null', 'inativo']) {
        const fixture = montarOutbox({
            candidatos: [{
                id: 1,
                usuario_id: cenario === 'usuario_null' ? null : 71,
                nonce: Buffer.alloc(32, 0x71),
                tentativas: 0
            }],
            registros: cenario === 'inativo' ? {
                1: { Usu_Nome: 'Hóspede RF02', Usu_Email: EMAIL, Usu_Status: 'INATIVO' }
            } : undefined
        });
        await fixture.outbox.processarLote();
        assert.equal(fixture.envios.length, 0, cenario);
        const descartesProcessamento = fixture.descartes.filter(item => item.origem === 'processamento');
        assert.equal(descartesProcessamento.length, 1, cenario);
        assert.equal(descartesProcessamento[0].afetadas, 1, cenario);
        afirmarDescarteOtimistaSeguro(descartesProcessamento[0]);
    }
});

test('RF02-SEC-01: expiração terminaliza com COALESCE e token expirado não confirma com conta ATIVA', async () => {
    const fixtureOutbox = montarOutbox();
    await fixtureOutbox.outbox.recuperarOrfaos();
    const expirado = fixtureOutbox.descartes.find(item => item.origem === 'limpeza');
    assert.ok(expirado);
    assert.match(expirado.sql, /invalidado_em = COALESCE\(invalidado_em, \?\)/);
    assert.doesNotMatch(expirado.sql, /SET consumido_em|consumido_em = \?/);
    assert.match(expirado.sql, /email_estado IN \('PENDENTE', 'PROCESSANDO'\) AND expira_em <= \?/);

    const clock = criarClockFake();
    const fixture = montarConfirmacao({
        clock,
        invalidadoInicial: true,
        expiraEm: new Date(clock.agora().getTime() - 1)
    });
    await esperarCodigo(fixture.service.confirmar({ token: fixture.token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.equal(fixture.estado.atualizacoesSenha, 0);
    assert.equal(fixture.estado.consumido, false);
});

test('RF02-SEC-01: reativação antes do antigo expira_em não reabilita token descartado ou usuario NULL', async () => {
    const inativo = montarConfirmacao({ invalidadoInicial: true, status: 'ATIVO' });
    await esperarCodigo(inativo.service.confirmar({ token: inativo.token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.ok(inativo.estado.expiraEm > inativo.clock.agora());
    assert.equal(inativo.estado.atualizacoesSenha, 0);
    assert.equal(inativo.estado.consumido, false);

    const nulo = montarConfirmacao({ preliminarNulo: true, status: 'ATIVO' });
    await esperarCodigo(nulo.service.confirmar({ token: nulo.token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.equal(nulo.estado.atualizacoesSenha, 0);
    assert.equal(nulo.db.conexoes.length, 0);
});

test('RF02-SEC-01: reset preserva consumido_em no token usado e invalida os demais antes do expira_em', async () => {
    const usado = montarConfirmacao();
    await usado.service.confirmar({ token: usado.token, novaSenha: SENHA_NOVA });
    assert.equal(usado.estado.consumido, true);
    assert.equal(usado.estado.invalidado, false, 'consumo não precisa ser reescrito como invalidação');
    await esperarCodigo(usado.service.confirmar({ token: usado.token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.equal(usado.estado.atualizacoesSenha, 1);

    const outro = montarConfirmacao({ invalidadoInicial: true, status: 'ATIVO' });
    await esperarCodigo(outro.service.confirmar({ token: outro.token, novaSenha: SENHA_NOVA }), 'TOKEN_INVALIDO');
    assert.ok(outro.estado.expiraEm > outro.clock.agora());
    assert.equal(outro.estado.atualizacoesSenha, 0);
    assert.equal(outro.estado.consumido, false);
});

test('RF02-SEC-01 concorrência simulada: reset ou perda de lease na revalidação impede provider', async () => {
    const fixture = montarOutbox({ renovacaoAfetada: 0 });
    await fixture.outbox.processarLote();
    assert.equal(fixture.renovacoes.length, 1);
    assert.equal(fixture.renovacoes[0].afetadas, 0);
    assert.equal(fixture.envios.length, 0);
    assert.equal(fixture.finalizacoes.length, 0);
    assert.match(fixture.renovacoes[0].sql, /WHERE id = \? AND nonce = \? AND tentativas = \? AND processando_ate = \?/);
    assert.match(fixture.renovacoes[0].sql, /consumido_em IS NULL AND invalidado_em IS NULL AND expira_em > \?/);
});
