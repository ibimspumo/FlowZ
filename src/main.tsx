import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initializeLocale } from './i18n';
import { RecoveryBoundary } from './components/RecoveryBoundary';

initializeLocale();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecoveryBoundary scope="app">
      <App />
    </RecoveryBoundary>
  </StrictMode>,
);
