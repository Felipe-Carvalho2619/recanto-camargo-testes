const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const INFO_EPOCA = 'rf02/session-epoch/v1';
const EXPIRACAO_SESSAO = '24h';

function erroConfiguracao() {
    const erro = new Error('Configuração de sessão indisponível.');
    erro.codigo = 'SESSAO_CONFIG';
    return erro;
}

function criarSessionService({ db, env = process.env, secret, jwtLibrary = jwt, logger = console } = {}) {
    function obterSegredo() {
        const valor = secret !== undefined ? secret : env.JWT_SECRET;
        if ((typeof valor !== 'string' && !Buffer.isBuffer(valor)) || valor.length === 0) {
            throw erroConfiguracao();
        }
        return valor;
    }

    function derivarChaveEpoca() {
        return crypto.hkdfSync(
            'sha256',
            Buffer.from(obterSegredo()),
            Buffer.alloc(0),
            Buffer.from(INFO_EPOCA, 'utf8'),
            32
        );
    }

    function calcularEpoca(senhaHash) {
        if (typeof senhaHash !== 'string' || !senhaHash) throw erroConfiguracao();
        return crypto.createHmac('sha256', derivarChaveEpoca())
            .update(senhaHash, 'utf8')
            .digest('base64url');
    }

    function dtoPublico(usuario) {
        return {
            id: Number(usuario.id),
            nome: usuario.nome,
            tipo: usuario.tipo
        };
    }

    function validarConfiguracao() {
        obterSegredo();
    }

    function criarTokenSessao(usuario, senhaHash) {
        const publico = dtoPublico(usuario);
        const token = jwtLibrary.sign(
            { ...publico, se: calcularEpoca(senhaHash) },
            obterSegredo(),
            { expiresIn: EXPIRACAO_SESSAO }
        );
        return { token, usuario: publico };
    }

    function epocasIguais(recebida, esperada) {
        const a = Buffer.from(String(recebida || ''), 'utf8');
        const b = Buffer.from(esperada, 'utf8');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    async function validarTokenSessao(token) {
        let segredo;
        try {
            segredo = obterSegredo();
        } catch {
            return { ok: false, motivo: 'indisponivel' };
        }

        let decoded;
        try {
            decoded = jwtLibrary.verify(token, segredo);
        } catch {
            return { ok: false, motivo: 'invalida' };
        }

        if (!decoded || !Number.isSafeInteger(Number(decoded.id)) || Number(decoded.id) <= 0
            || typeof decoded.se !== 'string' || !decoded.se) {
            return { ok: false, motivo: 'invalida' };
        }

        let usuarios;
        try {
            [usuarios] = await db.query(
                `SELECT usu.Usu_Id, usu.Usu_Nome, usu.Usu_Status, usu.Usu_SenhaHash,
                        CASE WHEN EXISTS (
                            SELECT 1 FROM pro_proprietario AS pro
                            WHERE pro.Usu_Id = usu.Usu_Id
                        ) THEN 'proprietario' ELSE 'hospede' END AS Usu_Tipo
                 FROM usu_usuario AS usu
                 WHERE usu.Usu_Id = ? LIMIT 1`,
                [Number(decoded.id)]
            );
        } catch {
            logger.error('[Sessão] Indisponibilidade ao validar persistência.');
            return { ok: false, motivo: 'indisponivel' };
        }

        const usuario = usuarios[0];
        if (!usuario || usuario.Usu_Status !== 'ATIVO') {
            return { ok: false, motivo: 'usuario_inativo' };
        }
        if (typeof usuario.Usu_SenhaHash !== 'string') {
            return { ok: false, motivo: 'invalida' };
        }

        let epocaEsperada;
        try {
            epocaEsperada = calcularEpoca(usuario.Usu_SenhaHash);
        } catch {
            return { ok: false, motivo: 'indisponivel' };
        }

        if (!epocasIguais(decoded.se, epocaEsperada)) {
            return { ok: false, motivo: 'invalida' };
        }

        const idAtual = Number(usuario.Usu_Id);
        if (!Number.isSafeInteger(idAtual) || idAtual !== Number(decoded.id)
            || typeof usuario.Usu_Nome !== 'string'
            || !['hospede', 'proprietario'].includes(usuario.Usu_Tipo)) {
            return { ok: false, motivo: 'indisponivel' };
        }

        return {
            ok: true,
            usuario: dtoPublico({
                id: idAtual,
                nome: usuario.Usu_Nome,
                tipo: usuario.Usu_Tipo
            })
        };
    }

    return {
        validarConfiguracao,
        calcularEpoca,
        criarTokenSessao,
        validarTokenSessao
    };
}

module.exports = { criarSessionService, INFO_EPOCA, EXPIRACAO_SESSAO };
