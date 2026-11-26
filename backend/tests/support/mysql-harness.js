const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const path = require('node:path');
const {
    carregarConfiguracaoEnv,
    capturarSnapshotAmbiente,
    restaurarSnapshotAmbiente,
    encerrarComTimeout,
    nomeTemporarioValido,
    executarDropAutorizado,
    conectarComConfiguracaoValidada,
    montarOpcoesConexao,
    montarEnvAplicacao,
    PREFIXO_BANCO_TEMPORARIO,
    TABELA_MARCADOR
} = require('./qa-config');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const DB_MODULE_PATH = require.resolve('../../config/db');
const SERVER_MODULE_PATH = require.resolve('../../server');

// Proteção contra reentrada no mesmo processo; o backend usa singletons CommonJS
// (config/db.js e server.js) que não podem ser reinicializados com segurança sem reiniciar o processo.
let ambienteAtivo = false;

function verificarSingletonApiEmCache(cacheModulos = require.cache) {
    if (cacheModulos && (cacheModulos[DB_MODULE_PATH] || cacheModulos[SERVER_MODULE_PATH])) {
        throw new Error(
            'Os módulos da API (config/db.js ou server.js) já estão em cache neste processo. ' +
            'Execute cada suíte de integração MySQL em um processo Node separado.'
        );
    }
}

// Usa apenas o schema do banco de origem. Nenhum dado de cliente é copiado.
async function criarAmbienteMySQL(opcoes = {}) {
    if (ambienteAtivo) {
        throw new Error(
            'Já existe um ambiente MySQL de QA ativo neste processo. Finalize-o com fechar() antes de iniciar outro.'
        );
    }

    const usandoModulosReais = !opcoes.carregarDb && !opcoes.carregarServer;
    if (usandoModulosReais) {
        verificarSingletonApiEmCache(opcoes.cacheModulos || require.cache);
    }

    ambienteAtivo = true;

    const envFile = Object.prototype.hasOwnProperty.call(opcoes, 'envFile')
        ? opcoes.envFile
        : process.env.QA_ENV_FILE;
    const backendDir = opcoes.backendDir || BACKEND_DIR;
    const cwd = opcoes.cwd || process.cwd();
    const readFileSync = opcoes.readFileSync || fs.readFileSync;
    const parseEnv = opcoes.parseEnv || (conteudo => require('dotenv').parse(conteudo));
    const timeoutEncerramentoMs = opcoes.timeoutEncerramentoMs ?? 5000;

    let admin;
    let pool;
    let server;
    let criado = false;
    let fechado = false;
    let nome = '';
    let origem = '';
    let escapeId = opcoes.escapeId;
    const tokenPropriedade = randomBytes(16).toString('hex');

    // Snapshot integral antes de qualquer módulo que possa chamar dotenv.config().
    // A restauração em fechar() remove também chaves introduzidas por esses módulos.
    const snapshotAmbiente = capturarSnapshotAmbiente();

    async function fecharConexoes() {
        const erros = [];
        if (server) {
            try {
                await new Promise((resolve, reject) => {
                    server.close(erro => {
                        if (erro && erro.code !== 'ERR_SERVER_NOT_RUNNING') reject(erro);
                        else resolve();
                    });
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                });
            } catch (erro) {
                erros.push(erro);
            }
        }
        if (pool) {
            try {
                await encerrarComTimeout(pool, 'pool MySQL', timeoutEncerramentoMs);
            } catch (erro) {
                erros.push(erro);
            }
        }
        return erros;
    }

    async function fechar() {
        if (fechado) return;
        fechado = true;

        const erros = [];

        // O finally externo garante liberação da guarda e restauração do ambiente
        // mesmo se qualquer etapa do encerramento lançar de forma inesperada.
        try {
            try {
                erros.push(...await fecharConexoes());
            } catch (erro) {
                erros.push(erro);
            }

            if (criado && admin) {
                try {
                    await executarDropAutorizado({
                        admin,
                        escapeId,
                        nome,
                        origem,
                        criado,
                        tokenEsperado: tokenPropriedade
                    });
                } catch (erro) {
                    erros.push(erro);
                }
            }

            if (admin) {
                try {
                    await encerrarComTimeout(admin, 'conexão administrativa', timeoutEncerramentoMs);
                } catch (erro) {
                    erros.push(erro);
                }
            }
        } finally {
            if (snapshotAmbiente) {
                restaurarSnapshotAmbiente(snapshotAmbiente);
            }
            ambienteAtivo = false;
        }

        if (erros.length) throw erros[0];
    }

    try {
        const prepararSchemaTemporario = opcoes.prepararSchemaTemporario;
        if (prepararSchemaTemporario !== undefined && typeof prepararSchemaTemporario !== 'function') {
            throw new Error('prepararSchemaTemporario deve ser uma função.');
        }

        // Lê e valida o arquivo .env.qa sem alterar process.env antes da validação.
        const cfg = carregarConfiguracaoEnv({
            qaEnvFile: envFile,
            backendDir,
            cwd,
            readFileSync,
            parseEnv
        });
        origem = cfg.database;
        nome = `${PREFIXO_BANCO_TEMPORARIO}${randomBytes(6).toString('hex')}`;
        if (!nomeTemporarioValido(nome)) throw new Error('Nome de banco temporário inválido.');

        const precisaMysql2 = !opcoes.createConnection || !escapeId;
        const mysql = opcoes.mysql || (precisaMysql2 ? require('mysql2/promise') : null);
        const createConnection = opcoes.createConnection || (opts => mysql.createConnection(opts));
        escapeId = escapeId || mysql.escapeId;
        const hashSenha = opcoes.hashSenha || (senha => require('bcryptjs').hash(senha, 4));
        const carregarDb = opcoes.carregarDb || (() => require('../../config/db'));
        const carregarServer = opcoes.carregarServer || (() => require('../../server'));

        const configParaValidar = {
            DB_HOST: cfg.host,
            DB_PORT: String(cfg.port),
            DB_SSL: 'false',
            DB_USER: cfg.user,
            DB_PASSWORD: cfg.password,
            DB_NAME: cfg.database
        };

        admin = await conectarComConfiguracaoValidada(configParaValidar, validada =>
            createConnection(montarOpcoesConexao(validada))
        );

        const [tabelas] = await admin.query(
            'SELECT TABLE_NAME AS nome FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
            [origem, 'BASE TABLE']
        );
        if (tabelas.some(t => t.nome === TABELA_MARCADOR)) {
            throw new Error(`Schema de origem contém a tabela reservada ${TABELA_MARCADOR}.`);
        }

        const [vinculos] = await admin.query(
            'SELECT TABLE_NAME AS origem, REFERENCED_TABLE_NAME AS destino, REFERENCED_TABLE_SCHEMA AS bancoDestino FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
            [origem]
        );
        if (vinculos.some(v => v.bancoDestino !== origem)) throw new Error('Teste não aceita FKs entre bancos.');

        const ordenadas = [];
        const restantes = new Set(tabelas.map(t => t.nome));
        while (restantes.size) {
            const disponivel = [...restantes].find(t => vinculos.filter(v => v.origem === t).every(v => !restantes.has(v.destino)));
            if (!disponivel) throw new Error('Schema possui dependências cíclicas; não é possível clonar com este teste.');
            ordenadas.push(disponivel);
            restantes.delete(disponivel);
        }

        await admin.query(`CREATE DATABASE ${escapeId(nome)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        criado = true;

        // Marcador de propriedade: o DROP só é permitido se este token existir no banco.
        // Criado com nome qualificado para sobreviver a uma falha antes do USE.
        await admin.query(
            `CREATE TABLE ${escapeId(nome)}.${escapeId(TABELA_MARCADOR)} (token CHAR(32) NOT NULL PRIMARY KEY, criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`
        );
        await admin.query(
            `INSERT INTO ${escapeId(nome)}.${escapeId(TABELA_MARCADOR)} (token) VALUES (?)`,
            [tokenPropriedade]
        );

        await admin.query(`USE ${escapeId(nome)}`);
        const [bancoSelecionado] = await admin.query('SELECT DATABASE() AS nome');
        if (bancoSelecionado[0].nome !== nome) throw new Error('Banco descartável não selecionado.');

        for (const tabela of ordenadas) {
            const [ddl] = await admin.query(`SHOW CREATE TABLE ${escapeId(origem)}.${escapeId(tabela)}`);
            await admin.query(ddl[0]['Create Table'].replace(/ AUTO_INCREMENT=\d+/g, ''));
        }

        if (prepararSchemaTemporario) {
            // Extensão opt-in: qualquer DDL adicional ocorre exclusivamente no clone,
            // nunca no schema de origem, e antes do carregamento do pool/server.
            await prepararSchemaTemporario({ admin, nome });
            const [bancoPreparado] = await admin.query('SELECT DATABASE() AS nome');
            if (bancoPreparado[0].nome !== nome) {
                throw new Error('O preparo adicional não manteve o banco descartável selecionado.');
            }
        }

        // Contas e imóvel inteiramente fictícios, restritos ao banco descartável.
        const senha = `QA-${randomBytes(16).toString('hex')}`;
        const senhaHash = await hashSenha(senha);
        for (const [id, nomeUsuario] of [[1, 'Proprietário QA'], [2, 'Hóspede QA'], [3, 'Outro Hóspede QA']]) {
            await admin.query(
                'INSERT INTO usu_usuario (Usu_Id, Usu_Nome, Usu_CPF, Usu_CPF_Hash, Usu_Email, Usu_Telefone, Usu_SenhaHash, Usu_Status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [id, nomeUsuario, 'FICTICIO', `FICTICIO-${id}`, `qa${id}@example.invalid`, '', senhaHash, 'ATIVO']
            );
        }
        await admin.query('INSERT INTO pro_proprietario (Usu_Id) VALUES (?)', [1]);
        await admin.query('INSERT INTO hos_hospede (Usu_Id) VALUES (?), (?)', [2, 3]);
        await admin.query(
            'INSERT INTO imo_imovel (Imo_Id, Pro_Proprietario_Usu_Id, Imo_Nome, Imo_Endereco, Imo_Descricao, Imo_ValorFixo, Imo_Status, Imo_NotaMedial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [1, 1, 'Imóvel de QA', 'Endereço fictício', 'Teste automatizado isolado', 200, 'ATIVO', 0]
        );

        // Aplica a configuração da API depois do snapshot integral; fechar() restaura tudo.
        Object.assign(process.env, montarEnvAplicacao(cfg, nome, randomBytes(32).toString('hex')));

        // Somente após todas as guardas e a criação do banco descartável o pool da API é autorizado.
        // O snapshot restaura inclusive a remoção de RC_TEST_ISOLATION ao encerrar o harness.
        process.env.RC_QA_MYSQL_HARNESS = '1';
        delete process.env.RC_TEST_ISOLATION;

        // Captura o pool antes de carregar o servidor para fechá-lo caso server.js falhe.
        pool = carregarDb();
        const app = carregarServer();
        const [bancoApp] = await pool.query('SELECT DATABASE() AS nome');
        if (bancoApp[0].nome !== nome) throw new Error('A aplicação não está usando o banco descartável.');

        server = app.listen(Number(process.env.QA_API_PORT || 0), '127.0.0.1');
        await once(server, 'listening');
        const url = `http://127.0.0.1:${server.address().port}`;

        async function login(id) {
            const resposta = await fetch(`${url}/api/usuarios/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: `qa${id}@example.invalid`, senha })
            });
            if (!resposta.ok) throw new Error('Falha no login da conta sintética.');
            return resposta.headers.get('set-cookie').split(';')[0];
        }

        return { admin, pool, url, login, nome, fechar, senha };
    } catch (error) {
        try {
            await fechar();
        } catch (erroLimpeza) {
            error.cleanupError = erroLimpeza;
        }
        throw error;
    }
}

module.exports = { criarAmbienteMySQL };
