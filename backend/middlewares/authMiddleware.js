const db = require('../config/db');
const { criarSessionService } = require('../services/sessionService');
const { opcoesCookieSessao } = require('../utils/configuracaoWeb');

const sessionServicePadrao = criarSessionService({ db });

function obterSessionService(req) {
    const injetado = req.app?.get ? req.app.get('sessionService') : null;
    return injetado || sessionServicePadrao;
}

const verificarToken = async (req, res, next) => {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Acesso negado. Faça login para continuar.' });

    try {
        const resultado = await obterSessionService(req).validarTokenSessao(token);
        if (resultado.motivo === 'indisponivel') {
            return res.status(503).json({ error: 'Sessão temporariamente indisponível.' });
        }
        if (resultado.motivo === 'usuario_inativo') {
            res.clearCookie('token', opcoesCookieSessao());
            return res.status(403).json({ error: 'Conta inativa ou bloqueada.' });
        }
        if (!resultado.ok) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
        req.usuario = resultado.usuario;
        return next();
    } catch {
        return res.status(503).json({ error: 'Sessão temporariamente indisponível.' });
    }
};

const verificarProprietario = (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'Acesso negado.' });

    if (req.usuario.tipo !== 'proprietario') {
        return res.status(403).json({ error: 'Acesso negado. Esta área é restrita aos proprietários.' });
    }

    next();
};

module.exports = {
    verificarToken,
    verificarProprietario
};
