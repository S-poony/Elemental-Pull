import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../game';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the offline worker in production only — in dev it would sit in
// front of Vite's module graph and serve stale modules past an edit.
// BASE_URL carries the GitHub Pages subpath, and a worker can only control
// pages at or below its own path, so both the URL and the scope have to be
// built from it rather than hardcoded to '/'.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        // An unavailable worker costs offline play and nothing else, so a
        // failure here must never take the game down with it.
      });
  });
}
