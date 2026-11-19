import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import './LinkAutenticacao.css';

function LinkAutenticacao({ 
  para, 
  children, 
  variante = 'primario',
  className = '',
  ...props 
}) {
  const relSeguro = props.target === '_blank' ? (props.rel || 'noopener noreferrer') : props.rel;
  return (
    <Link
      to={para}
      className={`link-autenticacao link-${variante} ${className}`}
      {...props}
      rel={relSeguro}
    >
      {children}
    </Link>
  );
}

LinkAutenticacao.propTypes = {
  para: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
  variante: PropTypes.oneOf(['primario', 'secundario', 'destaque']),
  className: PropTypes.string,
};

export default LinkAutenticacao;