'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EventEmitter } = require('node:events');

const {
    HOST_PERMITIDO,
    PORTA_PERMITIDA,
    USUARIO_PERMITIDO,
    BANCO_ORIGEM_PERMITIDO,
    ENV_FILE_BASENAME,
    validarCaminhoEnv,
    verificarArquivoEnv,
    validarConfiguracaoQA,
    carregarConfiguracaoEnv,
    aplicarEnvComSnapshot,
    capturarSnapshotAmbiente,
    restaurarSnapshotAmbiente,
    encerrarComTimeout,
    nomeTemporarioValido,
    podeDroparBanco,
    executarDropAutorizado,
    conectarComConfiguracaoValidada,
    montarOpcoesConexao,
    montarEnvAplicacao
} = require('./support/qa-config');
const { criarAmbienteMySQL } = require('./support/mysql-harness');

const BACKEND_DIR = path.resolve(__dirname, '..');
const SENHA_FICTICIA = 'nao-e-uma-credencial-real';

const CONFIG_VALIDA = Object.freeze({
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_SSL: 'false',
    DB_USER: 'recanto_qa',
    DB_PASSWORD: SENHA_FICTICIA,
    DB_NAME: 'recanto_camargo_dev'
});

function comAlteracao(alteracao) {
    return { ...CONFIG_VALIDA, ...alteracao };
}

function criarDiretorioTemporario(t) {
    const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-config-'));
    t.after(() => fs.rmSync(diretorio, { recursive: true, force: true }));
    return diretorio;
}

test('constantes permitidas refletem a política da Fase 1', () => {
    assert.equal(HOST_PERMITIDO, '127.0.0.1');
    assert.equal(PORTA_PERMITIDA, 3306);
    assert.equal(USUARIO_PERMITIDO, 'recanto_qa');
    assert.equal(BANCO_ORIGEM_PERMITIDO, 'recanto_camargo_dev');
});

test('aceita exatamente a configuração local autorizada', () => {
    const config = validarConfiguracaoQA(CONFIG_VALIDA);
    assert.deepEqual(config, {
        host: '127.0.0.1',
        port: 3306,
        ssl: false,
        user: 'recanto_qa',
        password: SENHA_FICTICIA,
        database: 'recanto_camargo_dev'
    });
    assert.equal(Object.isFrozen(config), true);
});

test('assume 3306 e SSL desativado quando DB_PORT e DB_SSL estão ausentes', () => {
    const config = validarConfiguracaoQA({
        DB_HOST: '127.0.0.1',
        DB_USER: 'recanto_qa',
        DB_PASSWORD: SENHA_FICTICIA,
        DB_NAME: 'recanto_camargo_dev'
    });
    assert.equal(config.port, 3306);
    assert.equal(config.ssl, false);
});

test('rejeita host remoto, hostname externo, IP público e localhost', () => {
    const hosts = [
        'aivencloud.com',
        'db.exemplo.com',
        '8.8.8.8',
        '192.168.0.10',
        'localhost',
        '::1',
        '0.0.0.0',
        '',
        undefined
    ];

    for (const host of hosts) {
        assert.throws(
            () => validarConfiguracaoQA(comAlteracao({ DB_HOST: host })),
            /DB_HOST/,
            `host deveria ser rejeitado: ${String(host)}`
        );
    }
});

test('rejeita porta diferente de 3306, hexadecimal, notação científica e sinal', () => {
    for (const porta of ['3307', '3306.5', '3306.0', '0', 'abc', '25060', '0xCEA', '3.306e3', '3306e0', '+3306', '03306', true, {}]) {
        assert.throws(
            () => validarConfiguracaoQA(comAlteracao({ DB_PORT: porta })),
            /DB_PORT/,
            `porta deveria ser rejeitada: ${String(porta)}`
        );
    }
});

test('rejeita SSL ativo ou representações não autorizadas incluindo 0', () => {
    for (const ssl of ['true', true, '1', '0', 0, 'yes', 'no', 'required', ['false'], {}]) {
        assert.throws(
            () => validarConfiguracaoQA(comAlteracao({ DB_SSL: ssl })),
            /DB_SSL/,
            `SSL deveria ser rejeitado: ${String(ssl)}`
        );
    }
});

test('aceita DB_SSL explicitamente falso ou vazio', () => {
    for (const ssl of ['false', 'FALSE', false, '', undefined, null]) {
        const config = validarConfiguracaoQA(comAlteracao({ DB_SSL: ssl }));
        assert.equal(config.ssl, false);
    }
});

test('rejeita root e qualquer usuário diferente de recanto_qa', () => {
    for (const usuario of ['root', 'recanto_dev', 'RECANTO_QA', '', undefined]) {
        assert.throws(
            () => validarConfiguracaoQA(comAlteracao({ DB_USER: usuario })),
            /DB_USER/,
            `usuário deveria ser rejeitado: ${String(usuario)}`
        );
    }
});

test('rejeita banco histórico, temporário ou não autorizado como origem', () => {
    const bancos = [
        'recanto_camargo',
        'recanto_camargo_teste',
        'recanto_camargo_teste_p3',
        'recanto_camargo_qa_sprint3_20261023_023628',
        'recanto_notif_qa_0123456789ab',
        'outro_banco',
        '',
        undefined
    ];

    for (const banco of bancos) {
        assert.throws(
            () => validarConfiguracaoQA(comAlteracao({ DB_NAME: banco })),
            /DB_NAME/,
            `banco deveria ser rejeitado: ${String(banco)}`
        );
    }
});

test('rejeita senha ausente ou composta somente por espaços', () => {
    for (const senha of ['', '   ', '\t\n ', undefined, null, 123]) {
        assert.throws(
            () => validarConfiguracaoQA(comAlteracao({ DB_PASSWORD: senha })),
            /DB_PASSWORD/
        );
    }
});

test('validarConfiguracaoQA rejeita null, undefined, array e tipos inválidos', () => {
    for (const entrada of [null, undefined, [], ['127.0.0.1'], 'config', 123]) {
        assert.throws(
            () => validarConfiguracaoQA(entrada),
            /Configuração de QA ausente/
        );
    }
});

test('mensagens de erro não expõem a senha', () => {
    assert.throws(
        () => validarConfiguracaoQA(comAlteracao({ DB_HOST: 'aivencloud.com' })),
        erro => {
            assert.match(erro.message, /DB_HOST/);
            assert.equal(erro.message.includes(SENHA_FICTICIA), false);
            return true;
        }
    );
});

test('QA_ENV_FILE ausente ou vazio falha sem fallback', () => {
    for (const valor of ['', '   ', undefined, null]) {
        assert.throws(
            () => validarCaminhoEnv(valor, BACKEND_DIR),
            /QA_ENV_FILE não definido/
        );
    }
});

test('QA_ENV_FILE relativo é resolvido dentro de backend', () => {
    assert.equal(
        validarCaminhoEnv('.env.qa', BACKEND_DIR, BACKEND_DIR),
        path.join(BACKEND_DIR, '.env.qa')
    );
    assert.equal(
        validarCaminhoEnv(path.join(BACKEND_DIR, '.env.qa'), BACKEND_DIR),
        path.join(BACKEND_DIR, '.env.qa')
    );
    assert.equal(
        validarCaminhoEnv(path.join('backend', '.env.qa'), BACKEND_DIR, path.dirname(BACKEND_DIR)),
        path.join(BACKEND_DIR, '.env.qa')
    );
});

test('QA_ENV_FILE fora de backend ou apontando para o diretório é rejeitado', () => {
    const fora = path.join(BACKEND_DIR, '..', '.env.qa');
    assert.throws(() => validarCaminhoEnv(fora, BACKEND_DIR), /dentro de backend/);
    assert.throws(() => validarCaminhoEnv(BACKEND_DIR, BACKEND_DIR), /dentro de backend/);
});

test('QA_ENV_FILE inexistente ou diretório falha na verificação de arquivo', t => {
    const diretorio = criarDiretorioTemporario(t);
    const inexistente = path.join(diretorio, 'nao-existe.env');
    assert.throws(() => verificarArquivoEnv(inexistente, diretorio), /não existe/);
    assert.throws(() => verificarArquivoEnv(diretorio, diretorio), /arquivo regular/);
});

test('QA_ENV_FILE existente dentro de backend é aceito', t => {
    const diretorio = criarDiretorioTemporario(t);
    const arquivo = path.join(diretorio, '.env.qa');
    fs.writeFileSync(arquivo, 'DB_HOST=127.0.0.1\n', 'utf8');

    const resolvido = verificarArquivoEnv(arquivo, diretorio);
    assert.equal(resolvido, fs.realpathSync(arquivo));
});

test('QA_ENV_FILE que resolve para fora de backend é rejeitado', t => {
    const backend = criarDiretorioTemporario(t);
    const externo = criarDiretorioTemporario(t);
    const arquivo = path.join(externo, '.env.qa');
    fs.writeFileSync(arquivo, 'DB_HOST=127.0.0.1\n', 'utf8');

    assert.throws(() => verificarArquivoEnv(arquivo, backend), /fora de backend/);
});

test('nome temporário exige prefixo e 12 hexadecimais minúsculos', () => {
    assert.equal(nomeTemporarioValido('recanto_notif_qa_0123456789ab'), true);

    const invalidos = [
        'recanto_notif_qa_0123456789a',
        'recanto_notif_qa_0123456789abc',
        'recanto_notif_qa_0123456789AB',
        'recanto_notif_qa_0123456789ag',
        'recanto_notif_qa_',
        'recanto_notif_qa_0123456789ab; DROP DATABASE x',
        '',
        null
    ];

    for (const nome of invalidos) {
        assert.equal(nomeTemporarioValido(nome), false, `nome deveria ser inválido: ${String(nome)}`);
    }
});

test('DROP só é autorizado com nome, flag, origem e token válidos', () => {
    const token = 'a'.repeat(32);
    const base = {
        nome: 'recanto_notif_qa_0123456789ab',
        origem: 'recanto_camargo_dev',
        criado: true,
        token,
        tokenEsperado: token
    };

    assert.equal(podeDroparBanco(base), true);
    assert.equal(podeDroparBanco({ ...base, criado: false }), false);
    assert.equal(podeDroparBanco({ ...base, nome: 'recanto_camargo_dev' }), false);
    assert.equal(podeDroparBanco({ ...base, nome: 'recanto_notif_qa_0123456789AB' }), false);
    assert.equal(podeDroparBanco({ ...base, origem: base.nome }), false);
    assert.equal(podeDroparBanco({ ...base, token: undefined }), false);
    assert.equal(podeDroparBanco({ ...base, tokenEsperado: undefined }), false);
    assert.equal(podeDroparBanco({ ...base, token: 'b'.repeat(32) }), false);
    assert.equal(podeDroparBanco({ ...base, token: 'a'.repeat(31) }), false);
    assert.equal(podeDroparBanco(), false);
});

function criarAdminFalso(tokenRetornado) {
    const chamadas = [];
    return {
        chamadas,
        async query(sql, parametros) {
            chamadas.push({ sql, parametros });
            if (sql.startsWith('SELECT token')) {
                return [tokenRetornado === undefined ? [] : [{ token: tokenRetornado }]];
            }
            return [[]];
        }
    };
}

const ESCAPE_ID_FALSO = identificador => `\`${String(identificador).replace(/`/g, '``')}\``;

test('cleanup não consulta nem dropa quando o banco não foi criado', async () => {
    const admin = criarAdminFalso('a'.repeat(32));
    const resultado = await executarDropAutorizado({
        admin,
        escapeId: ESCAPE_ID_FALSO,
        nome: 'recanto_notif_qa_0123456789ab',
        origem: 'recanto_camargo_dev',
        criado: false,
        tokenEsperado: 'a'.repeat(32)
    });

    assert.equal(resultado, false);
    assert.equal(admin.chamadas.length, 0);
});

test('cleanup recusa nome inválido sem executar nenhuma query', async () => {
    const admin = criarAdminFalso('a'.repeat(32));

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_camargo_dev',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: 'a'.repeat(32)
        }),
        /nome de banco temporário inválido/
    );

    assert.equal(admin.chamadas.length, 0);
});

test('cleanup exige token de propriedade antes de consultar o banco', async () => {
    const admin = criarAdminFalso('a'.repeat(32));

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_notif_qa_0123456789ab',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: undefined
        }),
        /token de propriedade ausente/
    );

    assert.equal(admin.chamadas.length, 0);
});

test('cleanup não executa DROP quando o marcador não existe', async () => {
    const admin = criarAdminFalso(undefined);

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_notif_qa_0123456789ab',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: 'a'.repeat(32)
        }),
        /propriedade do banco não comprovada/
    );

    assert.equal(admin.chamadas.length, 1);
    assert.match(admin.chamadas[0].sql, /^SELECT token FROM/);
});

test('cleanup não executa DROP quando o token não confere', async () => {
    const admin = criarAdminFalso('b'.repeat(32));

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_notif_qa_0123456789ab',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: 'a'.repeat(32)
        }),
        /propriedade do banco não comprovada/
    );

    assert.equal(admin.chamadas.length, 1);
    assert.equal(admin.chamadas.some(c => c.sql.startsWith('DROP DATABASE')), false);
});

test('cleanup executa DROP somente após confirmar o token do marcador', async () => {
    const token = 'a'.repeat(32);
    const admin = criarAdminFalso(token);

    const resultado = await executarDropAutorizado({
        admin,
        escapeId: ESCAPE_ID_FALSO,
        nome: 'recanto_notif_qa_0123456789ab',
        origem: 'recanto_camargo_dev',
        criado: true,
        tokenEsperado: token
    });

    assert.equal(resultado, true);
    assert.equal(admin.chamadas.length, 2);
    assert.match(
        admin.chamadas[0].sql,
        /^SELECT token FROM `recanto_notif_qa_0123456789ab`\.`__qa_guard`/
    );
    assert.deepEqual(admin.chamadas[0].parametros, [token]);
    assert.equal(
        admin.chamadas[1].sql,
        'DROP DATABASE `recanto_notif_qa_0123456789ab`'
    );
});

test('cleanup exige função de escape de identificadores', async () => {
    const admin = criarAdminFalso('a'.repeat(32));

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            nome: 'recanto_notif_qa_0123456789ab',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: 'a'.repeat(32)
        }),
        /escapeId ausente/
    );

    assert.equal(admin.chamadas.length, 0);
});

test('configuração remota é recusada antes de chamar a função de conexão', async () => {
    let chamadas = 0;
    const conectar = () => {
        chamadas += 1;
        throw new Error('createConnection não deveria ter sido chamado');
    };

    await assert.rejects(
        () => conectarComConfiguracaoValidada(
            comAlteracao({ DB_HOST: 'aivencloud.com' }),
            conectar
        ),
        /DB_HOST/
    );

    assert.equal(chamadas, 0);
});

test('configuração válida chega normalizada à função de conexão', async () => {
    let recebida;
    const resultado = await conectarComConfiguracaoValidada(CONFIG_VALIDA, config => {
        recebida = config;
        return 'conectado';
    });

    assert.equal(resultado, 'conectado');
    assert.equal(recebida.host, '127.0.0.1');
    assert.equal(recebida.port, 3306);
    assert.equal(recebida.ssl, false);
    assert.equal(recebida.user, 'recanto_qa');
    assert.equal(recebida.database, 'recanto_camargo_dev');
});

test('conectarComConfiguracaoValidada exige uma função de conexão', async () => {
    await assert.rejects(
        () => conectarComConfiguracaoValidada(CONFIG_VALIDA, null),
        /Função de conexão ausente/
    );
});

test('opções de conexão usam TCP local, timeout e sem múltiplas instruções', () => {
    const config = validarConfiguracaoQA(CONFIG_VALIDA);
    assert.deepEqual(montarOpcoesConexao(config), {
        host: '127.0.0.1',
        port: 3306,
        user: 'recanto_qa',
        password: SENHA_FICTICIA,
        ssl: false,
        connectTimeout: 5000,
        multipleStatements: false
    });
});

test('ambiente da API espelha exatamente o destino validado', () => {
    const config = validarConfiguracaoQA(CONFIG_VALIDA);
    const nome = 'recanto_notif_qa_0123456789ab';
    const env = montarEnvAplicacao(config, nome, 'jwt-ficticio-de-teste');

    assert.deepEqual(env, {
        DB_HOST: '127.0.0.1',
        DB_PORT: '3306',
        DB_SSL: 'false',
        DB_USER: 'recanto_qa',
        DB_PASSWORD: SENHA_FICTICIA,
        DB_NAME: nome,
        JWT_SECRET: 'jwt-ficticio-de-teste',
        RESEND_API_KEY: '',
        RESEND_FROM_EMAIL: '',
        NODE_ENV: 'test'
    });
    assert.equal(typeof env.DB_PORT, 'string');
    assert.equal(env.DB_SSL, 'false');
});

function parseEnvSimples(conteudo) {
    const out = {};
    for (const linha of String(conteudo).split(/\r?\n/)) {
        const limpa = linha.trim();
        if (!limpa || limpa.startsWith('#')) continue;
        const idx = limpa.indexOf('=');
        if (idx > 0) out[limpa.slice(0, idx).trim()] = limpa.slice(idx + 1).trim();
    }
    return out;
}

function criarEnvQaTemporario(t, conteudo) {
    const backendDir = criarDiretorioTemporario(t);
    const arquivo = path.join(backendDir, '.env.qa');
    fs.writeFileSync(arquivo, conteudo, 'utf8');
    return { backendDir, arquivo };
}

function criarDepsFalsasHarness(opcoes = {}) {
    const queries = [];
    let tokenGuardado;
    let bancoCriado;
    const estado = {
        adminEndChamado: false,
        adminDestroyChamado: false,
        poolEndChamado: false,
        dropExecutado: false,
        serverListenChamado: false
    };

    const admin = {
        async query(sql, parametros = []) {
            queries.push({ sql, parametros });
            if (opcoes.falharSelectMarcador && sql.startsWith('SELECT token FROM')) {
                throw new Error('Falha simulada ao consultar marcador');
            }
            if (sql.includes('information_schema.TABLES')) return [[]];
            if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [[]];
            if (sql.startsWith('CREATE DATABASE')) {
                const match = /`([^`]+)`/.exec(sql);
                bancoCriado = match ? match[1] : '';
                return [[]];
            }
            if (sql.includes('INSERT INTO') && sql.includes('__qa_guard')) {
                tokenGuardado = parametros[0];
                return [[]];
            }
            if (sql === 'SELECT DATABASE() AS nome') {
                return [[{ nome: bancoCriado }]];
            }
            if (sql.startsWith('SELECT token FROM')) {
                return [tokenGuardado ? [{ token: tokenGuardado }] : []];
            }
            if (sql.startsWith('DROP DATABASE')) {
                estado.dropExecutado = true;
                return [[]];
            }
            return [[]];
        },
        async end() {
            estado.adminEndChamado = true;
            if (opcoes.travarAdminEnd) return new Promise(() => {});
            if (opcoes.falharAdminEnd) throw new Error('Falha simulada ao encerrar conexão administrativa');
        },
        destroy() {
            estado.adminDestroyChamado = true;
        }
    };

    const pool = {
        async query(sql) {
            if (sql === 'SELECT DATABASE() AS nome') {
                return [[{ nome: process.env.DB_NAME }]];
            }
            return [[]];
        },
        async end() {
            estado.poolEndChamado = true;
            if (opcoes.travarPoolEnd) return new Promise(() => {});
            if (opcoes.falharPoolEnd) throw new Error('Falha simulada ao encerrar pool');
        }
    };

    const app = {
        listen() {
            estado.serverListenChamado = true;
            const emitter = new EventEmitter();
            emitter.address = () => ({ port: 45678 });
            emitter.close = cb => cb();
            emitter.closeAllConnections = () => {};
            process.nextTick(() => emitter.emit('listening'));
            return emitter;
        }
    };

    return {
        queries,
        estado,
        opcoesHarness: {
            parseEnv: parseEnvSimples,
            escapeId: ESCAPE_ID_FALSO,
            hashSenha: async () => 'hash-ficticio',
            createConnection: async config => {
                if (opcoes.aoConectar) opcoes.aoConectar(config);
                return admin;
            },
            carregarDb: () => {
                if (opcoes.introduzirEnvNoDb) {
                    Object.assign(process.env, opcoes.introduzirEnvNoDb);
                }
                return pool;
            },
            carregarServer: () => {
                if (opcoes.modificarEnvNoServer) {
                    Object.assign(process.env, opcoes.modificarEnvNoServer);
                }
                if (opcoes.falharServer) throw new Error('Falha simulada ao carregar server.js');
                return app;
            }
        }
    };
}

test('QA_ENV_FILE rejeita basename .env e .env.production', t => {
    const diretorio = criarDiretorioTemporario(t);
    for (const nome of ['.env', '.env.production', '.env.local', '.env.qa.bak', 'config.env']) {
        const alvo = path.join(diretorio, nome);
        fs.writeFileSync(alvo, 'DB_HOST=127.0.0.1\n', 'utf8');
        assert.throws(
            () => validarCaminhoEnv(alvo, diretorio),
            new RegExp(ENV_FILE_BASENAME.replace('.', '\\.'))
        );
        assert.throws(
            () => verificarArquivoEnv(alvo, diretorio),
            new RegExp(ENV_FILE_BASENAME.replace('.', '\\.'))
        );
    }
});

test('carregarConfiguracaoEnv valida sem mutar process.env', t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=aivencloud.com',
        'DB_PORT=25060',
        'DB_SSL=true',
        'DB_USER=root',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo'
    ].join('\n'));

    const snapshotAnterior = {
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_NAME: process.env.DB_NAME
    };

    assert.throws(
        () => carregarConfiguracaoEnv({
            qaEnvFile: arquivo,
            backendDir,
            parseEnv: parseEnvSimples
        }),
        /DB_HOST/
    );

    assert.deepEqual({
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_NAME: process.env.DB_NAME
    }, snapshotAnterior);
});

test('aplicarEnvComSnapshot restaura chaves pré-existentes e remove novas chaves', () => {
    const alvo = {
        DB_HOST: 'host-anterior',
        NODE_ENV: 'development'
    };

    const restaurar = aplicarEnvComSnapshot({
        DB_HOST: '127.0.0.1',
        DB_PASSWORD: SENHA_FICTICIA,
        JWT_SECRET: 'segredo-qa',
        NODE_ENV: 'test'
    }, alvo);

    assert.equal(alvo.DB_HOST, '127.0.0.1');
    assert.equal(alvo.DB_PASSWORD, SENHA_FICTICIA);
    assert.equal(alvo.NODE_ENV, 'test');

    restaurar();
    restaurar();

    assert.equal(alvo.DB_HOST, 'host-anterior');
    assert.equal(alvo.NODE_ENV, 'development');
    assert.equal(Object.prototype.hasOwnProperty.call(alvo, 'DB_PASSWORD'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(alvo, 'JWT_SECRET'), false);
});

test('capturarSnapshotAmbiente preserva, restaura e remove variáveis, de forma idempotente', () => {
    const alvo = {
        PRESERVADA: 'original',
        MODIFICADA: 'antes',
        APAGADA: 'existia'
    };

    const snapshot = capturarSnapshotAmbiente(alvo);

    alvo.MODIFICADA = 'durante';
    alvo.INTRODUZIDA = 'nova';
    delete alvo.APAGADA;

    restaurarSnapshotAmbiente(snapshot);

    assert.equal(alvo.PRESERVADA, 'original');
    assert.equal(alvo.MODIFICADA, 'antes');
    assert.equal(alvo.APAGADA, 'existia');
    assert.equal(Object.prototype.hasOwnProperty.call(alvo, 'INTRODUZIDA'), false);

    // Segunda chamada é inofensiva (idempotente).
    restaurarSnapshotAmbiente(snapshot);
    assert.equal(alvo.PRESERVADA, 'original');
    assert.equal(alvo.MODIFICADA, 'antes');
    assert.equal(Object.prototype.hasOwnProperty.call(alvo, 'INTRODUZIDA'), false);
});

test('junction/symlink apontando para fora de backend é rejeitado em verificarArquivoEnv', t => {
    const backend = criarDiretorioTemporario(t);
    const externo = criarDiretorioTemporario(t);
    const arquivoExterno = path.join(externo, '.env.qa');
    fs.writeFileSync(arquivoExterno, 'DB_HOST=127.0.0.1\n', 'utf8');

    const linkSubdir = path.join(backend, 'atalho');
    fs.symlinkSync(externo, linkSubdir, 'junction');
    const viaLink = path.join(linkSubdir, '.env.qa');

    assert.throws(() => verificarArquivoEnv(viaLink, backend), /fora de backend/);
});

test('cleanup não executa DROP quando SELECT do marcador falha', async () => {
    const chamadas = [];
    const admin = {
        async query(sql) {
            chamadas.push(sql);
            if (sql.startsWith('SELECT token')) {
                throw new Error('Erro simulado no SELECT do marcador');
            }
            return [[]];
        }
    };

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_notif_qa_0123456789ab',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: 'a'.repeat(32)
        }),
        /Erro simulado no SELECT do marcador/
    );

    assert.equal(chamadas.length, 1);
    assert.equal(chamadas.some(sql => sql.startsWith('DROP DATABASE')), false);
});

test('cleanup recusa nome temporário malformado e token vazio sem consultar o banco', async () => {
    const admin = criarAdminFalso('a'.repeat(32));

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_notif_qa_0123456789AB',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: 'a'.repeat(32)
        }),
        /nome de banco temporário inválido/
    );

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_notif_qa_0123456789ab',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: ''
        }),
        /token de propriedade ausente/
    );

    assert.equal(podeDroparBanco({
        nome: 'recanto_notif_qa_0123456789ab',
        origem: 'recanto_camargo_dev',
        criado: true,
        token: '',
        tokenEsperado: ''
    }), false);

    assert.equal(admin.chamadas.length, 0);
});

test('erros do cleanup e da configuração não expõem senha nem token', async () => {
    const tokenSecreto = 'segredo-token-32-caracteres-abcd';
    const admin = criarAdminFalso('b'.repeat(32));

    await assert.rejects(
        () => executarDropAutorizado({
            admin,
            escapeId: ESCAPE_ID_FALSO,
            nome: 'recanto_notif_qa_0123456789ab',
            origem: 'recanto_camargo_dev',
            criado: true,
            tokenEsperado: tokenSecreto
        }),
        erro => {
            assert.equal(erro.message.includes(tokenSecreto), false);
            assert.equal(erro.message.includes(SENHA_FICTICIA), false);
            return true;
        }
    );
});

test('harness mantém process.env intacto quando a validação falha', async t => {
    const envDir = criarDiretorioTemporario(t);
    const arquivo = path.join(envDir, '.env.qa');
    fs.writeFileSync(arquivo, [
        'DB_HOST=remoto.aivencloud.com',
        'DB_USER=root',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo'
    ].join('\n'), 'utf8');

    const tinhaPassword = Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD');
    const passwordAnterior = process.env.DB_PASSWORD;
    let conexaoChamada = false;

    await assert.rejects(
        () => criarAmbienteMySQL({
            envFile: arquivo,
            backendDir: envDir,
            parseEnv: parseEnvSimples,
            escapeId: ESCAPE_ID_FALSO,
            hashSenha: async () => 'hash',
            createConnection: async () => {
                conexaoChamada = true;
                throw new Error('não deveria conectar');
            },
            carregarDb: () => ({}),
            carregarServer: () => ({})
        }),
        /DB_HOST/
    );

    assert.equal(conexaoChamada, false);
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'DB_PASSWORD'), tinhaPassword);
    assert.equal(process.env.DB_PASSWORD, passwordAnterior);
});

test('harness restaura process.env após cleanup e rejeita reentrada enquanto ativo', async t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const chaves = ['DB_HOST', 'DB_PORT', 'DB_SSL', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'];
    const antes = Object.fromEntries(chaves.map(k => [k, [Object.prototype.hasOwnProperty.call(process.env, k), process.env[k]]]));

    const { estado, opcoesHarness } = criarDepsFalsasHarness();
    const qa = await criarAmbienteMySQL({
        envFile: arquivo,
        backendDir,
        ...opcoesHarness
    });

    try {
        assert.equal(process.env.DB_HOST, '127.0.0.1');
        assert.equal(process.env.DB_NAME, qa.nome);
        assert.equal(process.env.DB_PASSWORD, SENHA_FICTICIA);

        await assert.rejects(
            () => criarAmbienteMySQL({
                envFile: arquivo,
                backendDir,
                ...opcoesHarness
            }),
            /ambiente MySQL de QA ativo/
        );
    } finally {
        await qa.fechar();
    }

    assert.equal(estado.poolEndChamado, true);
    assert.equal(estado.dropExecutado, true);
    assert.equal(estado.adminEndChamado, true);

    for (const chave of chaves) {
        assert.equal(Object.prototype.hasOwnProperty.call(process.env, chave), antes[chave][0], chave);
        assert.equal(process.env[chave], antes[chave][1], chave);
    }
});

test('harness habilita o pool só após as guardas e restaura as flags de isolamento', async t => {
    const snapshot = capturarSnapshotAmbiente();
    t.after(() => restaurarSnapshotAmbiente(snapshot));
    delete process.env.RC_QA_MYSQL_HARNESS;
    process.env.RC_TEST_ISOLATION = '1';

    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const observar = () => ({
        harness: process.env.RC_QA_MYSQL_HARNESS,
        isolamentoPresente: Object.prototype.hasOwnProperty.call(process.env, 'RC_TEST_ISOLATION')
    });
    let naConexaoAdministrativa;
    let noCarregamentoDoPool;
    const { opcoesHarness } = criarDepsFalsasHarness({
        aoConectar() { naConexaoAdministrativa = observar(); }
    });
    const carregarDb = opcoesHarness.carregarDb;
    opcoesHarness.carregarDb = () => {
        noCarregamentoDoPool = observar();
        return carregarDb();
    };

    const qa = await criarAmbienteMySQL({ envFile: arquivo, backendDir, ...opcoesHarness });
    try {
        assert.deepEqual(naConexaoAdministrativa, { harness: undefined, isolamentoPresente: true });
        assert.deepEqual(noCarregamentoDoPool, { harness: '1', isolamentoPresente: false });
        assert.equal(process.env.RC_QA_MYSQL_HARNESS, '1');
        assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'RC_TEST_ISOLATION'), false);
    } finally {
        await qa.fechar();
    }

    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'RC_QA_MYSQL_HARNESS'), false);
    assert.equal(process.env.RC_TEST_ISOLATION, '1');
});

test('harness remove variáveis introduzidas por dotenv e restaura as modificadas', async t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const chaveIntroduzida = 'RECANTO_QA_TESTE_INTRODUZIDA';
    const chaveModificada = 'RECANTO_QA_TESTE_MODIFICADA';

    delete process.env[chaveIntroduzida];
    process.env[chaveModificada] = 'valor-original';

    const { opcoesHarness } = criarDepsFalsasHarness({
        introduzirEnvNoDb: { [chaveIntroduzida]: 'vinda-do-dotenv' },
        modificarEnvNoServer: { [chaveModificada]: 'valor-durante' }
    });

    const qa = await criarAmbienteMySQL({ envFile: arquivo, backendDir, ...opcoesHarness });

    try {
        assert.equal(process.env[chaveIntroduzida], 'vinda-do-dotenv');
        assert.equal(process.env[chaveModificada], 'valor-durante');
    } finally {
        await qa.fechar();
    }

    assert.equal(Object.prototype.hasOwnProperty.call(process.env, chaveIntroduzida), false);
    assert.equal(process.env[chaveModificada], 'valor-original');
    delete process.env[chaveModificada];
});

test('fechar() é idempotente e não deixa resíduos após encerramento repetido', async t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const chave = 'RECANTO_QA_TESTE_RESIDUO';
    delete process.env[chave];

    const { opcoesHarness } = criarDepsFalsasHarness({
        introduzirEnvNoDb: { [chave]: 'residual' }
    });

    const qa = await criarAmbienteMySQL({ envFile: arquivo, backendDir, ...opcoesHarness });

    await qa.fechar();
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, chave), false);

    await qa.fechar();
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, chave), false);
});

test('falha inesperada no encerramento libera a guarda de reentrada', async t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const chave = 'RECANTO_QA_TESTE_FALHA_ENCERRAMENTO';
    delete process.env[chave];

    const primeiro = criarDepsFalsasHarness({
        falharPoolEnd: true,
        falharAdminEnd: true,
        introduzirEnvNoDb: { [chave]: 'introduzida' }
    });

    const qa = await criarAmbienteMySQL({ envFile: arquivo, backendDir, ...primeiro.opcoesHarness });

    await assert.rejects(() => qa.fechar(), /Falha simulada ao encerrar pool/);
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, chave), false);

    // Guarda liberada: um novo ambiente é aceito no mesmo processo.
    const segundo = criarDepsFalsasHarness();
    const qa2 = await criarAmbienteMySQL({ envFile: arquivo, backendDir, ...segundo.opcoesHarness });
    await qa2.fechar();
    assert.equal(segundo.estado.dropExecutado, true);
});

test('harness fecha o pool e restaura o ambiente se server.js falhar ao carregar', async t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const chaveIntroduzida = 'RECANTO_QA_TESTE_INTRODUZIDA_NA_FALHA';
    delete process.env[chaveIntroduzida];

    const { estado, opcoesHarness } = criarDepsFalsasHarness({
        falharServer: true,
        introduzirEnvNoDb: { [chaveIntroduzida]: 'vinda-do-dotenv' }
    });
    const tinhaJwt = Object.prototype.hasOwnProperty.call(process.env, 'JWT_SECRET');

    await assert.rejects(
        () => criarAmbienteMySQL({
            envFile: arquivo,
            backendDir,
            ...opcoesHarness
        }),
        /Falha simulada ao carregar server\.js/
    );

    assert.equal(estado.poolEndChamado, true);
    assert.equal(estado.dropExecutado, true);
    assert.equal(estado.adminEndChamado, true);
    assert.equal(estado.serverListenChamado, false);
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'JWT_SECRET'), tinhaJwt);
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, chaveIntroduzida), false);
});

test('harness rejeita execução quando singleton CommonJS da API já está em cache', async t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const dbPath = require.resolve('../config/db');
    await assert.rejects(
        () => criarAmbienteMySQL({
            envFile: arquivo,
            backendDir,
            cacheModulos: { [dbPath]: {} }
        }),
        /já estão em cache neste processo/
    );
});

test('encerrarComTimeout trata timeout com destroy opcional e preserva erro', async () => {
    let destroyChamado = false;
    const conexaoTravada = {
        end: () => new Promise(() => {}),
        destroy: () => { destroyChamado = true; }
    };

    await assert.rejects(
        () => encerrarComTimeout(conexaoTravada, 'conexão administrativa', 15),
        /Timeout ao encerrar conexão administrativa/
    );
    assert.equal(destroyChamado, true);

    const poolSemDestroy = {
        end: () => new Promise(() => {})
    };
    await assert.rejects(
        () => encerrarComTimeout(poolSemDestroy, 'pool MySQL', 15),
        /Timeout ao encerrar pool MySQL/
    );
});

test('harness executa limpeza restante mesmo quando pool.end sofre timeout', async t => {
    const { backendDir, arquivo } = criarEnvQaTemporario(t, [
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_SSL=false',
        'DB_USER=recanto_qa',
        `DB_PASSWORD=${SENHA_FICTICIA}`,
        'DB_NAME=recanto_camargo_dev'
    ].join('\n'));

    const { estado, opcoesHarness } = criarDepsFalsasHarness({ travarPoolEnd: true });
    const qa = await criarAmbienteMySQL({
        envFile: arquivo,
        backendDir,
        timeoutEncerramentoMs: 15,
        ...opcoesHarness
    });

    await assert.rejects(
        () => qa.fechar(),
        /Timeout ao encerrar pool MySQL/
    );

    assert.equal(estado.poolEndChamado, true);
    assert.equal(estado.dropExecutado, true);
    assert.equal(estado.adminEndChamado, true);
});
