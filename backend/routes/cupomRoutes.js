const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const cupomController = require('../controllers/cupomController');
const { verificarToken } = require('../middlewares/authMiddleware');

const cupomLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: 'Muitas tentativas de validação de cupom. Aguarde alguns minutos.' }
});

router.get('/meus', verificarToken, cupomController.listarMeus);
router.post('/validar', verificarToken, cupomLimiter, cupomController.validar);

module.exports = router;
