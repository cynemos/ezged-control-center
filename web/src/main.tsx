import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { BASE_PATH } from './api';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={BASE_PATH || undefined}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
