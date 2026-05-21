import React from 'react';
import ReactDOM from 'react-dom/client';

const App: React.FC = () => (
  <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
    <h1>Synth UI</h1>
    <p>Synth UI package placeholder. Будет перенесён из synth-ui/.</p>
  </div>
);

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
