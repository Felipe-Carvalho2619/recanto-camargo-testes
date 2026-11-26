function validarComplexidadeSenha(senha) {
    if (!senha || typeof senha !== 'string') {
        return 'Senha inválida.';
    }
    if (senha.length < 8) {
        return 'A senha deve ter no mínimo 8 caracteres.';
    }
    if (senha.length > 100) {
        return 'A senha não pode exceder 100 caracteres.';
    }
    if (!/[A-Z]/.test(senha)) {
        return 'A senha deve conter pelo menos uma letra maiúscula.';
    }
    if (!/[a-z]/.test(senha)) {
        return 'A senha deve conter pelo menos uma letra minúscula.';
    }
    if (!/\d/.test(senha)) {
        return 'A senha deve conter pelo menos um número.';
    }
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(senha)) {
        return 'A senha deve conter pelo menos um caractere especial (!@#$%...).';
    }
    return null;
}

module.exports = { validarComplexidadeSenha };
