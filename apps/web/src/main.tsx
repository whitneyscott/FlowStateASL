import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { DebugProvider } from './contexts/DebugContext';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <DebugProvider>
        <App />
      </DebugProvider>
    </BrowserRouter>
  </React.StrictMode>
);
