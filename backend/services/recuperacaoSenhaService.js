const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { emailValido } = require('../utils/validacoes');
const { validarComplexidadeSenha } = require('../utils/politicaSenha');

const TTL_RECUPERACAO_MS = 10 * 60 * 1000;
const ATRASO_INICIAL_OUTBOX_MS = 2000;
const PREFIXO_TOKEN = Buffer.from('rf02-token-v1\0', 'utf8');

function criarErro(codigo, mensagem) {
    const erro = new Error(mensagem);
    erro.codigo = codigo;
    return erro;
}

function erroTokenInvalido() {
    return criarErro('TOKEN_INVALIDO', 'Link de recuperação inválido ou expirado.');
}

function dataMysql(data) {
    return data.toISOString().slice(0, 23).replace('T', ' ');
}

function decodificarBase64Url32(valor) {
    if (typeof valor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(valor)) return null;
    const decodificado = Buffer.from(valor, 'base64url');
    if (decodificado.length !== 32 || decodificado.toString('base64url') !== valor) return null;
    return decodificado;
}

function compararBytes(a, b) {
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === 32 && b.length === 32
        && crypto.timingSafeEqual(a, b);
}

function criarRecuperacaoSenhaService({
    db,
    env = process.env,
    logger = console,
    clock = { now: () => Date.now() },
    random = crypto.randomBytes,
    randomBytes = random,
    secret,
    bcryptLibrary = bcrypt
} = {}) {
    function agora() {
        const valor = typeof clock === 'function' ? clock() : clock.now();
        return valor instanceof Date ? new Date(valor.getTime()) : new Date(valor);
    }

    function obterSegredo() {
        const valor = secret !== undefined ? secret : env.RF02_RESET_SECRET;
        const decodificado = decodificarBase64Url32(valor);
        if (!decodificado) {
            throw criarErro('RF02_CONFIG', 'Configuração global de recuperação indisponível.');
        }
        return decodificado;
    }

    function obterFrontendUrl() {
        const bruto = typeof env.FRONTEND_URL === 'string' ? env.FRONTEND_URL.trim() : '';
        let url;
        try {
            url = new URL(bruto);
        } catch {
            throw criarErro('RF02_CONFIG', 'Configuração global de recuperação indisponível.');
        }
        const producao = env.NODE_ENV === 'production';
        if (!['http:', 'https:'].includes(url.protocol) || (producao && url.protocol !== 'https:')
            || url.username || url.password) {
            throw criarErro('RF02_CONFIG', 'Configuração global de recuperação indisponível.');
        }
        return bruto.replace(/\/$/, '');
    }

    function validarConfiguracaoGlobal() {
        obterSegredo();
        obterFrontendUrl();
        if (env.NODE_ENV === 'production' && typeof env.RESEND_OVERRIDE_EMAIL === 'string'
            && env.RESEND_OVERRIDE_EMAIL.trim()) {
            throw criarErro('OVERRIDE_PRODUCAO', 'Recuperação bloqueada por configuração global.');
        }
        return true;
    }

    function reconstruirTokenBruto(nonce) {
        const nonceBuffer = Buffer.isBuffer(nonce) ? nonce : Buffer.from(nonce);
        if (nonceBuffer.length !== 32) throw criarErro('RF02_CONFIG', 'Nonce de recuperação inválido.');
        return crypto.createHmac('sha256', obterSegredo())
            .update(Buffer.concat([PREFIXO_TOKEN, nonceBuffer]))
            .digest();
    }

    function reconstruirToken(nonce) {
        return reconstruirTokenBruto(nonce).toString('base64url');
    }

    function hashTokenBruto(tokenBruto) {
        if (!Buffer.isBuffer(tokenBruto) || tokenBruto.length !== 32) throw erroTokenInvalido();
        return crypto.createHash('sha256').update(tokenBruto).digest();
    }

    function decodificarToken(token) {
        const tokenBruto = decodificarBase64Url32(token);
        if (!tokenBruto) throw erroTokenInvalido();
        return tokenBruto;
    }

    function hashToken(token) {
        return hashTokenBruto(decodificarToken(token));
    }

    function tokenConfereComNonce(tokenBruto, nonce) {
        return compararBytes(tokenBruto, reconstruirTokenBruto(nonce));
    }

    function criarChaveIdempotencia(nonce) {
        return `rf02/${Buffer.from(nonce).toString('hex')}`;
    }

    async function rollbackSeguro(conexao) {
        if (conexao) await conexao.rollback().catch(() => {});
    }

    async function solicitar({ email }) {
        validarConfiguracaoGlobal();
        const emailLimpo = typeof email === 'string' ? email.trim() : '';
        if (!emailValido(emailLimpo)) throw criarErro('ENTRADA_INVALIDA', 'E-mail inválido.');

        const nonce = randomBytes(32);
        if (!Buffer.isBuffer(nonce) || nonce.length !== 32) {
            throw criarErro('RF02_ENTROPIA', 'Não foi possível gerar o desafio.');
        }
        const tokenBruto = reconstruirTokenBruto(nonce);
        const tokenHash = hashTokenBruto(tokenBruto);
        const criado = agora();
        if (Number.isNaN(criado.getTime())) throw criarErro('RF02_CLOCK', 'Relógio indisponível.');
        const expira = new Date(criado.getTime() + TTL_RECUPERACAO_MS);
        const proximaTentativa = new Date(criado.getTime() + ATRASO_INICIAL_OUTBOX_MS);
        const criadoMysql = dataMysql(criado);

        let conexao;
        try {
            conexao = await db.getConnection();
            await conexao.beginTransaction();
            const [usuarios] = await conexao.query(
                'SELECT Usu_Id FROM usu_usuario WHERE Usu_Email = ? AND Usu_Status = ? LIMIT 1',
                [emailLimpo, 'ATIVO']
            );
            const usuarioId = usuarios.length === 1 ? usuarios[0].Usu_Id : null;

            // A linha neutra para e-mail desconhecido/inativo reduz diferenças observáveis
            // (anti-enumeração). Não contém e-mail nem IP e segue a retenção curta do worker.
            await conexao.query(
                `INSERT INTO rf02_recuperacao_senha
                 (usuario_id, nonce, token_hash, criado_em, expira_em, email_estado,
                  tentativas, proxima_tentativa_em, atualizado_em)
                 VALUES (?, ?, ?, ?, ?, 'PENDENTE', 0, ?, ?)`,
                [usuarioId, nonce, tokenHash, criadoMysql, dataMysql(expira), dataMysql(proximaTentativa), criadoMysql]
            );
            // O primeiro claim só fica elegível após a resposta ao commit; retries
            // futuros alteram proxima_tentativa_em, nunca expira_em.
            await conexao.commit();
        } catch (erro) {
            await rollbackSeguro(conexao);
            throw erro;
        } finally {
            if (conexao) conexao.release();
        }
    }

    async function confirmar({ token, novaSenha }) {
        validarConfiguracaoGlobal();
        const erroSenha = validarComplexidadeSenha(novaSenha);
        if (erroSenha) {
            const erro = criarErro('POLITICA_SENHA', 'Nova senha fora da política.');
            erro.mensagemPublica = erroSenha;
            throw erro;
        }

        const tokenBruto = decodificarToken(token);
        const tokenHash = hashTokenBruto(tokenBruto);
        const [preliminares] = await db.query(
            'SELECT id, usuario_id, nonce FROM rf02_recuperacao_senha WHERE token_hash = ? LIMIT 1',
            [tokenHash]
        );
        const preliminar = preliminares[0];
        if (!preliminar || preliminar.usuario_id === null
            || !tokenConfereComNonce(tokenBruto, preliminar.nonce)) {
            throw erroTokenInvalido();
        }

        const salt = await bcryptLibrary.genSalt(10);
        const novoHash = await bcryptLibrary.hash(novaSenha, salt);

        let conexao;
        try {
            conexao = await db.getConnection();
            await conexao.beginTransaction();

            const [usuarios] = await conexao.query(
                'SELECT Usu_Id FROM usu_usuario WHERE Usu_Id = ? AND Usu_Status = ? LIMIT 1 FOR UPDATE',
                [preliminar.usuario_id, 'ATIVO']
            );
            if (usuarios.length !== 1) throw erroTokenInvalido();

            const atual = agora();
            const atualMysql = dataMysql(atual);
            const [tokens] = await conexao.query(
                `SELECT id, nonce FROM rf02_recuperacao_senha
                 WHERE id = ? AND token_hash = ? AND usuario_id = ?
                   AND consumido_em IS NULL AND invalidado_em IS NULL AND expira_em > ?
                 LIMIT 1 FOR UPDATE`,
                [preliminar.id, tokenHash, preliminar.usuario_id, atualMysql]
            );
            if (tokens.length !== 1 || !tokenConfereComNonce(tokenBruto, tokens[0].nonce)) {
                throw erroTokenInvalido();
            }

            const [resultadoSenha] = await conexao.query(
                'UPDATE usu_usuario SET Usu_SenhaHash = ? WHERE Usu_Id = ?',
                [novoHash, preliminar.usuario_id]
            );
            if (resultadoSenha.affectedRows !== 1) {
                throw criarErro('RF02_TRANSACAO', 'Não foi possível atualizar a senha.');
            }

            const [resultadoConsumo] = await conexao.query(
                `UPDATE rf02_recuperacao_senha
                 SET consumido_em = ?, processando_ate = NULL, atualizado_em = ?,
                     email_estado = IF(email_estado IN ('PENDENTE', 'PROCESSANDO'), 'DESCARTADA', email_estado)
                 WHERE id = ? AND token_hash = ? AND consumido_em IS NULL
                   AND invalidado_em IS NULL AND expira_em > ?`,
                [atualMysql, atualMysql, preliminar.id, tokenHash, atualMysql]
            );
            if (resultadoConsumo.affectedRows !== 1) throw erroTokenInvalido();

            await conexao.query(
                `UPDATE rf02_recuperacao_senha
                 SET invalidado_em = ?, processando_ate = NULL, atualizado_em = ?,
                     email_estado = IF(email_estado IN ('PENDENTE', 'PROCESSANDO'), 'DESCARTADA', email_estado)
                 WHERE usuario_id = ? AND id <> ? AND consumido_em IS NULL AND invalidado_em IS NULL`,
                [atualMysql, atualMysql, preliminar.usuario_id, preliminar.id]
            );

            await conexao.commit();
        } catch (erro) {
            await rollbackSeguro(conexao);
            throw erro;
        } finally {
            if (conexao) conexao.release();
        }
    }

    return {
        solicitar,
        confirmar,
        validarConfiguracaoGlobal,
        obterFrontendUrl,
        reconstruirTokenBruto,
        reconstruirToken,
        decodificarToken,
        hashTokenBruto,
        hashToken,
        criarChaveIdempotencia,
        agora,
        dataMysql
    };
}

module.exports = {
    criarRecuperacaoSenhaService,
    TTL_RECUPERACAO_MS,
    ATRASO_INICIAL_OUTBOX_MS,
    dataMysql,
    decodificarBase64Url32
};
