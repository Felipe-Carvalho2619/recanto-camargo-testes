import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { ContextoAutenticacao } from './context/ContextoAutenticacao'
import { ContextoPreferencias } from './context/ContextoPreferencias'

/* ── Arquitetura de Estilos: Camada de Fundação Global ── */
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/typography.css';
import './styles/components.css';
import './CSS/style.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ContextoPreferencias>
      <ContextoAutenticacao>
        <App />
      </ContextoAutenticacao>
    </ContextoPreferencias>
  </React.StrictMode>,
)
