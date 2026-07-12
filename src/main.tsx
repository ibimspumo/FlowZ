import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initializeLocale } from './i18n';

initializeLocale();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
