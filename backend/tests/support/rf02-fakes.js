'use strict';

const NORMALIZAR_ESPACOS = valor => String(valor).replace(/\s+/g, ' ').trim();

function criarLoggerFake() {
    const entradas = [];
    const registrar = nivel => (...args) => entradas.push({ nivel, args });
    return {
        entradas,
        log: registrar('log'),
        info: registrar('info'),
        warn: registrar('warn'),
        error: registrar('error'),
        texto() {
            return entradas.map(entrada => `${entrada.nivel}:${entrada.args.map(String).join(' ')}`).join('\n');
        }
    };
}

function criarClockFake(inicial = '2026-11-23T12:00:00.000Z') {
    let atual = new Date(inicial).getTime();
    return {
        clock: { now: () => new Date(atual) },
        agora: () => new Date(atual),
        definir(valor) { atual = new Date(valor).getTime(); },
        avancar(ms) { atual += ms; }
    };
}

function criarDbFake(handler, opcoes = {}) {
    const chamadas = [];
    const eventos = [];
    const conexoes = [];
    let fila = Promise.resolve();

    async function executar(origem, sql, parametros = []) {
        const chamada = { origem, sql: NORMALIZAR_ESPACOS(sql), parametros };
        chamadas.push(chamada);
        if (typeof handler !== 'function') throw new Error('Query fake sem handler configurado.');
        return handler(chamada);
    }

    async function getConnection() {
        if (opcoes.serializarTransacoes) {
            const anterior = fila;
            let liberarFila;
            fila = new Promise(resolve => { liberarFila = resolve; });
            await anterior;

            let liberado = false;
            const conexao = criarConexao(() => {
                if (!liberado) {
                    liberado = true;
                    liberarFila();
                }
            });
            conexoes.push(conexao);
            return conexao;
        }
        const conexao = criarConexao();
        conexoes.push(conexao);
        return conexao;
    }

    function criarConexao(aoLiberar) {
        let liberado = false;
        return {
            get liberado() { return liberado; },
            async query(sql, parametros) { return executar('conexao', sql, parametros); },
            async beginTransaction() {
                eventos.push('begin');
                if (opcoes.aoEvento) await opcoes.aoEvento('begin', this);
            },
            async commit() {
                eventos.push('commit');
                if (opcoes.aoEvento) await opcoes.aoEvento('commit', this);
            },
            async rollback() {
                eventos.push('rollback');
                if (opcoes.aoEvento) await opcoes.aoEvento('rollback', this);
            },
            release() {
                if (liberado) return;
                liberado = true;
                eventos.push('release');
                if (aoLiberar) aoLiberar();
                if (opcoes.aoEvento) opcoes.aoEvento('release', this);
            }
        };
    }

    return {
        chamadas,
        eventos,
        conexoes,
        async query(sql, parametros) { return executar('pool', sql, parametros); },
        async getConnection() {
            eventos.push('getConnection');
            return getConnection();
        }
    };
}

function criarRespostaFake() {
    return {
        statusCode: 200,
        body: undefined,
        headers: Object.create(null),
        cookies: [],
        cookiesLimpos: [],
        set(nome, valor) {
            if (typeof nome === 'object') Object.assign(this.headers, nome);
            else this.headers[nome.toLowerCase()] = valor;
            return this;
        },
        status(codigo) { this.statusCode = codigo; return this; },
        json(corpo) { this.body = corpo; return this; },
        cookie(nome, valor, opcoes) { this.cookies.push({ nome, valor, opcoes }); return this; },
        clearCookie(nome, opcoes) { this.cookiesLimpos.push({ nome, opcoes }); return this; }
    };
}

function criarRequestFake({ services = {}, body = {}, cookies = {}, ip = '198.51.100.10', headers = {} } = {}) {
    return {
        body,
        cookies,
        ip,
        headers,
        socket: { remoteAddress: ip },
        app: { get: nome => services[nome] }
    };
}

async function chamarHandler(handler, req) {
    const res = criarRespostaFake();
    await handler(req, res);
    return res;
}

async function chamarMiddleware(middleware, req) {
    const res = criarRespostaFake();
    let next = false;
    await middleware(req, res, () => { next = true; });
    return { res, next };
}

function capturarConsoleFake() {
    const logger = criarLoggerFake();
    const anteriores = {};
    for (const nivel of ['log', 'info', 'warn', 'error']) {
        anteriores[nivel] = console[nivel];
        console[nivel] = logger[nivel];
    }
    return {
        logger,
        restaurar() { for (const [nivel, valor] of Object.entries(anteriores)) console[nivel] = valor; }
    };
}

function carregarAuthIsolado(db) {
    const caminhoDb = require.resolve('../../config/db');
    const caminhoCrypto = require.resolve('../../utils/crypto');
    const caminhoController = require.resolve('../../controllers/authController');
    const caminhoMiddleware = require.resolve('../../middlewares/authMiddleware');
    const modulos = [caminhoController, caminhoMiddleware];
    const anteriores = new Map();
    const modulosInstalados = [caminhoDb, caminhoCrypto];

    for (const caminho of [...modulos, ...modulosInstalados]) {
        anteriores.set(caminho, require.cache[caminho]);
        delete require.cache[caminho];
    }

    require.cache[caminhoDb] = {
        id: caminhoDb, filename: caminhoDb, loaded: true, exports: db
    };
    require.cache[caminhoCrypto] = {
        id: caminhoCrypto,
        filename: caminhoCrypto,
        loaded: true,
        exports: {
            encryptCPF: () => { throw new Error('CPF fake não configurado.'); },
            hashCPF: () => { throw new Error('CPF fake não configurado.'); }
        }
    };

    try {
        const controller = require(caminhoController);
        const middleware = require(caminhoMiddleware);
        for (const caminho of modulosInstalados) {
            const anterior = anteriores.get(caminho);
            if (anterior) require.cache[caminho] = anterior;
            else delete require.cache[caminho];
        }
        return {
            controller,
            middleware,
            cleanup() {
                for (const caminho of modulos) {
                    const anterior = anteriores.get(caminho);
                    if (anterior) require.cache[caminho] = anterior;
                    else delete require.cache[caminho];
                }
            }
        };
    } catch (erro) {
        for (const [caminho, anterior] of anteriores) {
            if (anterior) require.cache[caminho] = anterior;
            else delete require.cache[caminho];
        }
        throw erro;
    }
}

function snapshotEnv(chaves) {
    const anterior = new Map();
    for (const chave of chaves) {
        anterior.set(chave, Object.prototype.hasOwnProperty.call(process.env, chave)
            ? { existe: true, valor: process.env[chave] }
            : { existe: false });
    }
    return () => {
        for (const [chave, registro] of anterior) {
            if (registro.existe) process.env[chave] = registro.valor;
            else delete process.env[chave];
        }
    };
}

function serializar(valor) {
    return JSON.stringify(valor, (_chave, item) => {
        if (typeof item === 'bigint') return item.toString();
        if (Buffer.isBuffer(item)) return { hex: item.toString('hex'), base64url: item.toString('base64url') };
        return item;
    });
}

module.exports = {
    NORMALIZAR_ESPACOS,
    criarLoggerFake,
    criarClockFake,
    criarDbFake,
    criarRespostaFake,
    criarRequestFake,
    chamarHandler,
    chamarMiddleware,
    capturarConsoleFake,
    carregarAuthIsolado,
    snapshotEnv,
    serializar
};
