const crypto = require('crypto');
const { dataMysql, decodificarBase64Url32 } = require('./recuperacaoSenhaService');

const INFO_RATE_LIMIT = 'rf02/rate-limit/v1';
const MINUTO_MS = 60 * 1000;
const LIMITE_DELETE_RATE_LIMIT = 500;

function criarRecuperacaoSenhaRateLimitService({
    db,
    env = process.env,
    secret,
    clock = { now: () => Date.now() },
    logger = console
} = {}) {
    function agora() {
        const valor = typeof clock === 'function' ? clock() : clock.now();
        const data = valor instanceof Date ? new Date(valor.getTime()) : new Date(valor);
        if (Number.isNaN(data.getTime())) {
            const erro = new Error('Relógio de rate-limit indisponível.');
            erro.codigo = 'RF02_CLOCK';
            throw erro;
        }
        return data;
    }

    function derivarChave() {
        const valor = secret !== undefined ? secret : env.RF02_RESET_SECRET;
        const segredo = decodificarBase64Url32(valor);
        if (!segredo) {
            const erro = new Error('Configuração de rate-limit indisponível.');
            erro.codigo = 'RF02_CONFIG';
            throw erro;
        }
        return crypto.hkdfSync(
            'sha256',
            segredo,
            Buffer.alloc(0),
            Buffer.from(INFO_RATE_LIMIT, 'utf8'),
            32
        );
    }

    function chaveRegistro(chave, escopo, valor) {
        return crypto.createHmac('sha256', chave)
            .update(`${escopo}\0${valor}`, 'utf8')
            .digest();
    }

    function normalizarEmail(email) {
        return String(email || '').trim().toLowerCase();
    }

    async function aplicar(regras) {
        const chave = derivarChave();
        const atual = agora();
        const atualMs = atual.getTime();
        let conexao;
        try {
            conexao = await db.getConnection();
            await conexao.beginTransaction();
            let retryAfter = 0;

            // Ordem determinística para todos os buckets da solicitação, reduzindo
            // inversão de locks entre requisições concorrentes.
            const regrasOrdenadas = [...regras].sort((a, b) => (
                a.escopo < b.escopo ? -1 : (a.escopo > b.escopo ? 1 : 0)
            ));
            for (const regra of regrasOrdenadas) {
                const inicioMs = Math.floor(atualMs / regra.duracaoMs) * regra.duracaoMs;
                const fimMs = inicioMs + regra.duracaoMs;
                const inicio = new Date(inicioMs);
                const fim = new Date(fimMs);
                const chaveHmac = chaveRegistro(chave, regra.escopo, regra.valor);

                await conexao.query(
                    `INSERT INTO rf02_rate_limit
                     (escopo, chave_hmac, janela_inicio, contador, expira_em)
                     VALUES (?, ?, ?, 1, ?)
                     -- Em duplicate, somente o contador muda: início e expiração da
                     -- fixed-window nunca são renovados.
                     ON DUPLICATE KEY UPDATE contador = contador + 1`,
                    [regra.escopo, chaveHmac, dataMysql(inicio), dataMysql(fim)]
                );
                const [registros] = await conexao.query(
                    `SELECT contador FROM rf02_rate_limit
                     WHERE escopo = ? AND chave_hmac = ? AND janela_inicio = ?
                     LIMIT 1 FOR UPDATE`,
                    [regra.escopo, chaveHmac, dataMysql(inicio)]
                );
                if (registros.length !== 1) {
                    const erro = new Error('Janela de rate-limit não confirmada.');
                    erro.codigo = 'RF02_RATE_LIMIT_INFRA';
                    throw erro;
                }

                if (Number(registros[0].contador) > regra.limite) {
                    retryAfter = Math.max(retryAfter, Math.max(1, Math.ceil((fimMs - atualMs) / 1000)));
                }
            }

            await conexao.commit();
            return retryAfter > 0
                ? { permitido: false, retryAfter }
                : { permitido: true, retryAfter: 0 };
        } catch (erro) {
            if (conexao) await conexao.rollback().catch(() => {});
            logger.error('[RF02 rate-limit] estado=INDISPONIVEL tentativas=0 codigo=persistencia');
            if (erro.codigo === 'RF02_RATE_LIMIT_INFRA') throw erro;
            const indisponivel = new Error('Rate-limit temporariamente indisponível.');
            indisponivel.codigo = 'RF02_RATE_LIMIT_INFRA';
            throw indisponivel;
        } finally {
            if (conexao) conexao.release();
        }
    }

    async function limitarSolicitacao({ ip, email }) {
        const emailNormalizado = normalizarEmail(email);
        const ipNormalizado = String(ip || 'desconhecido');
        return aplicar([
            { escopo: 'solicitacao_ip_15m', valor: ipNormalizado, limite: 5, duracaoMs: 15 * MINUTO_MS },
            { escopo: 'solicitacao_email_1h', valor: emailNormalizado, limite: 3, duracaoMs: 60 * MINUTO_MS },
            // Fixed-window de 1/minuto: duas chamadas no limite entre janelas podem
            // ocorrer com menos de 60 s de intervalo. Isto NÃO é um cooldown estrito.
            { escopo: 'solicitacao_email_60s', valor: emailNormalizado, limite: 1, duracaoMs: MINUTO_MS }
        ]);
    }

    async function limitarConfirmacao({ ip }) {
        return aplicar([
            { escopo: 'confirmacao_ip_15m', valor: String(ip || 'desconhecido'), limite: 20, duracaoMs: 15 * MINUTO_MS }
        ]);
    }

    async function limparExpirados() {
        // Limite operacional por ciclo para evitar deletes longos; ciclos seguintes
        // continuam a drenagem. Buckets vencidos não representam tokens ativos.
        await db.query(
            `DELETE FROM rf02_rate_limit WHERE expira_em <= ? LIMIT ${LIMITE_DELETE_RATE_LIMIT}`,
            [dataMysql(agora())]
        );
    }

    return { limitarSolicitacao, limitarConfirmacao, limparExpirados, normalizarEmail };
}

module.exports = { criarRecuperacaoSenhaRateLimitService, INFO_RATE_LIMIT, LIMITE_DELETE_RATE_LIMIT };
