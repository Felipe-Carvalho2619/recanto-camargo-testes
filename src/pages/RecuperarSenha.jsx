import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePreferencias } from '../hooks/usePreferencias';
import { Form } from 'react-bootstrap';
import LayoutAutenticacao from '../components/UI/LayoutAutenticacao';
import Entrada from '../components/UI/Entrada';
import EntradaSenha from '../components/UI/EntradaSenha';
import Botao from '../components/UI/Botao';
import LinkAutenticacao from '../components/UI/LinkAutenticacao';
import { API_BASE, IS_API_AVAILABLE } from '../utils/api';
import logoPng from '../assets/img/artes/logo.webp';
import basilicaPng from '../assets/img/artes/basilica.webp';

const TEMPO_LIMITE_MS = 10_000;

const REGRAS_SENHA = [
  {
    teste: senha => senha.length >= 8 && senha.length <= 100,
    mensagem: 'A senha deve ter entre 8 e 100 caracteres.',
  },
  {
    teste: senha => /[A-Z]/.test(senha),
    mensagem: 'A senha deve conter pelo menos uma letra maiúscula.',
  },
  {
    teste: senha => /[a-z]/.test(senha),
    mensagem: 'A senha deve conter pelo menos uma letra minúscula.',
  },
  {
    teste: senha => /\d/.test(senha),
    mensagem: 'A senha deve conter pelo menos um número.',
  },
  {
    teste: senha => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(senha),
    mensagem: 'A senha deve conter pelo menos um caractere especial (!@#$%...).',
  },
];

function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function RecuperarSenha() {
  const { t } = usePreferencias();
  const location = useLocation();
  const navigate = useNavigate();

  // O token é capturado uma única vez; a query é removida pelo efeito abaixo.
  const [token, setToken] = useState(() => new URLSearchParams(location.search).get('token') || '');
  const [modo, setModo] = useState(() => (token ? 'redefinicao' : 'solicitacao'));
  const [dados, setDados] = useState({ email: '', novaSenha: '', confirmar: '' });
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');

  const carregandoRef = useRef(false);
  const controladorRef = useRef(null);
  const montadoRef = useRef(true);

  useEffect(() => {
    if (location.search) {
      navigate({ pathname: location.pathname, search: '' }, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      carregandoRef.current = false;
      controladorRef.current?.abort();
    };
  }, []);

  const limparFeedback = () => {
    setErro('');
    setSucesso('');
  };

  const handleChange = event => {
    const { name, value } = event.target;
    setDados(anterior => ({ ...anterior, [name]: value }));
    limparFeedback();
  };

  const realizarChamada = async (caminho, corpo) => {
    if (!IS_API_AVAILABLE) return { tipo: 'indisponivel' };

    const controlador = new AbortController();
    controladorRef.current = controlador;
    let expirou = false;
    const timeout = window.setTimeout(() => {
      expirou = true;
      controlador.abort();
    }, TEMPO_LIMITE_MS);

    try {
      const resposta = await fetch(`${API_BASE}${caminho}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(corpo),
        signal: controlador.signal,
      });
      // A API pode responder sem corpo; JSON ausente ou inválido não altera o status HTTP.
      const corpoResposta = await resposta.json().catch(() => null);
      const retryAfterBruto = resposta.headers.get('Retry-After')?.trim() || '';
      const retryAfterNumerico = /^\d+$/.test(retryAfterBruto) ? Number(retryAfterBruto) : null;
      const retryAfter = Number.isSafeInteger(retryAfterNumerico) && retryAfterNumerico > 0
        ? retryAfterNumerico
        : null;
      return { tipo: 'http', status: resposta.status, dados: corpoResposta, retryAfter };
    } catch (falha) {
      if (falha?.name === 'AbortError' && expirou) return { tipo: 'timeout' };
      return { tipo: 'rede' };
    } finally {
      window.clearTimeout(timeout);
      if (controladorRef.current === controlador) controladorRef.current = null;
    }
  };

  const mensagemFalhaComunicacao = resultado => {
    if (resultado.tipo === 'indisponivel') {
      return t('Serviço de recuperação indisponível no momento.');
    }
    if (resultado.tipo === 'timeout') {
      return t('O servidor demorou para responder. Tente novamente.');
    }
    return t('Não foi possível conectar ao servidor. Tente novamente.');
  };

  const mensagemEspera = resultado => {
    if (!resultado.retryAfter) {
      return t('Não foi possível processar a solicitação agora. Aguarde antes de tentar novamente.');
    }
    const unidade = resultado.retryAfter === 1 ? 'segundo' : 'segundos';
    return t(`Não foi possível processar a solicitação agora. Aguarde ${resultado.retryAfter} ${unidade} antes de tentar novamente.`);
  };

  const handleSolicitar = async event => {
    event.preventDefault();
    if (carregandoRef.current) return;

    const email = dados.email.trim();
    limparFeedback();
    if (!validarEmail(email)) {
      setErro(t('Email inválido.'));
      return;
    }

    carregandoRef.current = true;
    setCarregando(true);
    try {
      const resultado = await realizarChamada('/api/usuarios/recuperacao-senha', { email });
      if (!montadoRef.current) return;

      if (resultado.tipo === 'http') {
        if (resultado.status === 202) {
          setSucesso(t('Se o e-mail pertencer a uma conta elegível, enviaremos instruções. Verifique também a caixa de spam e evite solicitar outro link imediatamente.'));
        } else if (resultado.status === 429) {
          setErro(mensagemEspera(resultado));
        } else if (resultado.status === 503) {
          setErro(t('Serviço temporariamente indisponível. Tente novamente mais tarde.'));
        } else {
          setErro(t('Não foi possível solicitar a recuperação agora. Tente novamente.'));
        }
      } else {
        setErro(mensagemFalhaComunicacao(resultado));
      }
    } catch {
      if (montadoRef.current) {
        setErro(t('Não foi possível solicitar a recuperação agora. Tente novamente.'));
      }
    } finally {
      if (montadoRef.current) {
        carregandoRef.current = false;
        setCarregando(false);
      }
    }
  };

  const handleRedefinir = async event => {
    event.preventDefault();
    if (carregandoRef.current) return;

    limparFeedback();
    if (!token) {
      setModo('tokenInvalido');
      setDados(anterior => ({ ...anterior, novaSenha: '', confirmar: '' }));
      return;
    }
    if (dados.novaSenha !== dados.confirmar) {
      setErro(t('Senhas não coincidem.'));
      return;
    }
    const falhaValidacao = REGRAS_SENHA.find(regra => !regra.teste(dados.novaSenha));
    if (falhaValidacao) {
      setErro(t(falhaValidacao.mensagem));
      return;
    }

    carregandoRef.current = true;
    setCarregando(true);
    try {
      const resultado = await realizarChamada('/api/usuarios/recuperacao-senha/confirmar', {
        token,
        novaSenha: dados.novaSenha,
      });
      if (!montadoRef.current) return;

      if (resultado.tipo === 'http') {
        if (resultado.status === 200) {
          setToken('');
          setDados(anterior => ({ ...anterior, novaSenha: '', confirmar: '' }));
          setModo('sucesso');
        } else if (resultado.status === 400 && resultado.dados?.code === 'POLITICA_SENHA') {
          // Somente este código autoriza exibir a mensagem segura fornecida pelo backend.
          const mensagemSegura = [
            resultado.dados?.error,
            resultado.dados?.message,
            resultado.dados?.mensagem,
          ].find(mensagem => typeof mensagem === 'string' && mensagem.trim());
          setErro(mensagemSegura || t('Não foi possível redefinir a senha. Tente novamente.'));
        } else if (resultado.status === 400 && resultado.dados?.code === 'TOKEN_INVALIDO') {
          setToken('');
          setDados(anterior => ({ ...anterior, novaSenha: '', confirmar: '' }));
          setModo('tokenInvalido');
        } else if (resultado.status === 429) {
          setErro(mensagemEspera(resultado));
        } else if (resultado.status === 503) {
          setErro(t('Serviço temporariamente indisponível. Tente novamente mais tarde.'));
        } else {
          setErro(t('Não foi possível redefinir a senha. Tente novamente.'));
        }
      } else {
        setErro(mensagemFalhaComunicacao(resultado));
      }
    } catch {
      if (montadoRef.current) {
        setErro(t('Não foi possível redefinir a senha. Tente novamente.'));
      }
    } finally {
      if (montadoRef.current) {
        carregandoRef.current = false;
        setCarregando(false);
      }
    }
  };

  const solicitarNovoLink = () => {
    setToken('');
    setDados(anterior => ({ ...anterior, novaSenha: '', confirmar: '' }));
    limparFeedback();
    setModo('solicitacao');
  };

  const renderFeedback = () => (
    <>
      {erro && <div className="alerta-erro mb-3" role="alert" aria-atomic="true">{erro}</div>}
      {sucesso && <div className="sucesso-msg mb-3" role="status" aria-atomic="true">{sucesso}</div>}
    </>
  );

  const renderConteudo = () => {
    if (modo === 'sucesso') {
      return (
        <div className="sucesso-msg" role="status" aria-atomic="true">
          <i className="bi bi-check-circle-fill fs-1 text-success mb-3" aria-hidden="true"></i>
          <h2 className="h4">{t('Senha redefinida com sucesso!')}</h2>
          <p className="text-white-50">{t('Faça login com sua nova senha.')}</p>
          <LinkAutenticacao para="/Login" variante="destaque" className="btn-sucesso">
            {t('Ir para o Login')}
          </LinkAutenticacao>
        </div>
      );
    }

    if (modo === 'tokenInvalido') {
      return (
        <div>
          <div className="alerta-erro mb-3" role="alert" aria-atomic="true">
            {t('Este link de recuperação é inválido, já foi usado ou expirou.')}
          </div>
          <Botao larguraTotal tipo="button" onClick={solicitarNovoLink}>
            {t('Solicitar novo link')}
          </Botao>
          <div className="text-center mt-3">
            <LinkAutenticacao para="/Login" variante="secundario">
              {t('Voltar ao Login')}
            </LinkAutenticacao>
          </div>
        </div>
      );
    }

    const redefinicao = modo === 'redefinicao';
    return (
      <Form
        onSubmit={redefinicao ? handleRedefinir : handleSolicitar}
        aria-busy={carregando}
        noValidate
      >
        {renderFeedback()}
        {redefinicao ? (
          <>
            <EntradaSenha
              nome="novaSenha"
              placeholder={t('Nova senha')}
              valor={dados.novaSenha}
              onChange={handleChange}
              autoComplete="new-password"
              minLength={8}
              maxLength={100}
              disabled={carregando}
              required
            />
            <EntradaSenha
              nome="confirmar"
              placeholder={t('Confirmar nova senha')}
              valor={dados.confirmar}
              onChange={handleChange}
              autoComplete="new-password"
              minLength={8}
              maxLength={100}
              disabled={carregando}
              required
            />
            <small className="text-white-50 d-block mb-3">
              {t('Entre 8 e 100 caracteres, com maiúscula, minúscula, número e símbolo especial (!@#$%).')}
            </small>
            <Botao larguraTotal tipo="submit" disabled={carregando}>
              {carregando ? t('Redefinindo...') : t('Redefinir Senha')}
            </Botao>
          </>
        ) : (
          <>
            <Entrada
              tipo="email"
              nome="email"
              placeholder={t('Seu email cadastrado')}
              valor={dados.email}
              onChange={handleChange}
              autoComplete="email"
              disabled={carregando}
              required
            />
            <Botao larguraTotal tipo="submit" disabled={carregando}>
              {carregando ? t('Enviando...') : t('Enviar link de recuperação')}
            </Botao>
          </>
        )}
        <div className="text-center mt-3">
          <LinkAutenticacao para="/Login" variante="secundario">
            {t('Voltar ao Login')}
          </LinkAutenticacao>
        </div>
      </Form>
    );
  };

  const titulo = modo === 'sucesso'
    ? t('Sucesso!')
    : modo === 'redefinicao'
      ? t('Redefinir Senha')
      : t('Recuperar Senha');
  const subtitulo = modo === 'sucesso' || modo === 'tokenInvalido'
    ? ''
    : modo === 'redefinicao'
      ? t('Digite e confirme sua nova senha.')
      : t('Digite seu email para receber instruções de recuperação.');

  return (
    <LayoutAutenticacao
      imagemFundo={basilicaPng}
      imagemLogo={logoPng}
      titulo={titulo}
      subtitulo={subtitulo}
      mostrarBotaoVoltar={modo !== 'sucesso'}
    >
      {renderConteudo()}
    </LayoutAutenticacao>
  );
}

export default RecuperarSenha;
