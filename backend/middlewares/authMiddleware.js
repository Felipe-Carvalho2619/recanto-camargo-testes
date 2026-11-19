const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { opcoesCookieSessao } = require('../utils/configuracaoWeb');

const verificarToken = async (req, res, next) => {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Acesso negado. Faça login para continuar.' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [rows] = await db.query(
            'SELECT Usu_Status FROM usu_usuario WHERE Usu_Id = ? LIMIT 1',
            [decoded.id]
        );
        if (!rows || rows.length === 0 || rows[0].Usu_Status !== 'ATIVO') {
            res.clearCookie('token', opcoesCookieSessao());
            return res.status(403).json({ error: 'Conta inativa ou bloqueada.' });
        }
        req.usuario = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }
};

const verificarProprietario = (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'Acesso negado.' });
    
    if (req.usuario.tipo !== 'proprietario') {
        return res.status(403).json({ error: 'Acesso negado. Esta área é restrita aos proprietários.' });
    }
    
    next(); 
};

// Se precisar do verificarUsuarioAtivoNotificacoes, importaremos o db aqui, mas por enquanto:
module.exports = {
    verificarToken,
    verificarProprietario
};
