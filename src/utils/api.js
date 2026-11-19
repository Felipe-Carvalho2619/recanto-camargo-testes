/**
 * Utilitário central de configuração da API do Recanto Camargo.
 * - Na Vercel (.vercel.app), utiliza caminho relativo (/api/...) roteado pelo proxy reverso (vercel.json),
 *   garantindo First-Party Cookies e evitando bloqueio de sessão em navegadores como Samsung Internet, Safari e Brave.
 * - Em localhost, aponta para http://localhost:3000.
 * - Em produção estática (ex: GitHub Pages) sem backend remoto configurado, retorna vazio.
 */

const isVercelHost = () =>
  typeof window !== 'undefined' && window.location.hostname.endsWith('.vercel.app');

export function getApiBaseUrl() {
  // Na Vercel, sempre usa a mesma origem (/api/...) via rewrite do vercel.json
  // para evitar bloqueio de cookies de terceiros entre domínios distintos.
  if (isVercelHost()) {
    return '';
  }

  // Se houver uma variável de ambiente definida no build (.env / CI/CD)
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL.replace(/\/$/, '');
  }

  // Verifica se está rodando localmente (desenvolvimento / teste)
  const isLocal = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname.endsWith('.local')
  );

  if (isLocal) {
    return 'http://localhost:3000';
  }

  // Em produção estática (GitHub Pages) sem backend remoto configurado,
  // retorna vazio para evitar que o navegador acione Private Network Access (PNA)
  return '';
}

export const API_BASE = getApiBaseUrl();
export const IS_API_AVAILABLE = Boolean(API_BASE) || isVercelHost();
