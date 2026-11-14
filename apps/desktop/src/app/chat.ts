/* The chat view, a placeholder until step 11. Everything it draws is text. */
import { createShell } from '../shell.ts';

const shell = createShell();
const p = document.createElement('p');
p.textContent = 'Familiar is running. Chat arrives in a later step.';
document.body.append(p);
void shell.log('chat up');
