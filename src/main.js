import { Game } from './core/Game.js';
import { UI } from './ui/UI.js';

const game = new Game(document.getElementById('game-canvas'));
const ui = new UI(game);

// Debug/verification hook (harmless in production, used by automated tests).
window.__game = game;
window.__ui = ui;
