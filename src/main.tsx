import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './ui/App.tsx';
import { fitView, installKeys } from './commands.ts';
import { startAutosave } from './files.ts';
import { redraw } from './store.ts';
import { setImageLoadHandler } from './render.ts';

installKeys();
setImageLoadHandler(redraw);
createRoot(document.getElementById('root')!).render(<App />);
startAutosave(fitView);
