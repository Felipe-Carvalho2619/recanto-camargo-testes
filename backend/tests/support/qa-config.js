'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOST_PERMITIDO = '127.0.0.1';
const PORTA_PERMITIDA = 3306;
const USUARIO_PERMITIDO = 'recanto_qa';
const BANCO_ORIGEM_PERMITIDO = 'recanto_camargo_dev';
const PREFIXO_BANCO_TEMPORARIO = 'recanto_notif_qa_';
const REGEX_BANCO_TEMPORARIO = /^recanto_notif_qa_[a-f0-9]{12}$/;
const TABELA_MARCADOR = '__qa_guard';
const ENV_FILE_BASENAME = '.env.qa';
const BANCOS_HISTORICOS = Object.freeze([
    'recanto_camargo',
    'recanto_camargo_teste',
    'recanto_camargo_teste_p3',
    'recanto_camargo_qa_sprint3_20261023_023628'
]);

function comoTexto(valor) {
    return typeof valor === 'string' ? valor.trim() : '';
}

// Comparação de contenção compatível com Windows (case-insensitive e sem \\?\).
function estaDentro(caminho, raiz) {
    let alvo = caminho;
    let base = raiz;
    if (process.platform === 'win32') {
        alvo = alvo.replace(/^\\\\\?\\/, '').toLowerCase();
        base = base.replace(/^\\\\\?\\/, '').toLowerCase();
    }
    return alvo !== base && alvo.startsWith(base + path.sep);
}

// Resolve QA_ENV_FILE sem fallback. Caminhos relativos seguem o diretório
// de execução (cwd); o resultado precisa ficar dentro de backend/.
function validarCaminhoEnv(qaEnvFile, backendDir, cwd = process.cwd()) {
    const bruto = comoTexto(qaEnvFile);
    if (!bruto) {
        throw new Error('QA_ENV_FILE não definido. Informe um arquivo .env.qa dentro de backend/.');
    }

    const raiz = path.resolve(backendDir);
    const resolvido = path.isAbsolute(bruto)
        ? path.resolve(bruto)
        : path.resolve(cwd, bruto);

    if (!estaDentro(resolvido, raiz)) {
        throw new Error('QA_ENV_FILE deve apontar para um arquivo dentro de backend/.');
    }

    if (path.basename(resolvido) !== ENV_FILE_BASENAME) {
        throw new Error(`QA_ENV_FILE deve ter exatamente o nome ${ENV_FILE_BASENAME}.`);
    }

    return resolvido;
}

// Confirma existência, tipo regular, nome autorizado e que o caminho real (após symlinks)
// continua dentro de backend/.
function verificarArquivoEnv(caminho, backendDir) {
    const raizLexical = path.resolve(backendDir);
    let raizReal;
    try {
        raizReal = fs.realpathSync(raizLexical);
    } catch {
        raizReal = raizLexical;
    }

    let stat;
    try {
        stat = fs.statSync(caminho);
    } catch {
        throw new Error('QA_ENV_FILE não existe ou não pode ser lido.');
    }

    if (!stat.isFile()) {
        throw new Error('QA_ENV_FILE deve ser um arquivo regular.');
    }

    let real;
    try {
        real = fs.realpathSync(caminho);
    } catch {
        throw new Error('QA_ENV_FILE não pôde ser resolvido.');
    }

    if (!estaDentro(real, raizReal)) {
        throw new Error('QA_ENV_FILE resolve para fora de backend/.');
    }

    if (path.basename(real) !== ENV_FILE_BASENAME) {
        throw new Error(`QA_ENV_FILE resolve para arquivo não autorizado (esperado ${ENV_FILE_BASENAME}).`);
    }

    return real;
}

// Valida a configuração inteira antes de qualquer conexão MySQL.
// Aceita apenas 127.0.0.1:3306, SSL desativado, recanto_qa e recanto_camargo_dev.
function validarConfiguracaoQA(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Configuração de QA ausente.');
    }

    const host = comoTexto(config.DB_HOST).toLowerCase();
    if (host !== HOST_PERMITIDO) {
        throw new Error(`DB_HOST deve ser exatamente ${HOST_PERMITIDO} (TCP local).`);
    }

    const portaBruta = config.DB_PORT;
    let porta;
    if (portaBruta === undefined || portaBruta === null) {
        porta = PORTA_PERMITIDA;
    } else if (typeof portaBruta === 'number') {
        if (!Number.isInteger(portaBruta) || portaBruta !== PORTA_PERMITIDA) {
            throw new Error(`DB_PORT deve ser ${PORTA_PERMITIDA}.`);
        }
        porta = portaBruta;
    } else if (typeof portaBruta === 'string') {
        const portaTexto = portaBruta.trim();
        if (portaTexto === '' || portaTexto === String(PORTA_PERMITIDA)) {
            porta = PORTA_PERMITIDA;
        } else {
            throw new Error(`DB_PORT deve ser ${PORTA_PERMITIDA}.`);
        }
    } else {
        throw new Error(`DB_PORT deve ser ${PORTA_PERMITIDA}.`);
    }

    const sslBruto = config.DB_SSL;
    const sslDesativado = sslBruto === undefined || sslBruto === null || sslBruto === false ||
        (typeof sslBruto === 'string' && ['', 'false'].includes(sslBruto.trim().toLowerCase()));
    if (!sslDesativado) {
        throw new Error('DB_SSL deve estar desativado (false).');
    }

    const usuario = comoTexto(config.DB_USER);
    if (usuario !== USUARIO_PERMITIDO) {
        throw new Error(`DB_USER deve ser ${USUARIO_PERMITIDO}.`);
    }

    const banco = comoTexto(config.DB_NAME);
    if (banco !== BANCO_ORIGEM_PERMITIDO) {
        if (REGEX_BANCO_TEMPORARIO.test(banco)) {
            throw new Error('DB_NAME não pode ser um banco temporário.');
        }
        if (BANCOS_HISTORICOS.includes(banco) || banco.startsWith('recanto_camargo_qa_sprint3_')) {
            throw new Error('DB_NAME histórico não é permitido como origem.');
        }
        throw new Error(`DB_NAME deve ser ${BANCO_ORIGEM_PERMITIDO}.`);
    }

    const senha = config.DB_PASSWORD;
    if (typeof senha !== 'string' || senha.trim().length === 0) {
        throw new Error('DB_PASSWORD ausente na configuração de QA.');
    }

    return Object.freeze({
        host,
        port: porta,
        ssl: false,
        user: usuario,
        password: senha,
        database: banco
    });
}

function nomeTemporarioValido(nome) {
    return typeof nome === 'string' && REGEX_BANCO_TEMPORARIO.test(nome);
}

// Prova de propriedade exigida antes de qualquer DROP DATABASE.
function podeDroparBanco({ nome, origem, criado, token, tokenEsperado } = {}) {
    return criado === true &&
        nomeTemporarioValido(nome) &&
        typeof origem === 'string' &&
        nome !== origem &&
        typeof token === 'string' &&
        typeof tokenEsperado === 'string' &&
        tokenEsperado.length > 0 &&
        token.length === tokenEsperado.length &&
        token === tokenEsperado;
}

// Executa o DROP somente após consultar o marcador e confirmar a propriedade.
// A função recebe escapeId para permanecer independente do mysql2 nos testes.
async function executarDropAutorizado({ admin, escapeId, nome, origem, criado, tokenEsperado }) {
    if (!criado || !admin) return false;

    if (typeof escapeId !== 'function') {
        throw new Error('Função escapeId ausente.');
    }

    if (!nomeTemporarioValido(nome) || nome === origem) {
        throw new Error('Cleanup recusado: nome de banco temporário inválido.');
    }

    if (typeof tokenEsperado !== 'string' || tokenEsperado.length === 0) {
        throw new Error('Cleanup recusado: token de propriedade ausente.');
    }

    const [linhas] = await admin.query(
        `SELECT token FROM ${escapeId(nome)}.${escapeId(TABELA_MARCADOR)} WHERE token = ? LIMIT 1`,
        [tokenEsperado]
    );
    const tokenEncontrado = linhas?.[0]?.token;

    if (!podeDroparBanco({ nome, origem, criado, token: tokenEncontrado, tokenEsperado })) {
        throw new Error(`Cleanup recusado para ${nome}: propriedade do banco não comprovada.`);
    }

    await admin.query(`DROP DATABASE ${escapeId(nome)}`);
    return true;
}

// Lê e valida QA_ENV_FILE a partir do caminho real validado, sem alterar process.env.
function carregarConfiguracaoEnv({
    qaEnvFile,
    backendDir,
    cwd = process.cwd(),
    readFileSync = fs.readFileSync,
    parseEnv
} = {}) {
    if (typeof parseEnv !== 'function') {
        throw new Error('Parser de arquivo env ausente.');
    }

    const caminhoLexical = validarCaminhoEnv(qaEnvFile, backendDir, cwd);
    const caminhoReal = verificarArquivoEnv(caminhoLexical, backendDir);

    let conteudo;
    try {
        conteudo = readFileSync(caminhoReal, 'utf8');
    } catch {
        throw new Error('QA_ENV_FILE não pôde ser lido.');
    }

    const parsed = parseEnv(conteudo);
    return validarConfiguracaoQA(parsed);
}

// Aplica variáveis no ambiente alvo retornando função idempotente de restauração
// limitada às chaves informadas. Usada quando só interessa desfazer um conjunto conhecido.
function aplicarEnvComSnapshot(novasVariaveis, targetEnv = process.env) {
    const chaves = Object.keys(novasVariaveis);
    const anterior = new Map();

    for (const chave of chaves) {
        if (Object.prototype.hasOwnProperty.call(targetEnv, chave)) {
            anterior.set(chave, { existe: true, valor: targetEnv[chave] });
        } else {
            anterior.set(chave, { existe: false, valor: undefined });
        }
    }

    Object.assign(targetEnv, novasVariaveis);

    let restaurado = false;
    return function restaurarEnv() {
        if (restaurado) return;
        restaurado = true;

        for (const [chave, registro] of anterior.entries()) {
            if (registro.existe) {
                targetEnv[chave] = registro.valor;
            } else {
                delete targetEnv[chave];
            }
        }
    };
}

// Snapshot integral do ambiente. Necessário porque módulos carregados durante o harness
// (config/db.js, utils/crypto.js) chamam dotenv.config() e podem introduzir chaves que
// não fazem parte de montarEnvAplicacao. Restaurar o snapshot remove essas chaves e
// devolve as preexistentes ao valor original.
function capturarSnapshotAmbiente(targetEnv = process.env) {
    const valores = new Map();
    for (const chave of Object.keys(targetEnv)) {
        valores.set(chave, targetEnv[chave]);
    }
    return { alvo: targetEnv, valores, restaurado: false };
}

// Restauração idempotente: remove chaves inexistentes no snapshot e repõe as demais.
function restaurarSnapshotAmbiente(snapshot) {
    if (!snapshot || snapshot.restaurado) return;
    snapshot.restaurado = true;

    const { alvo, valores } = snapshot;

    for (const chave of Object.keys(alvo)) {
        if (!valores.has(chave)) {
            delete alvo[chave];
        }
    }

    for (const [chave, valor] of valores.entries()) {
        if (alvo[chave] !== valor) {
            alvo[chave] = valor;
        }
    }
}

// Encerra conexão ou pool com limite de tempo para evitar espera indefinida.
async function encerrarComTimeout(recurso, rotulo, timeoutMs = 5000) {
    if (!recurso || typeof recurso.end !== 'function') return;

    let timer;
    const promessaEnd = Promise.resolve().then(() => recurso.end());
    promessaEnd.catch(() => {});

    const promessaTimeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Timeout ao encerrar ${rotulo} após ${timeoutMs}ms.`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
    });

    try {
        await Promise.race([promessaEnd, promessaTimeout]);
    } catch (erro) {
        if (typeof recurso.destroy === 'function') {
            try {
                recurso.destroy();
            } catch {
                // Preserva o erro original de encerramento ou timeout.
            }
        }
        throw erro;
    } finally {
        clearTimeout(timer);
    }
}

// A validação acontece antes de chamar a função de conexão.
async function conectarComConfiguracaoValidada(config, conectar) {
    if (typeof conectar !== 'function') {
        throw new Error('Função de conexão ausente.');
    }
    const validada = validarConfiguracaoQA(config);
    return conectar(validada);
}

function montarOpcoesConexao(config) {
    return {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        ssl: false,
        connectTimeout: 5000,
        multipleStatements: false
    };
}

// Sincroniza a API com exatamente o mesmo destino da conexão administrativa.
function montarEnvAplicacao(config, nomeBanco, jwtSecret) {
    return {
        DB_HOST: config.host,
        DB_PORT: String(config.port),
        DB_SSL: 'false',
        DB_USER: config.user,
        DB_PASSWORD: config.password,
        DB_NAME: nomeBanco,
        JWT_SECRET: jwtSecret,
        RESEND_API_KEY: '',
        RESEND_FROM_EMAIL: '',
        NODE_ENV: 'test'
    };
}

module.exports = {
    HOST_PERMITIDO,
    PORTA_PERMITIDA,
    USUARIO_PERMITIDO,
    BANCO_ORIGEM_PERMITIDO,
    PREFIXO_BANCO_TEMPORARIO,
    REGEX_BANCO_TEMPORARIO,
    TABELA_MARCADOR,
    ENV_FILE_BASENAME,
    BANCOS_HISTORICOS,
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
};
