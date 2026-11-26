const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');
const { verificarToken } = require('../middlewares/authMiddleware');

const emTeste = () => process.env.NODE_ENV === 'test';

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true, // só tentativas que falham contam: trocar de conta não bloqueia o login
    skip: emTeste,
    message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
});

const cadastroLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    skip: emTeste,
    message: { error: 'Muitas tentativas de cadastro a partir deste endereço. Tente novamente mais tarde.' }
});

const senhaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skip: emTeste,
    message: { error: 'Muitas tentativas de alteração de senha. Tente novamente em 15 minutos.' }
});

router.post('/cadastro', cadastroLimiter, authController.cadastrar);
router.post('/login', loginLimiter, authController.login);
router.get('/sessao', authController.sessao);
router.post('/logout', authController.logout);

router.post('/recuperacao-senha', authController.solicitarRecuperacaoSenha);
router.post('/recuperacao-senha/confirmar', authController.confirmarRecuperacaoSenha);

router.get('/perfil', verificarToken, authController.obterPerfil);
router.put('/perfil', verificarToken, authController.atualizarPerfil);
router.put('/senha', verificarToken, senhaLimiter, authController.alterarSenha);

module.exports = router;
