import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@wundercorp/baseui/styles.css';
import './styles.css';
import './dashboard.css';
import './baseui-showcase.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
