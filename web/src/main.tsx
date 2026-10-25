// Глобальные стили — до компонентов: в бандле CSS идёт в порядке импортов, и правила модулей (.qsend поверх .row)
// должны стоять после base.css, как в ui/style.css.
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
